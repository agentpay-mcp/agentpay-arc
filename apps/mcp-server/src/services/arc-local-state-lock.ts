import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const MUTATION_LOCK_RETRY_MS = 20;
const MUTATION_LOCK_STALE_MS = 5_000;
const MUTATION_LOCK_TIMEOUT_MS = 15_000;
const mutationQueues = new Map<string, Promise<void>>();

export async function withArcLocalStateMutationLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  mutationQueues.set(filePath, current);
  await previous.catch(() => undefined);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireMutationFileLock(filePath);
    return await operation();
  } finally {
    await releaseFileLock?.();
    release();
    if (mutationQueues.get(filePath) === current) mutationQueues.delete(filePath);
  }
}

async function acquireMutationFileLock(
  filePath: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        }), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleMutationLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Arc local state mutation lock timed out.");
      }
      await new Promise((resolve) => setTimeout(resolve, MUTATION_LOCK_RETRY_MS));
    }
  }
}

async function removeStaleMutationLock(lockPath: string): Promise<void> {
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Arc local state mutation lock must be a regular file.");
  }
  if (Date.now() - info.mtimeMs < MUTATION_LOCK_STALE_MS) return;

  let ownerPid: number | undefined;
  try {
    const raw = await readFile(lockPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") <= 1_024) {
      const candidate = JSON.parse(raw) as { readonly pid?: unknown };
      if (
        typeof candidate.pid === "number"
        && Number.isSafeInteger(candidate.pid)
        && candidate.pid > 0
      ) {
        ownerPid = candidate.pid;
      }
    }
  } catch {
    ownerPid = undefined;
  }
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
