import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_KEYS = Object.freeze([
  "VITE_ARC_PUBLIC_ORIGIN",
  "VITE_ARC_API_ORIGIN",
  "VITE_ARC_SUPABASE_URL",
  "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
]);
const ARTIFACT_MANIFEST_FILE = "arc-artifact-manifest.json";

function generateManifest() {
  const manifest = {};
  for (const key of MANIFEST_KEYS) {
    const value = process.env[key]?.trim() ?? "";
    if (value.length === 0) {
      process.stderr.write(
        `${JSON.stringify({ event: "manifest_env_missing", key })}\n`,
      );
    }
    manifest[key] = value;
  }
  return manifest;
}

async function generateArtifactDigests(outDir) {
  const digests = {};
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile() || entry.name === ARTIFACT_MANIFEST_FILE) {
        continue;
      }
      const relativePath = relative(outDir, filePath).split(sep).join("/");
      const content = await readFile(filePath);
      digests[relativePath] = createHash("sha256").update(content).digest("hex");
    }
  }
  await visit(outDir);
  return digests;
}

async function generateArtifactManifest(outDir) {
  const manifest = generateManifest();
  if (outDir !== undefined) {
    manifest.artifactDigests = await generateArtifactDigests(resolve(outDir));
  }
  return manifest;
}

export { generateArtifactDigests, generateArtifactManifest };

function isMainModule() {
  return (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  const outDir = resolve(process.argv[2] ?? "dist");
  const manifest = await generateArtifactManifest(outDir);
  if (manifest) {
    const outPath = resolve(outDir, ARTIFACT_MANIFEST_FILE);
    await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        event: "arc_artifact_manifest_written",
        path: outPath,
        keys: Object.keys(manifest),
      })}\n`,
    );
  }
}
