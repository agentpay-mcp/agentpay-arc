export interface WithdrawalStatus {
  readonly status: string;
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly reconciliationRequired: boolean;
}

export interface PollWithdrawalOptions {
  readonly initial: WithdrawalStatus;
  readonly fetchStatus: () => Promise<WithdrawalStatus>;
  readonly sleep?: () => Promise<void>;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

const terminalStatuses = new Set(["COMPLETED", "FAILED"]);

export async function pollWithdrawalUntilTerminal(
  options: PollWithdrawalOptions,
): Promise<WithdrawalStatus> {
  const maxAttempts = options.maxAttempts ?? 20;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("maxAttempts must be between 1 and 100");
  }
  const sleep = options.sleep ?? (() => abortableDelay(1_500, options.signal));
  let current = { ...options.initial };
  if (terminalStatuses.has(current.status)) {
    return current;
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException("Withdrawal polling aborted", "AbortError");
    }
    if (attempt > 0) {
      await sleep();
    }
    current = { ...await options.fetchStatus() };
    if (terminalStatuses.has(current.status)) {
      return current;
    }
  }
  return {
    ...current,
    reconciliationRequired: true,
  };
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Withdrawal polling aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
