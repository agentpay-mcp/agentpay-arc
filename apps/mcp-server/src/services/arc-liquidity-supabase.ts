import { circleAddressSchema, uuidV4Schema } from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type {
  ArcLiquidityOperation,
  ArcLiquidityOperationStatus,
  ArcLiquidityRepository,
} from "../tools/arc-liquidity.ts";

interface SupabaseError {
  readonly message: string;
}

export interface ArcLiquiditySupabaseResult {
  readonly data: unknown;
  readonly error: SupabaseError | null;
}

export interface ArcLiquiditySupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<ArcLiquiditySupabaseResult>;
}

const tenantIdSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const statusSchema = z.enum([
  "SUBMITTING",
  "SUBMITTED",
  "SWAP_VERIFIED",
  "PAYING",
  "COMPLETED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
]);
const stepSchema = z
  .object({
    name: z.enum(["BRIDGE", "SWAP", "VERIFY_SWAP", "PAY"]),
    status: statusSchema,
    transactionId: z.string().min(1).max(256).optional(),
    transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    burnTransactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    forwardTransactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    arcscanUrl: z.string().url().startsWith("https://testnet.arcscan.app/tx/").optional(),
    traceId: z.string().min(1).max(256).optional(),
    transferId: z.string().min(1).max(256).optional(),
    fees: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
    actualReceivedAtomic: z.string().regex(/^\d+$/).optional(),
    blockNumber: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
const rowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    id: uuidV4Schema,
    kind: z.enum(["BRIDGE", "SWAP", "SWAP_AND_PAY"]),
    input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: statusSchema,
    wallet_address: circleAddressSchema,
    quote_expires_at: timestampSchema,
    steps: z.array(stepSchema).max(32),
    error_code: z
      .enum(["EXECUTION_AMBIGUOUS", "PROOF_UNAVAILABLE", "RECEIVED_BELOW_MINIMUM"])
      .nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();
const claimSchema = z
  .object({
    claimed: z.boolean(),
    operation: rowSchema,
  })
  .strict();

export function createTenantArcLiquidityRepository(
  client: ArcLiquiditySupabaseClient,
  trustedTenantId: string,
): ArcLiquidityRepository {
  const tenantId = tenantIdSchema.parse(trustedTenantId);
  return {
    async get(idempotencyKey) {
      const id = uuidV4Schema.parse(idempotencyKey);
      const result = await client.rpc("get_arc_liquidity_operation", {
        p_tenant_id: tenantId,
        p_operation_id: id,
      });
      if (result.error) throw new Error("Arc liquidity operation read failed.");
      if (result.data === null) return null;
      return mapRow(result.data, tenantId);
    },
    async claim(operation) {
      const result = await client.rpc("claim_arc_liquidity_operation", {
        p_tenant_id: tenantId,
        p_operation: serialize(operation),
      });
      if (result.error) throw new Error("Arc liquidity atomic claim failed.");
      const parsed = claimSchema.safeParse(result.data);
      if (!parsed.success) throw new Error("Arc liquidity atomic claim returned invalid data.");
      const persisted = mapParsedRow(parsed.data.operation);
      assertClaimMatch(persisted, operation);
      if (
        parsed.data.claimed
        && (persisted.status !== "SUBMITTING" || persisted.steps.length !== 0)
      ) {
        throw new Error("Arc liquidity atomic claim returned conflicting data.");
      }
      return { claimed: parsed.data.claimed, operation: persisted };
    },
    async transition(operation, expectedStatuses) {
      const expected = z.array(statusSchema).min(1).parse(expectedStatuses);
      const result = await client.rpc("transition_arc_liquidity_operation", {
        p_tenant_id: tenantId,
        p_operation: serialize(operation),
        p_expected_statuses: expected,
      });
      if (result.error) throw new Error("Arc liquidity operation transition failed.");
      const persisted = mapRow(result.data, tenantId);
      assertImmutableMatch(persisted, operation);
      if (persisted.status !== operation.status) {
        throw new Error("Arc liquidity operation transition returned conflicting data.");
      }
      return persisted;
    },
  };
}

function serialize(operation: ArcLiquidityOperation): Record<string, unknown> {
  return {
    id: operation.id,
    kind: operation.kind,
    inputFingerprint: operation.inputFingerprint,
    status: operation.status,
    walletAddress: operation.walletAddress,
    quoteExpiresAt: operation.quoteExpiresAt,
    steps: operation.steps.map((step) => ({
      ...step,
      ...(step.fees ? { fees: step.fees.map((fee) => ({ ...fee })) } : {}),
    })),
    errorCode: operation.errorCode ?? null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function mapRow(raw: unknown, tenantId: string): ArcLiquidityOperation {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.tenant_id !== tenantId) {
    throw new Error("Arc liquidity repository returned invalid tenant data.");
  }
  return mapParsedRow(parsed.data);
}

function mapParsedRow(row: z.output<typeof rowSchema>): ArcLiquidityOperation {
  return {
    id: row.id,
    kind: row.kind,
    inputFingerprint: row.input_fingerprint,
    status: row.status,
    walletAddress: row.wallet_address,
    quoteExpiresAt: row.quote_expires_at,
    steps: row.steps.map((step) => ({
      ...step,
      ...(step.fees ? { fees: step.fees.map((fee) => ({ ...fee })) } : {}),
    })),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertImmutableMatch(
  actual: ArcLiquidityOperation,
  expected: ArcLiquidityOperation,
): void {
  if (
    actual.id !== expected.id
    || actual.kind !== expected.kind
    || actual.inputFingerprint !== expected.inputFingerprint
    || actual.walletAddress.toLowerCase() !== expected.walletAddress.toLowerCase()
    || actual.quoteExpiresAt !== expected.quoteExpiresAt
    || actual.createdAt !== expected.createdAt
  ) {
    throw new Error("Arc liquidity atomic claim returned conflicting data.");
  }
}

function assertClaimMatch(
  actual: ArcLiquidityOperation,
  expected: ArcLiquidityOperation,
): void {
  if (
    actual.id !== expected.id
    || actual.kind !== expected.kind
    || actual.inputFingerprint !== expected.inputFingerprint
    || actual.walletAddress.toLowerCase() !== expected.walletAddress.toLowerCase()
  ) {
    throw new Error("Arc liquidity atomic claim returned conflicting data.");
  }
}

export type { ArcLiquidityOperationStatus };
