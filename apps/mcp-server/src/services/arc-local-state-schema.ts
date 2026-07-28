import {
  CIRCLE_ARC_CHAIN,
  arcAgentCommerceReceiptSchema,
  arcAgentJobIdSchema,
  arcAgentJobStateSchema,
  arcBatchStatusSchema,
  arcPaymentStatusSchema,
  arcUsdcAmountSchema,
  circleAddressSchema,
  uuidV4Schema,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

export const timestampSchema = z.string().datetime({ offset: true });
export const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const nonnegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);
const uintSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);

export const receiptSchema = z.object({
  id: uuidV4Schema,
  idempotencyKey: uuidV4Schema,
  paymentRequestId: uuidV4Schema.optional(),
  walletAddress: circleAddressSchema,
  recipient: circleAddressSchema,
  amount: arcUsdcAmountSchema,
  token: z.literal("USDC"),
  chain: z.literal(CIRCLE_ARC_CHAIN),
  purpose: z.string().min(1).max(512),
  status: arcPaymentStatusSchema,
  transactionId: z.string().min(1).max(256).optional(),
  transactionHash: transactionHashSchema.optional(),
  explorerUrl: z.string().url().optional(),
  errorMessage: z.string().min(1).max(512).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const batchItemSchema = z.object({
  id: z.string().min(1).max(128),
  batchId: uuidV4Schema,
  index: z.number().int().min(0).max(99),
  recipient: circleAddressSchema,
  amount: arcUsdcAmountSchema,
  purpose: z.string().min(1).max(512).optional(),
  status: arcPaymentStatusSchema,
  transactionId: z.string().min(1).max(256).optional(),
  transactionHash: transactionHashSchema.optional(),
  explorerUrl: z.string().url().optional(),
  errorMessage: z.string().min(1).max(512).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const batchSchema = z.object({
  batchId: uuidV4Schema,
  idempotencyKey: uuidV4Schema,
  walletAddress: circleAddressSchema,
  chain: z.literal(CIRCLE_ARC_CHAIN),
  token: z.literal("USDC"),
  status: arcBatchStatusSchema,
  items: z.array(batchItemSchema).min(1).max(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const paymentRequestSchema = z.object({
  id: uuidV4Schema,
  idempotencyKey: uuidV4Schema,
  recipient: circleAddressSchema,
  amount: arcUsdcAmountSchema,
  token: z.literal("USDC"),
  chain: z.literal(CIRCLE_ARC_CHAIN),
  purpose: z.string().min(1).max(512),
  status: z.enum(["OPEN", "PAID", "EXPIRED"]),
  expiresAt: timestampSchema,
  receiptId: uuidV4Schema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const activitySchema = z.object({
  id: z.string().min(1).max(256),
  type: z.enum(["PAYMENT", "BATCH_PAYOUT", "PAYMENT_REQUEST"]),
  status: z.string().min(1).max(64),
  referenceId: z.string().min(1).max(256),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
}).strict();

export const liquidityStatusSchema = z.enum([
  "SUBMITTING",
  "SUBMITTED",
  "SWAP_VERIFIED",
  "PAYING",
  "COMPLETED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
]);
const liquidityStepSchema = z.object({
  name: z.enum(["BRIDGE", "SWAP", "VERIFY_SWAP", "PAY"]),
  status: liquidityStatusSchema,
  transactionId: z.string().min(1).max(256).optional(),
  transactionHash: transactionHashSchema.optional(),
  burnTransactionHash: transactionHashSchema.optional(),
  forwardTransactionHash: transactionHashSchema.optional(),
  arcscanUrl: z.string().url().optional(),
  traceId: z.string().min(1).max(256).optional(),
  transferId: z.string().min(1).max(256).optional(),
  fees: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
  actualReceivedAtomic: uintSchema.optional(),
  blockNumber: uintSchema.optional(),
}).strict();
export const liquiditySchema = z.object({
  id: uuidV4Schema,
  kind: z.enum(["BRIDGE", "SWAP", "SWAP_AND_PAY"]),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: liquidityStatusSchema,
  walletAddress: circleAddressSchema,
  quoteExpiresAt: timestampSchema,
  steps: z.array(liquidityStepSchema).max(32),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  errorCode: z.enum([
    "EXECUTION_AMBIGUOUS",
    "PROOF_UNAVAILABLE",
    "RECEIVED_BELOW_MINIMUM",
  ]).optional(),
}).strict();

export const identityOutputSchema = z.object({
  status: z.enum(["CONFIRMED", "RECONCILIATION_REQUIRED"]),
  operation: z.enum([
    "REGISTER",
    "FEEDBACK",
    "VALIDATION_REQUEST",
    "VALIDATION_RESPONSE",
  ]),
  transactionId: z.string().min(1).max(256).optional(),
  transactionHash: transactionHashSchema.optional(),
  arcscanUrl: z.string().url().optional(),
  blockNumber: uintSchema.optional(),
  agentId: uintSchema.optional(),
  reconciliationRequired: z.boolean(),
  reconciliationMessage: z.string().min(1).max(512).optional(),
}).strict().superRefine((output, context) => {
  const invalidConfirmed =
    output.status === "CONFIRMED" && output.reconciliationRequired;
  const invalidReconciliation =
    output.status === "RECONCILIATION_REQUIRED"
    && !output.reconciliationRequired;
  if (invalidConfirmed || invalidReconciliation) {
    context.addIssue({
      code: "custom",
      message: "ERC-8004 reconciliation status is inconsistent",
    });
  }
});
export const identitySchema = z.object({
  key: z.string().min(1).max(512),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["CLAIMED", "COMPLETED"]),
  output: identityOutputSchema.optional(),
}).strict().superRefine((record, context) => {
  if (
    (record.status === "CLAIMED" && record.output)
    || (record.status === "COMPLETED" && !record.output)
  ) {
    context.addIssue({
      code: "custom",
      message: "ERC-8004 evidence status is inconsistent",
    });
  }
});

export const jobSchema = z.object({
  jobId: arcAgentJobIdSchema,
  description: z.string().min(1).max(2_048),
  hook: circleAddressSchema,
  client: circleAddressSchema,
  provider: circleAddressSchema,
  evaluator: circleAddressSchema,
  budget: nonnegativeDecimalSchema,
  expiredAt: uintSchema,
  state: arcAgentJobStateSchema,
  contract: circleAddressSchema,
  chainId: z.literal(5_042_002),
}).strict();
export const jobEventSchema = z.object({
  jobId: arcAgentJobIdSchema,
  action: z.enum(["CREATE", "SET_BUDGET", "FUND", "SUBMIT", "COMPLETE", "REJECT"]),
  fromState: arcAgentJobStateSchema.nullable(),
  toState: arcAgentJobStateSchema.nullable(),
  actor: circleAddressSchema,
  deliverableHash: transactionHashSchema.optional(),
  reasonHash: transactionHashSchema.optional(),
  circleTransactionId: z.string().min(1).max(256).optional(),
  transactionHash: transactionHashSchema.optional(),
  blockNumber: uintSchema.optional(),
  explorerUrl: z.string().url().optional(),
  status: z.enum(["SUBMITTED", "RECONCILIATION_REQUIRED"]),
}).strict();

export const complianceSchema = z.object({
  evidenceKey: z.string().min(1).max(256),
  operationId: uuidV4Schema,
  address: circleAddressSchema,
  direction: z.enum(["SEND", "RECEIVE"]),
  channel: z.enum(["AGENT_WALLET_TRANSFER", "AGENT_WALLET_PAID_SERVICE"]),
  evidenceType: z.enum([
    "CIRCLE_AGENT_WALLET_BUILT_IN",
    "CIRCLE_COMPLIANCE_ENGINE",
  ]),
  status: z.enum([
    "DECLARED_RUNTIME_CONTROL",
    "DISABLED",
    "SCREENED",
    "UNAVAILABLE",
    "UNSUPPORTED_CHAIN",
  ]),
  decision: z.enum(["APPROVED", "DENIED", "REVIEW", "UNAVAILABLE"]).optional(),
  referenceId: z.string().regex(/^[A-Za-z0-9_:.~-]{1,128}$/).optional(),
  createdAt: timestampSchema,
}).strict();

export const arcLocalStateSchema = z.object({
  version: z.literal(1),
  receipts: z.array(receiptSchema).max(10_000),
  batches: z.array(batchSchema).max(1_000),
  paymentRequests: z.array(paymentRequestSchema).max(10_000),
  activities: z.array(activitySchema).max(10_000),
  commerce: z.array(arcAgentCommerceReceiptSchema).max(10_000),
  liquidity: z.array(liquiditySchema).max(10_000),
  identity: z.array(identitySchema).max(10_000),
  jobs: z.array(jobSchema).max(10_000),
  jobEvents: z.array(jobEventSchema).max(20_000),
  compliance: z.array(complianceSchema).max(20_000),
}).strict();

export type ArcLocalState = z.output<typeof arcLocalStateSchema>;

export function createEmptyArcLocalState(): ArcLocalState {
  return {
    version: 1,
    receipts: [],
    batches: [],
    paymentRequests: [],
    activities: [],
    commerce: [],
    liquidity: [],
    identity: [],
    jobs: [],
    jobEvents: [],
    compliance: [],
  };
}

export function parseArcLocalState(value: unknown): ArcLocalState {
  const state = arcLocalStateSchema.parse(value);
  assertStateUniqueness(state);
  assertSafeStoredValue(state);
  return state;
}

export function normalizeArcLocalState(state: ArcLocalState): ArcLocalState {
  try {
    return parseArcLocalState(JSON.parse(JSON.stringify(state)));
  } catch {
    throw new Error("Arc local state contains invalid or sensitive data.");
  }
}

function assertSafeStoredValue(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Sensitive data nesting is too deep.");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 65_536) {
      throw new Error("Sensitive data value is too large.");
    }
    if (CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) {
      throw new Error("Sensitive credential values cannot be persisted.");
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeStoredValue(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_STORED_KEYS.has(normalized)) {
        throw new Error("Sensitive or raw CLI data cannot be persisted.");
      }
      assertSafeStoredValue(entry, depth + 1);
    }
  }
}

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:authorization|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|password|mnemonic|seed[_-]?phrase)\s*[:=]\s*\S+/i;

const FORBIDDEN_STORED_KEYS = new Set([
  "privatekey",
  "seedphrase",
  "mnemonic",
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "stdout",
  "stderr",
  "rawclioutput",
  "clirawoutput",
]);

function assertStateUniqueness(state: ArcLocalState): void {
  assertUnique(state.receipts, ({ id }) => id);
  assertUnique(state.receipts, ({ idempotencyKey }) => idempotencyKey);
  assertUnique(state.batches, ({ batchId }) => batchId);
  assertUnique(state.batches, ({ idempotencyKey }) => idempotencyKey);
  assertUnique(state.paymentRequests, ({ id }) => id);
  assertUnique(state.paymentRequests, ({ idempotencyKey }) => idempotencyKey);
  assertUnique(state.activities, ({ id }) => id);
  assertUnique(state.commerce, ({ idempotencyKey }) => idempotencyKey);
  assertUnique(state.liquidity, ({ id }) => id);
  assertUnique(state.identity, ({ key }) => key);
  assertUnique(state.jobs, ({ jobId }) => jobId);
  assertUnique(state.compliance, ({ evidenceKey }) => evidenceKey);
  for (const batch of state.batches) {
    assertUnique(batch.items, ({ id }) => id);
    assertUnique(batch.items, ({ index }) => String(index));
  }
}

function assertUnique<T>(values: readonly T[], keyOf: (value: T) => string): void {
  if (new Set(values.map(keyOf)).size !== values.length) {
    throw new Error("Arc local state contains duplicate records.");
  }
}
