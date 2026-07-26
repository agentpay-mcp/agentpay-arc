import {
  CIRCLE_ARC_CHAIN,
  arcBatchStatusSchema,
  arcPaymentStatusSchema,
  arcUsdcAmountSchema,
  circleAddressSchema,
  uuidV4Schema,
  type ArcAgentActivityRecord,
  type ArcPaymentBatchItemRecord,
  type ArcPaymentBatchRecord,
  type ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { ArcPaymentRepository } from "../tools/arc-payments.ts";
import type {
  ArcPaymentRequestRecord,
  ArcPaymentRequestRepository,
} from "../tools/invoice.ts";
import type {
  ArcAgentActivityRepository,
  ArcPaymentReceiptRepository,
} from "../tools/payment-tracking.ts";

interface SupabaseError {
  readonly message: string;
}

export interface SupabaseSingleResult {
  readonly data: unknown;
  readonly error: SupabaseError | null;
}

export interface SupabaseListResult {
  readonly data: unknown[] | null;
  readonly error: SupabaseError | null;
}

export interface SupabaseWriteResult {
  readonly data?: unknown;
  readonly error: SupabaseError | null;
}

export interface ArcPaymentSupabaseQuery
  extends PromiseLike<SupabaseListResult> {
  select(columns?: string): ArcPaymentSupabaseQuery;
  eq(column: string, value: unknown): ArcPaymentSupabaseQuery;
  order(
    column: string,
    options: { readonly ascending: boolean },
  ): ArcPaymentSupabaseQuery;
  limit(count: number): ArcPaymentSupabaseQuery;
  maybeSingle(): Promise<SupabaseSingleResult>;
  insert(
    row: Record<string, unknown>,
  ): PromiseLike<SupabaseWriteResult>;
  upsert(
    row: Record<string, unknown>,
    options?: { readonly onConflict?: string },
  ): PromiseLike<SupabaseWriteResult>;
}

export interface ArcPaymentSupabaseClient {
  from(table: string): ArcPaymentSupabaseQuery;
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseSingleResult>;
}

export interface TenantArcPaymentRepositories {
  readonly payments: ArcPaymentRepository;
  readonly paymentRequests: ArcPaymentRequestRepository;
  readonly activity: ArcAgentActivityRepository;
  readonly receipts: ArcPaymentReceiptRepository;
}

const tenantIdSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const optionalTextSchema = z.string().nullable();
const transactionHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .nullable();

const receiptRowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    id: uuidV4Schema,
    idempotency_key: uuidV4Schema,
    payment_request_id: uuidV4Schema.nullable(),
    wallet_address: circleAddressSchema,
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    token: z.literal("USDC"),
    chain: z.literal(CIRCLE_ARC_CHAIN),
    purpose: z.string(),
    status: arcPaymentStatusSchema,
    transaction_id: optionalTextSchema,
    transaction_hash: transactionHashSchema,
    error_message: optionalTextSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

const batchRowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    batch_id: uuidV4Schema,
    idempotency_key: uuidV4Schema,
    wallet_address: circleAddressSchema,
    token: z.literal("USDC"),
    chain: z.literal(CIRCLE_ARC_CHAIN),
    status: arcBatchStatusSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

const batchItemRowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    id: z.string().min(1),
    batch_id: uuidV4Schema,
    item_index: z.number().int().nonnegative(),
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    purpose: optionalTextSchema,
    status: arcPaymentStatusSchema,
    transaction_id: optionalTextSchema,
    transaction_hash: transactionHashSchema,
    error_message: optionalTextSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

const paymentRequestRowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    id: uuidV4Schema,
    idempotency_key: uuidV4Schema,
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    token: z.literal("USDC"),
    chain: z.literal(CIRCLE_ARC_CHAIN),
    purpose: z.string(),
    status: z.enum(["OPEN", "PAID", "EXPIRED"]),
    expires_at: timestampSchema,
    receipt_id: uuidV4Schema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

const activityRowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    id: z.string().min(1),
    activity_type: z.enum(["PAYMENT", "BATCH_PAYOUT", "PAYMENT_REQUEST"]),
    status: z.string().min(1),
    reference_id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
    created_at: timestampSchema,
  })
  .strict();

const atomicBatchResultSchema = z
  .object({
    disposition: z.enum(["CREATED", "REPLAY"]),
    batch: batchRowSchema,
    items: z.array(batchItemRowSchema).min(1).max(100),
  })
  .strict();

export function createTenantArcPaymentRepositories(
  client: ArcPaymentSupabaseClient,
  trustedTenantId: string,
): TenantArcPaymentRepositories {
  const tenantId = tenantIdSchema.parse(trustedTenantId);
  const getBatch = (column: "batch_id" | "idempotency_key", value: string) =>
    readBatch(client, tenantId, column, value);

  const payments: ArcPaymentRepository = {
    async getReceiptByIdempotencyKey(idempotencyKey) {
      const row = await readOne(
        client,
        "arc_payment_receipts",
        tenantId,
        "idempotency_key",
        idempotencyKey,
      );
      return row ? mapReceipt(row, tenantId) : null;
    },
    async saveReceipt(receipt) {
      await upsertRow(
        client,
        "arc_payment_receipts",
        toReceiptRow(receipt, tenantId),
        "tenant_id,id",
      );
      return { ...receipt };
    },
    async appendActivity(activity) {
      await insertRow(
        client,
        "arc_agent_activity",
        toActivityRow(activity, tenantId),
      );
    },
    getBatch: (batchId) => getBatch("batch_id", batchId),
    getBatchByIdempotencyKey: (idempotencyKey) =>
      getBatch("idempotency_key", idempotencyKey),
    async createBatch(batch) {
      const result = await client.rpc("create_arc_payment_batch", {
        p_tenant_id: tenantId,
        p_batch_id: batch.batchId,
        p_idempotency_key: batch.idempotencyKey,
        p_wallet_address: batch.walletAddress,
        p_token: batch.token,
        p_chain: batch.chain,
        p_created_at: batch.createdAt,
        p_updated_at: batch.updatedAt,
        p_items: batch.items.map((item) => ({
          recipient: item.recipient,
          amount: item.amount,
          purpose: item.purpose ?? null,
        })),
      });
      if (result.error) {
        throw new Error("Arc payment atomic batch creation failed.");
      }
      return mapAtomicBatchResult(result.data, batch, tenantId);
    },
    async claimBatchItem(item) {
      const result = await client.rpc("claim_arc_payment_batch_item", {
        p_tenant_id: tenantId,
        p_batch_id: item.batchId,
        p_item_id: item.id,
        p_updated_at: item.updatedAt,
      });
      if (result.error) {
        throw new Error("Arc payment atomic batch item claim failed.");
      }
      if (result.data === null) {
        return null;
      }
      let claimed: ArcPaymentBatchItemRecord;
      try {
        claimed = mapBatchItem(result.data, tenantId);
      } catch {
        throw new Error("Arc payment atomic batch item claim returned invalid data.");
      }
      if (
        claimed.id !== item.id
        || claimed.batchId !== item.batchId
        || claimed.index !== item.index
        || claimed.status !== "SUBMITTED"
        || claimed.transactionId !== undefined
        || claimed.transactionHash !== undefined
      ) {
        throw new Error("Arc payment atomic batch item claim returned conflicting data.");
      }
      return claimed;
    },
    async saveBatchItem(item) {
      await upsertRow(
        client,
        "arc_payment_batch_items",
        toBatchItemRow(item, tenantId),
        "tenant_id,id",
      );
      return { ...item };
    },
    async saveBatch(batch) {
      await upsertRow(
        client,
        "arc_payment_batches",
        toBatchRow(batch, tenantId),
        "tenant_id,batch_id",
      );
      return cloneBatch(batch);
    },
  };

  const paymentRequests: ArcPaymentRequestRepository = {
    async getById(id) {
      const row = await readOne(
        client,
        "arc_payment_requests",
        tenantId,
        "id",
        id,
      );
      return row ? mapPaymentRequest(row, tenantId) : null;
    },
    async getByIdempotencyKey(idempotencyKey) {
      const row = await readOne(
        client,
        "arc_payment_requests",
        tenantId,
        "idempotency_key",
        idempotencyKey,
      );
      return row ? mapPaymentRequest(row, tenantId) : null;
    },
    async save(paymentRequest) {
      await upsertRow(
        client,
        "arc_payment_requests",
        toPaymentRequestRow(paymentRequest, tenantId),
        "tenant_id,id",
      );
      return { ...paymentRequest };
    },
  };

  return {
    payments,
    paymentRequests,
    activity: {
      async listAgentActivity({ limit }) {
        const result = await client
          .from("arc_agent_activity")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(limit);
        const rows = requireListData(result);
        return rows.map((row) => mapActivity(row, tenantId));
      },
    },
    receipts: {
      async getPaymentReceipt(receiptId) {
        const row = await readOne(
          client,
          "arc_payment_receipts",
          tenantId,
          "id",
          receiptId,
        );
        return row ? mapReceipt(row, tenantId) : null;
      },
    },
  };
}

function mapAtomicBatchResult(
  value: unknown,
  requested: ArcPaymentBatchRecord,
  tenantId: string,
): ArcPaymentBatchRecord {
  const result = atomicBatchResultSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Arc payment atomic batch creation returned invalid data.");
  }
  const batch = assertTenant(result.data.batch, tenantId);
  const items = result.data.items.map((item) => mapBatchItem(item, tenantId));
  const immutableHeaderMatches =
    batch.batch_id === requested.batchId
    && batch.idempotency_key === requested.idempotencyKey
    && batch.wallet_address.toLowerCase() === requested.walletAddress.toLowerCase()
    && batch.token === requested.token
    && batch.chain === requested.chain;
  const immutableItemsMatch =
    items.length === requested.items.length
    && items.every((item, index) => {
      const expected = requested.items[index];
      return expected !== undefined
        && item.id === `${requested.batchId}:${index}`
        && item.batchId === requested.batchId
        && item.index === index
        && item.recipient.toLowerCase() === expected.recipient.toLowerCase()
        && item.amount === expected.amount
        && item.purpose === expected.purpose;
    });
  if (!immutableHeaderMatches || !immutableItemsMatch) {
    throw new Error("Arc payment atomic batch creation returned conflicting data.");
  }
  return {
    batchId: batch.batch_id,
    idempotencyKey: batch.idempotency_key,
    walletAddress: batch.wallet_address,
    chain: batch.chain,
    token: batch.token,
    status: batch.status,
    items,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
  };
}

async function readBatch(
  client: ArcPaymentSupabaseClient,
  tenantId: string,
  column: "batch_id" | "idempotency_key",
  value: string,
): Promise<ArcPaymentBatchRecord | null> {
  const row = await readOne(
    client,
    "arc_payment_batches",
    tenantId,
    column,
    value,
  );
  if (!row) {
    return null;
  }
  const batchRow = assertTenant(batchRowSchema.parse(row), tenantId);
  const itemResult = await client
    .from("arc_payment_batch_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("batch_id", batchRow.batch_id)
    .order("item_index", { ascending: true });
  const items = requireListData(itemResult).map((item) =>
    mapBatchItem(item, tenantId),
  );
  return {
    batchId: batchRow.batch_id,
    idempotencyKey: batchRow.idempotency_key,
    walletAddress: batchRow.wallet_address,
    chain: batchRow.chain,
    token: batchRow.token,
    status: batchRow.status,
    items,
    createdAt: batchRow.created_at,
    updatedAt: batchRow.updated_at,
  };
}

async function readOne(
  client: ArcPaymentSupabaseClient,
  table: string,
  tenantId: string,
  column: string,
  value: string,
): Promise<unknown | null> {
  const result = await client
    .from(table)
    .select("*")
    .eq("tenant_id", tenantId)
    .eq(column, value)
    .maybeSingle();
  if (result.error) {
    throw new Error("Arc payment persistence read failed.");
  }
  return result.data ?? null;
}

async function insertRow(
  client: ArcPaymentSupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const result = await client.from(table).insert(row);
  if (result.error) {
    throw new Error("Arc payment persistence insert failed.");
  }
}

async function upsertRow(
  client: ArcPaymentSupabaseClient,
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
): Promise<void> {
  const result = await client.from(table).upsert(row, { onConflict });
  if (result.error) {
    throw new Error("Arc payment persistence update failed.");
  }
}

function requireListData(result: SupabaseListResult): unknown[] {
  if (result.error) {
    throw new Error("Arc payment persistence list failed.");
  }
  return result.data ?? [];
}

function assertTenant<T extends { tenant_id: string }>(
  row: T,
  tenantId: string,
): T {
  if (row.tenant_id !== tenantId) {
    throw new Error("Arc payment persistence returned a cross-tenant row.");
  }
  return row;
}

function mapReceipt(row: unknown, tenantId: string): ArcPaymentReceiptRecord {
  const parsed = assertTenant(receiptRowSchema.parse(row), tenantId);
  return omitUndefined({
    id: parsed.id,
    idempotencyKey: parsed.idempotency_key,
    walletAddress: parsed.wallet_address,
    recipient: parsed.recipient,
    amount: parsed.amount,
    token: parsed.token,
    chain: parsed.chain,
    purpose: parsed.purpose,
    status: parsed.status,
    transactionId: parsed.transaction_id ?? undefined,
    transactionHash: parsed.transaction_hash ?? undefined,
    explorerUrl: parsed.transaction_hash
      ? `https://testnet.arcscan.app/tx/${parsed.transaction_hash}`
      : undefined,
    errorMessage: parsed.error_message ?? undefined,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  }) as ArcPaymentReceiptRecord;
}

function mapBatchItem(
  row: unknown,
  tenantId: string,
): ArcPaymentBatchItemRecord {
  const parsed = assertTenant(batchItemRowSchema.parse(row), tenantId);
  return omitUndefined({
    id: parsed.id,
    batchId: parsed.batch_id,
    index: parsed.item_index,
    recipient: parsed.recipient,
    amount: parsed.amount,
    purpose: parsed.purpose ?? undefined,
    status: parsed.status,
    transactionId: parsed.transaction_id ?? undefined,
    transactionHash: parsed.transaction_hash ?? undefined,
    explorerUrl: parsed.transaction_hash
      ? `https://testnet.arcscan.app/tx/${parsed.transaction_hash}`
      : undefined,
    errorMessage: parsed.error_message ?? undefined,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  }) as ArcPaymentBatchItemRecord;
}

function mapPaymentRequest(
  row: unknown,
  tenantId: string,
): ArcPaymentRequestRecord {
  const parsed = assertTenant(paymentRequestRowSchema.parse(row), tenantId);
  return omitUndefined({
    id: parsed.id,
    idempotencyKey: parsed.idempotency_key,
    recipient: parsed.recipient,
    amount: parsed.amount,
    token: parsed.token,
    chain: parsed.chain,
    purpose: parsed.purpose,
    status: parsed.status,
    expiresAt: parsed.expires_at,
    receiptId: parsed.receipt_id ?? undefined,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  }) as ArcPaymentRequestRecord;
}

function mapActivity(
  row: unknown,
  tenantId: string,
): ArcAgentActivityRecord {
  const parsed = assertTenant(activityRowSchema.parse(row), tenantId);
  return Object.freeze({
    id: parsed.id,
    type: parsed.activity_type,
    status: parsed.status,
    referenceId: parsed.reference_id,
    metadata: Object.freeze({ ...parsed.metadata }),
    createdAt: parsed.created_at,
  });
}

function toReceiptRow(
  receipt: ArcPaymentReceiptRecord,
  tenantId: string,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    id: receipt.id,
    idempotency_key: receipt.idempotencyKey,
    wallet_address: receipt.walletAddress,
    recipient: receipt.recipient,
    amount: receipt.amount,
    token: receipt.token,
    chain: receipt.chain,
    purpose: receipt.purpose,
    status: receipt.status,
    transaction_id: receipt.transactionId ?? null,
    transaction_hash: receipt.transactionHash ?? null,
    error_message: receipt.errorMessage ?? null,
    created_at: receipt.createdAt,
    updated_at: receipt.updatedAt,
  };
}

function toBatchRow(
  batch: ArcPaymentBatchRecord,
  tenantId: string,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    batch_id: batch.batchId,
    idempotency_key: batch.idempotencyKey,
    wallet_address: batch.walletAddress,
    token: batch.token,
    chain: batch.chain,
    status: batch.status,
    created_at: batch.createdAt,
    updated_at: batch.updatedAt,
  };
}

function toBatchItemRow(
  item: ArcPaymentBatchItemRecord,
  tenantId: string,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    id: item.id,
    batch_id: item.batchId,
    item_index: item.index,
    recipient: item.recipient,
    amount: item.amount,
    purpose: item.purpose ?? null,
    status: item.status,
    transaction_id: item.transactionId ?? null,
    transaction_hash: item.transactionHash ?? null,
    error_message: item.errorMessage ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function toPaymentRequestRow(
  request: ArcPaymentRequestRecord,
  tenantId: string,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    id: request.id,
    idempotency_key: request.idempotencyKey,
    recipient: request.recipient,
    amount: request.amount,
    token: request.token,
    chain: request.chain,
    purpose: request.purpose,
    status: request.status,
    expires_at: request.expiresAt,
    receipt_id: request.receiptId ?? null,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function toActivityRow(
  activity: ArcAgentActivityRecord,
  tenantId: string,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    id: activity.id,
    activity_type: activity.type,
    status: activity.status,
    reference_id: activity.referenceId,
    metadata: { ...activity.metadata },
    created_at: activity.createdAt,
  };
}

function cloneBatch(batch: ArcPaymentBatchRecord): ArcPaymentBatchRecord {
  return {
    ...batch,
    items: batch.items.map((item) => ({ ...item })),
  };
}

function omitUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
