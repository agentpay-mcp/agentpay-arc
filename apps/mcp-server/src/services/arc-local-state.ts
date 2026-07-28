import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  arcAgentCommerceReceiptSchema,
  arcPaymentStatusSchema,
  assertArcAgentJobTransition,
  uuidV4Schema,
  type ArcAgentCommerceReceipt,
  type ArcPaymentBatchItemRecord,
  type ArcPaymentBatchRecord,
  type ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import {
  activitySchema,
  batchItemSchema,
  batchSchema,
  complianceSchema,
  createEmptyArcLocalState,
  identityOutputSchema,
  identitySchema,
  jobEventSchema,
  jobSchema,
  liquiditySchema,
  liquidityStatusSchema,
  normalizeArcLocalState,
  parseArcLocalState,
  paymentRequestSchema,
  receiptSchema,
  type ArcLocalState,
} from "./arc-local-state-schema.ts";
import { withArcLocalStateMutationLock } from "./arc-local-state-lock.ts";
import type { ComplianceEvidenceRepository } from "./circle-compliance.ts";
import type { ArcErc8004EvidenceRepository } from "../tools/arc-agent-identity.ts";
import type {
  ArcAgentJobRecord,
  ArcAgentJobRepository,
} from "../tools/arc-agent-jobs.ts";
import type {
  ArcLiquidityOperation,
  ArcLiquidityRepository,
} from "../tools/arc-liquidity-state.ts";
import type { ArcPaymentRepository } from "../tools/arc-payments.ts";
import type { ArcAgentCommerceRepository } from "../tools/circle-services.ts";
import type {
  ArcPaymentRequestRecord,
  ArcPaymentRequestRepository,
} from "../tools/invoice.ts";
import type {
  ArcAgentActivityRepository,
  ArcPaymentReceiptRepository,
} from "../tools/payment-tracking.ts";

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface ArcLocalStateRepositories {
  readonly payments: ArcPaymentRepository;
  readonly paymentRequests: ArcPaymentRequestRepository;
  readonly activity: ArcAgentActivityRepository;
  readonly receipts: ArcPaymentReceiptRepository;
  readonly commerce: ArcAgentCommerceRepository;
  readonly liquidity: ArcLiquidityRepository;
  readonly identity: ArcErc8004EvidenceRepository;
  readonly jobs: ArcAgentJobRepository;
  readonly compliance: ComplianceEvidenceRepository;
}

export interface ArcLocalStateOptions {
  /** Explicit authority boundary. Callers cannot supply a tenant or namespace. */
  readonly filePath: string;
  readonly maxFileBytes?: number;
}

export function createArcLocalStateRepositories(
  options: ArcLocalStateOptions,
): ArcLocalStateRepositories {
  const filePath = resolve(z.string().min(1).parse(options.filePath));
  const maxFileBytes = parseMaxFileBytes(options.maxFileBytes);
  const read = () => loadState(filePath, maxFileBytes);
  const mutate = <T>(operation: (state: ArcLocalState) => T | Promise<T>) =>
    withArcLocalStateMutationLock(filePath, async () => {
      const state = await read();
      const result = await operation(state);
      await writeState(filePath, state, maxFileBytes);
      return deepClone(result);
    });

  const payments: ArcPaymentRepository = {
    async getReceiptByIdempotencyKey(key) {
      uuidV4Schema.parse(key);
      return cloneNullable((await read()).receipts.find(
        ({ idempotencyKey }) => idempotencyKey === key,
      ));
    },
    async claimReceipt(rawReceipt) {
      const receipt = receiptSchema.parse(rawReceipt);
      if (
        receipt.status !== "SUBMITTING"
        || receipt.transactionId
        || receipt.transactionHash
      ) {
        throw new Error("Arc local payment claim must be an unsubmitted receipt.");
      }
      return mutate((state) => {
        const existing = state.receipts.find((candidate) =>
          candidate.id === receipt.id
          || candidate.idempotencyKey === receipt.idempotencyKey
        );
        if (existing) {
          assertReceiptIdentity(existing, receipt);
          return { claimed: false, receipt: existing };
        }
        state.receipts.push(receipt);
        state.activities.push(paymentClaimedActivity(receipt));
        return { claimed: true, receipt };
      });
    },
    async transitionReceipt(rawReceipt, expectedStatus) {
      const receipt = receiptSchema.parse(rawReceipt);
      arcPaymentStatusSchema.parse(expectedStatus);
      return mutate((state) => {
        const index = state.receipts.findIndex(({ id }) => id === receipt.id);
        const existing = state.receipts[index];
        if (!existing || existing.status !== expectedStatus) {
          throw new Error("Arc local payment receipt transition conflict.");
        }
        assertReceiptIdentity(existing, receipt);
        assertReceiptTransition(expectedStatus, receipt.status);
        state.receipts[index] = receipt;
        state.activities.push(paymentTransitionActivity(
          receipt,
          expectedStatus,
        ));
        return receipt;
      });
    },
    async appendActivity(rawActivity) {
      const activity = activitySchema.parse(rawActivity);
      await mutate((state) => {
        const existing = state.activities.find(({ id }) => id === activity.id);
        if (existing && !same(existing, activity)) {
          throw new Error("Arc local activity id conflict.");
        }
        if (!existing) state.activities.push(activity);
      });
    },
    async getBatch(batchId) {
      uuidV4Schema.parse(batchId);
      return cloneNullable((await read()).batches.find(
        (batch) => batch.batchId === batchId,
      ));
    },
    async getBatchByIdempotencyKey(key) {
      uuidV4Schema.parse(key);
      return cloneNullable((await read()).batches.find(
        (batch) => batch.idempotencyKey === key,
      ));
    },
    async createBatch(rawBatch) {
      const batch = batchSchema.parse(rawBatch);
      if (
        batch.status !== "PENDING"
        || batch.items.some((item) => item.status !== "PENDING")
      ) {
        throw new Error("Arc local batch must start pending.");
      }
      return mutate((state) => {
        const existing = state.batches.find((candidate) =>
          candidate.batchId === batch.batchId
          || candidate.idempotencyKey === batch.idempotencyKey
        );
        if (existing) {
          assertBatchIdentity(existing, batch);
          return existing;
        }
        state.batches.push(batch);
        return batch;
      });
    },
    async claimBatchItem(rawItem) {
      const item = batchItemSchema.parse(rawItem);
      if (item.status !== "SUBMITTED" || item.transactionId || item.transactionHash) {
        throw new Error("Arc local batch claim must be unsubmitted.");
      }
      return mutate((state) => {
        const batch = requireBatch(state, item.batchId);
        const index = batch.items.findIndex(({ id }) => id === item.id);
        const existing = batch.items[index];
        if (!existing || existing.status !== "PENDING") return null;
        assertBatchItemIdentity(existing, item);
        batch.items[index] = item;
        return item;
      });
    },
    async saveBatchItem(rawItem) {
      const item = batchItemSchema.parse(rawItem);
      return mutate((state) => {
        const batch = requireBatch(state, item.batchId);
        const index = batch.items.findIndex(({ id }) => id === item.id);
        const existing = batch.items[index];
        if (!existing) throw new Error("Arc local batch item was not found.");
        assertBatchItemIdentity(existing, item);
        if (
          existing.status !== "SUBMITTED"
          || !["SUBMITTED", "COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"]
            .includes(item.status)
        ) {
          throw new Error("Arc local batch item transition conflict.");
        }
        batch.items[index] = item;
        return item;
      });
    },
    async saveBatch(rawBatch) {
      const batch = batchSchema.parse(rawBatch);
      return mutate((state) => {
        const index = state.batches.findIndex(
          ({ batchId }) => batchId === batch.batchId,
        );
        const existing = state.batches[index];
        if (!existing) throw new Error("Arc local batch was not found.");
        assertBatchIdentity(existing, batch);
        if (!same(existing.items, batch.items)) {
          throw new Error("Arc local batch item snapshot conflict.");
        }
        if (isTerminalBatch(existing.status) && existing.status !== batch.status) {
          throw new Error("Arc local batch transition conflict.");
        }
        state.batches[index] = batch;
        return batch;
      });
    },
  };

  const paymentRequests: ArcPaymentRequestRepository = {
    async getById(id) {
      uuidV4Schema.parse(id);
      return cloneNullable((await read()).paymentRequests.find(
        (request) => request.id === id,
      ));
    },
    async getByIdempotencyKey(key) {
      uuidV4Schema.parse(key);
      return cloneNullable((await read()).paymentRequests.find(
        (request) => request.idempotencyKey === key,
      ));
    },
    async save(rawRequest) {
      const request = paymentRequestSchema.parse(rawRequest);
      return mutate((state) => {
        const index = state.paymentRequests.findIndex((candidate) =>
          candidate.id === request.id
          || candidate.idempotencyKey === request.idempotencyKey
        );
        const existing = state.paymentRequests[index];
        if (!existing) {
          if (request.status !== "OPEN") {
            throw new Error("Arc local payment request must start open.");
          }
          state.paymentRequests.push(request);
          return request;
        }
        assertPaymentRequestIdentity(existing, request);
        if (
          existing.status === request.status
          && existing.receiptId !== request.receiptId
        ) {
          throw new Error("Arc local payment request transition conflict.");
        }
        if (
          existing.status !== request.status
          && (existing.status !== "OPEN"
            || !["PAID", "EXPIRED"].includes(request.status))
        ) {
          throw new Error("Arc local payment request transition conflict.");
        }
        if (request.status === "PAID" && !request.receiptId) {
          throw new Error("Arc local paid request requires a receipt.");
        }
        if (request.status === "EXPIRED" && request.receiptId) {
          throw new Error("Arc local expired request cannot bind a receipt.");
        }
        state.paymentRequests[index] = request;
        return request;
      });
    },
  };

  const commerce: ArcAgentCommerceRepository = {
    async getByIdempotencyKey(key) {
      uuidV4Schema.parse(key);
      return cloneNullable((await read()).commerce.find(
        (receipt) => receipt.idempotencyKey === key,
      ));
    },
    async claim(rawReceipt) {
      const receipt = arcAgentCommerceReceiptSchema.parse(rawReceipt);
      if (receipt.status !== "CLAIMED" || receipt.proof || receipt.settlementResult) {
        throw new Error("Arc local commerce claim must be unsettled.");
      }
      return mutate((state) => {
        const existing = state.commerce.find(
          ({ idempotencyKey }) => idempotencyKey === receipt.idempotencyKey,
        );
        if (existing) {
          assertCommerceIdentity(existing, receipt);
          return { claimed: false, receipt: existing };
        }
        state.commerce.push(receipt);
        return { claimed: true, receipt };
      });
    },
    async complete(rawReceipt, expectedStatus) {
      const receipt = arcAgentCommerceReceiptSchema.parse(rawReceipt);
      if (expectedStatus !== "CLAIMED" || receipt.status === "CLAIMED") {
        throw new Error("Arc local commerce completion transition is invalid.");
      }
      return mutate((state) => {
        const index = state.commerce.findIndex(
          ({ idempotencyKey }) => idempotencyKey === receipt.idempotencyKey,
        );
        const existing = state.commerce[index];
        if (!existing || existing.status !== expectedStatus) {
          throw new Error("Arc local commerce completion conflict.");
        }
        assertCommerceIdentity(existing, receipt);
        state.commerce[index] = receipt;
        return receipt;
      });
    },
  };

  const liquidity: ArcLiquidityRepository = {
    async get(id) {
      uuidV4Schema.parse(id);
      return cloneNullable((await read()).liquidity.find(
        (operation) => operation.id === id,
      ));
    },
    async claim(rawOperation) {
      const operation = liquiditySchema.parse(rawOperation);
      if (operation.status !== "SUBMITTING" || operation.steps.length !== 0) {
        throw new Error("Arc local liquidity claim must start submitting.");
      }
      return mutate((state) => {
        const existing = state.liquidity.find(({ id }) => id === operation.id);
        if (existing) {
          assertLiquidityIdentity(existing, operation);
          return { claimed: false, operation: existing };
        }
        state.liquidity.push(operation);
        return { claimed: true, operation };
      });
    },
    async transition(rawOperation, expectedStatuses) {
      const operation = liquiditySchema.parse(rawOperation);
      const expected = z.array(liquidityStatusSchema).min(1).parse(expectedStatuses);
      return mutate((state) => {
        const index = state.liquidity.findIndex(({ id }) => id === operation.id);
        const existing = state.liquidity[index];
        if (!existing || !expected.includes(existing.status)) {
          throw new Error("Arc local liquidity transition conflict.");
        }
        assertLiquidityIdentity(existing, operation);
        state.liquidity[index] = operation;
        return operation;
      });
    },
  };

  const identity: ArcErc8004EvidenceRepository = {
    async claim(rawRecord) {
      const record = identitySchema.parse(rawRecord);
      if (record.status !== "CLAIMED" || record.output) {
        throw new Error("Arc local ERC-8004 claim is invalid.");
      }
      return mutate((state) => {
        const existing = state.identity.find(({ key }) => key === record.key);
        if (existing) {
          if (existing.fingerprint !== record.fingerprint) {
            throw new Error("Arc local ERC-8004 replay conflict.");
          }
          return { claimed: false, record: existing };
        }
        state.identity.push(record);
        return { claimed: true, record };
      });
    },
    async complete(key, fingerprint, rawOutput) {
      const output = identityOutputSchema.parse(rawOutput);
      z.string().min(1).max(512).parse(key);
      z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint);
      return mutate((state) => {
        const index = state.identity.findIndex((record) => record.key === key);
        const existing = state.identity[index];
        if (!existing || existing.fingerprint !== fingerprint) {
          throw new Error("Arc local ERC-8004 completion conflict.");
        }
        if (existing.status === "COMPLETED") {
          if (!same(existing.output, output)) {
            throw new Error("Arc local ERC-8004 completion conflict.");
          }
          return existing;
        }
        const completed = {
          key,
          fingerprint,
          status: "COMPLETED" as const,
          output,
        };
        state.identity[index] = completed;
        return completed;
      });
    },
  };

  const jobs: ArcAgentJobRepository = {
    async saveJob(rawRecord) {
      const record = jobSchema.parse(rawRecord);
      await mutate((state) => {
        const index = state.jobs.findIndex(({ jobId }) => jobId === record.jobId);
        const existing = state.jobs[index];
        if (!existing) {
          state.jobs.push(record);
          return;
        }
        assertJobIdentity(existing, record);
        if (existing.state === record.state) {
          if (existing.budget !== record.budget && existing.state !== "Open") {
            throw new Error("Arc local job budget transition conflict.");
          }
        } else {
          assertArcAgentJobTransition(existing.state, record.state);
          if (existing.budget !== record.budget) {
            throw new Error("Arc local job transition changed its budget.");
          }
        }
        state.jobs[index] = record;
      });
    },
    async appendEvent(rawEvent) {
      const event = jobEventSchema.parse(rawEvent);
      await mutate((state) => {
        if (!state.jobs.some(({ jobId }) => jobId === event.jobId)) {
          throw new Error("Arc local job event references an unknown job.");
        }
        if (!state.jobEvents.some((existing) => same(existing, event))) {
          state.jobEvents.push(event);
        }
      });
    },
  };

  const compliance: ComplianceEvidenceRepository = {
    async list(operationId) {
      const id = uuidV4Schema.parse(operationId);
      return deepClone((await read()).compliance.filter(
        (evidence) => evidence.operationId === id,
      ));
    },
    async record(rawEvidence) {
      const evidence = complianceSchema.parse(rawEvidence);
      return mutate((state) => {
        const existing = state.compliance.find(
          ({ evidenceKey }) => evidenceKey === evidence.evidenceKey,
        );
        if (existing) {
          if (!same(existing, evidence)) {
            throw new Error("Arc local compliance evidence conflict.");
          }
          return existing;
        }
        state.compliance.push(evidence);
        return evidence;
      });
    },
  };

  return {
    payments,
    paymentRequests,
    activity: {
      async listAgentActivity({ limit }) {
        const parsedLimit = z.number().int().min(1).max(100).parse(limit);
        return deepClone(
          [...(await read()).activities]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(0, parsedLimit),
        );
      },
    },
    receipts: {
      async getPaymentReceipt(receiptId) {
        uuidV4Schema.parse(receiptId);
        return cloneNullable((await read()).receipts.find(
          ({ id }) => id === receiptId,
        ));
      },
    },
    commerce,
    liquidity,
    identity,
    jobs,
    compliance,
  };
}

function parseMaxFileBytes(value: number | undefined): number {
  const parsed = value ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Arc local state maxFileBytes must be a positive safe integer.");
  }
  return parsed;
}

async function loadState(
  filePath: string,
  maxFileBytes: number,
): Promise<ArcLocalState> {
  const info = await safeTargetInfo(filePath);
  if (!info) return createEmptyArcLocalState();
  if (info.size > maxFileBytes) {
    throw new Error("Arc local state file exceeds the configured size limit.");
  }
  try {
    const contents = await readFile(filePath);
    if (contents.byteLength > maxFileBytes) {
      throw new Error("Arc local state file exceeds the configured size limit.");
    }
    return parseArcLocalState(JSON.parse(contents.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && /size limit/.test(error.message)) throw error;
    throw new Error("Arc local state file is invalid.");
  }
}

async function writeState(
  filePath: string,
  state: ArcLocalState,
  maxFileBytes: number,
): Promise<void> {
  await safeTargetInfo(filePath);
  const normalized = normalizeArcLocalState(state);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > maxFileBytes) {
    throw new Error("Arc local state file exceeds the configured size limit.");
  }
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await safeTargetInfo(filePath);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function safeTargetInfo(filePath: string) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      throw new Error("Arc local state target must not be a symbolic link.");
    }
    if (!info.isFile()) {
      throw new Error("Arc local state target must be a regular file.");
    }
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertReceiptIdentity(
  actual: ArcPaymentReceiptRecord,
  expected: ArcPaymentReceiptRecord,
): void {
  if (!sameFields(actual, expected, [
    "id", "idempotencyKey", "paymentRequestId", "walletAddress", "recipient",
    "amount", "token", "chain", "purpose", "createdAt",
  ])) throw new Error("Arc local payment receipt idempotency conflict.");
}

function assertReceiptTransition(from: string, to: string): void {
  const allowed: Record<string, readonly string[]> = {
    SUBMITTING: ["SUBMITTED", "FAILED", "RECONCILIATION_REQUIRED"],
    SUBMITTED: ["COMPLETED", "RECONCILIATION_REQUIRED"],
  };
  if (!allowed[from]?.includes(to)) {
    throw new Error("Arc local payment receipt transition conflict.");
  }
}

function paymentClaimedActivity(
  receipt: ArcPaymentReceiptRecord,
): z.output<typeof activitySchema> {
  return activitySchema.parse({
    id: `payment_claimed:${receipt.id}`,
    type: "PAYMENT",
    status: "SUBMITTING",
    referenceId: receipt.id,
    metadata: {
      event: "PAYMENT_CLAIMED",
      walletAddress: receipt.walletAddress,
      recipient: receipt.recipient,
      amount: receipt.amount,
      paymentRequestId: receipt.paymentRequestId ?? null,
    },
    createdAt: receipt.createdAt,
  });
}

function paymentTransitionActivity(
  receipt: ArcPaymentReceiptRecord,
  previousStatus: ArcPaymentReceiptRecord["status"],
): z.output<typeof activitySchema> {
  return activitySchema.parse({
    id: [
      "payment_transition",
      receipt.id,
      receipt.status.toLowerCase(),
      new Date(receipt.updatedAt).getTime(),
    ].join(":"),
    type: "PAYMENT",
    status: receipt.status,
    referenceId: receipt.id,
    metadata: {
      event: "PAYMENT_TRANSITIONED",
      previousStatus,
      transactionId: receipt.transactionId ?? null,
      transactionHash: receipt.transactionHash ?? null,
      errorMessage: receipt.errorMessage ?? null,
    },
    createdAt: receipt.updatedAt,
  });
}

function assertBatchIdentity(
  actual: ArcPaymentBatchRecord,
  expected: ArcPaymentBatchRecord,
): void {
  if (!sameFields(actual, expected, [
    "batchId", "idempotencyKey", "walletAddress", "chain", "token", "createdAt",
  ])) throw new Error("Arc local batch idempotency conflict.");
  if (
    actual.items.length !== expected.items.length
    || actual.items.some((item, index) => {
      const expectedItem = expected.items[index];
      try {
        if (!expectedItem) return true;
        assertBatchItemIdentity(item, expectedItem);
        return false;
      } catch {
        return true;
      }
    })
  ) throw new Error("Arc local batch idempotency conflict.");
}

function assertBatchItemIdentity(
  actual: ArcPaymentBatchItemRecord,
  expected: ArcPaymentBatchItemRecord,
): void {
  if (!sameFields(actual, expected, [
    "id", "batchId", "index", "recipient", "amount", "purpose", "createdAt",
  ])) throw new Error("Arc local batch item conflict.");
}

function assertPaymentRequestIdentity(
  actual: ArcPaymentRequestRecord,
  expected: ArcPaymentRequestRecord,
): void {
  if (!sameFields(actual, expected, [
    "id", "idempotencyKey", "recipient", "amount", "token", "chain", "purpose",
    "expiresAt", "createdAt",
  ])) throw new Error("Arc local payment request idempotency conflict.");
}

function assertCommerceIdentity(
  actual: ArcAgentCommerceReceipt,
  expected: ArcAgentCommerceReceipt,
): void {
  if (!sameFields(actual, expected, [
    "idempotencyKey", "buyerAgentId", "sellerAgentId", "serviceUrl",
    "requestHash", "quoteHash", "inspectedAmountAtomic", "maxAmount",
    "walletAddress", "paymentIdentifier", "createdAt",
  ])) throw new Error("Arc local commerce idempotency conflict.");
}

function assertLiquidityIdentity(
  actual: ArcLiquidityOperation,
  expected: ArcLiquidityOperation,
): void {
  if (!sameFields(actual, expected, [
    "id", "kind", "inputFingerprint", "walletAddress", "createdAt",
  ])) throw new Error("Arc local liquidity idempotency conflict.");
}

function assertJobIdentity(actual: ArcAgentJobRecord, expected: ArcAgentJobRecord): void {
  if (!sameFields(actual, expected, [
    "jobId", "description", "hook", "client", "provider", "evaluator",
    "expiredAt", "contract", "chainId",
  ])) throw new Error("Arc local job idempotency conflict.");
}

function requireBatch(state: ArcLocalState, batchId: string) {
  const batch = state.batches.find((candidate) => candidate.batchId === batchId);
  if (!batch) throw new Error("Arc local batch was not found.");
  return batch;
}

function isTerminalBatch(status: string): boolean {
  return ["COMPLETED", "FAILED"].includes(status);
}

function sameFields<T extends object>(
  actual: T,
  expected: T,
  fields: readonly (keyof T)[],
): boolean {
  return fields.every((field) => {
    const left = actual[field];
    const right = expected[field];
    return typeof left === "string" && typeof right === "string"
      && /^0x[a-fA-F0-9]{40}$/.test(left)
      && /^0x[a-fA-F0-9]{40}$/.test(right)
      ? left.toLowerCase() === right.toLowerCase()
      : same(left, right);
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function cloneNullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : deepClone(value);
}
