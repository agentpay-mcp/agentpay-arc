import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArcAgentActivityRecord,
  ArcPaymentBatchRecord,
  ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";

import {
  createTenantArcPaymentRepositories,
  type ArcPaymentSupabaseQuery,
  type ArcPaymentSupabaseClient,
  type SupabaseListResult,
} from "./arc-payments-supabase.ts";
import type { ArcPaymentRequestRecord } from "../tools/invoice.ts";

const TENANT_ID = "a4b6aa2b-8e5d-440a-bcad-1a9f5e3d83db";
const OTHER_TENANT_ID = "38377b2b-8dab-473d-9b85-cdfa30f850f7";
const RECEIPT_ID = "436dd5c3-d784-4980-b708-3f1ddc84010e";
const BATCH_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
const BATCH_KEY = "ea1e8ff1-edaa-4a27-a6de-715f76d5aa7c";
const REQUEST_ID = "c612a50c-89db-4de7-94ae-bc19ce2ff4a7";
const WALLET = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

describe("tenant-bound Arc payment Supabase repositories", () => {
  it("adds the trusted tenant to every read and write without exposing caller authority", async () => {
    const client = new SupabaseSpy();
    const repositories = createTenantArcPaymentRepositories(client, TENANT_ID);

    await repositories.payments.getReceiptByIdempotencyKey(RECEIPT_ID);
    await repositories.payments.getBatch(BATCH_ID);
    await repositories.payments.getBatchByIdempotencyKey(BATCH_KEY);
    await repositories.paymentRequests.getById(REQUEST_ID);
    await repositories.paymentRequests.getByIdempotencyKey(BATCH_KEY);
    await repositories.activity.listAgentActivity({ limit: 5 });
    await repositories.receipts.getPaymentReceipt(RECEIPT_ID);
    await repositories.payments.saveReceipt(receiptRecord());
    await repositories.paymentRequests.save(requestRecord());
    await repositories.payments.createBatch(batchRecord());
    await repositories.payments.saveBatchItem(batchRecord().items[0]!);
    await repositories.payments.saveBatch(batchRecord());
    await repositories.payments.appendActivity(activityRecord());

    const readQueries = client.queries.filter((query) => query.selected);
    assert.ok(readQueries.length >= 7);
    for (const query of readQueries) {
      assert.ok(
        query.filters.some(
          ([column, value]) => column === "tenant_id" && value === TENANT_ID,
        ),
        `${query.table} read must filter trusted tenant`,
      );
      assert.equal(
        query.filters.some(([, value]) => value === OTHER_TENANT_ID),
        false,
      );
    }
    assert.ok(client.writes.length >= 7);
    for (const write of client.writes) {
      assert.equal(write.row.tenant_id, TENANT_ID, `${write.table} write tenant`);
      assert.equal("tenantId" in write.row, false);
    }
  });

  it("rejects an invalid trusted tenant before touching Supabase", () => {
    const client = new SupabaseSpy();
    assert.throws(
      () => createTenantArcPaymentRepositories(client, "caller-controlled"),
      /tenant|uuid/i,
    );
    assert.equal(client.queries.length, 0);
    assert.equal(client.writes.length, 0);
  });

  it("strictly maps tenant-scoped receipt, batch, request, and activity rows", async () => {
    const txHash = `0x${"a".repeat(64)}`;
    const client = new SupabaseSpy({
      arc_payment_receipts: [{
        tenant_id: TENANT_ID,
        id: RECEIPT_ID,
        idempotency_key: RECEIPT_ID,
        payment_request_id: null,
        wallet_address: WALLET,
        recipient: RECIPIENT,
        amount: "1",
        token: "USDC",
        chain: "ARC-TESTNET",
        purpose: "Tenant test",
        status: "COMPLETED",
        transaction_id: "circle_tx_1",
        transaction_hash: txHash,
        error_message: null,
        created_at: "2026-07-26T09:00:00.000Z",
        updated_at: "2026-07-26T09:01:00.000Z",
      }],
      arc_payment_batches: [{
        tenant_id: TENANT_ID,
        batch_id: BATCH_ID,
        idempotency_key: BATCH_KEY,
        wallet_address: WALLET,
        token: "USDC",
        chain: "ARC-TESTNET",
        status: "COMPLETED",
        created_at: "2026-07-26T09:00:00.000Z",
        updated_at: "2026-07-26T09:01:00.000Z",
      }],
      arc_payment_batch_items: [{
        tenant_id: TENANT_ID,
        id: `${BATCH_ID}:0`,
        batch_id: BATCH_ID,
        item_index: 0,
        recipient: RECIPIENT,
        amount: "1",
        purpose: null,
        status: "COMPLETED",
        transaction_id: "circle_tx_1",
        transaction_hash: txHash,
        error_message: null,
        created_at: "2026-07-26T09:00:00.000Z",
        updated_at: "2026-07-26T09:01:00.000Z",
      }],
      arc_payment_requests: [{
        tenant_id: TENANT_ID,
        id: REQUEST_ID,
        idempotency_key: BATCH_KEY,
        recipient: RECIPIENT,
        amount: "1",
        token: "USDC",
        chain: "ARC-TESTNET",
        purpose: "Tenant test",
        status: "OPEN",
        expires_at: "2026-07-26T10:00:00.000Z",
        receipt_id: null,
        created_at: "2026-07-26T09:00:00.000Z",
        updated_at: "2026-07-26T09:00:00.000Z",
      }],
      arc_agent_activity: [{
        tenant_id: TENANT_ID,
        id: "activity_1",
        activity_type: "PAYMENT",
        status: "COMPLETED",
        reference_id: RECEIPT_ID,
        metadata: { amount: "1" },
        created_at: "2026-07-26T09:01:00.000Z",
      }],
    });
    const repositories = createTenantArcPaymentRepositories(client, TENANT_ID);

    const receipt = await repositories.receipts.getPaymentReceipt(RECEIPT_ID);
    const batch = await repositories.payments.getBatchByIdempotencyKey(BATCH_KEY);
    const request = await repositories.paymentRequests.getById(REQUEST_ID);
    const activities = await repositories.activity.listAgentActivity({ limit: 5 });

    assert.equal(receipt?.explorerUrl, `https://testnet.arcscan.app/tx/${txHash}`);
    assert.equal(batch?.items[0]?.transactionId, "circle_tx_1");
    assert.equal(request?.purpose, "Tenant test");
    assert.ok(Object.isFrozen(activities[0]));
    assert.ok(Object.isFrozen(activities[0]?.metadata));
  });
});

class SupabaseSpy implements ArcPaymentSupabaseClient {
  readonly queries: QuerySpy[] = [];
  readonly writes: Array<{ table: string; row: Record<string, unknown> }> = [];

  constructor(
    private readonly fixtures: Record<string, Record<string, unknown>[]> = {},
  ) {}

  from(table: string): QuerySpy {
    const query = new QuerySpy(table, this.writes, this.fixtures[table] ?? []);
    this.queries.push(query);
    return query;
  }
}

class QuerySpy implements ArcPaymentSupabaseQuery {
  readonly filters: Array<[string, unknown]> = [];
  selected = false;

  constructor(
    readonly table: string,
    private readonly writes: Array<{ table: string; row: Record<string, unknown> }>,
    private readonly fixtures: Record<string, unknown>[],
  ) {}

  select(_columns?: string): this {
    this.selected = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(
    _column: string,
    _options: { readonly ascending: boolean },
  ): this {
    return this;
  }

  limit(_count: number): this {
    return this;
  }

  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    return Promise.resolve({ data: this.filteredRows()[0] ?? null, error: null });
  }

  upsert(
    row: Record<string, unknown>,
    _options?: { readonly onConflict?: string },
  ): Promise<{ data: null; error: null }> {
    this.writes.push({ table: this.table, row: structuredClone(row) });
    return Promise.resolve({ data: null, error: null });
  }

  insert(
    row: Record<string, unknown>,
  ): Promise<{ data: null; error: null }> {
    this.writes.push({ table: this.table, row: structuredClone(row) });
    return Promise.resolve({ data: null, error: null });
  }

  then<TResult1 = SupabaseListResult, TResult2 = never>(
    onfulfilled?:
      | ((value: SupabaseListResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve<SupabaseListResult>({
      data: this.filteredRows(),
      error: null,
    }).then(
      onfulfilled,
      onrejected,
    );
  }

  private filteredRows(): Record<string, unknown>[] {
    return this.fixtures.filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
  }
}

function receiptRecord(): ArcPaymentReceiptRecord {
  return {
    id: RECEIPT_ID,
    idempotencyKey: RECEIPT_ID,
    walletAddress: WALLET,
    recipient: RECIPIENT,
    amount: "1",
    token: "USDC",
    chain: "ARC-TESTNET",
    purpose: "Tenant test",
    status: "PENDING",
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:00.000Z",
  };
}

function requestRecord(): ArcPaymentRequestRecord {
  return {
    id: REQUEST_ID,
    idempotencyKey: BATCH_KEY,
    recipient: RECIPIENT,
    amount: "1",
    token: "USDC",
    chain: "ARC-TESTNET",
    purpose: "Tenant test",
    status: "OPEN",
    expiresAt: "2026-07-26T10:00:00.000Z",
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:00.000Z",
  };
}

function batchRecord(): ArcPaymentBatchRecord {
  return {
    batchId: BATCH_ID,
    idempotencyKey: BATCH_KEY,
    walletAddress: WALLET,
    chain: "ARC-TESTNET",
    token: "USDC",
    status: "PENDING",
    items: [{
      id: `${BATCH_ID}:0`,
      batchId: BATCH_ID,
      index: 0,
      recipient: RECIPIENT,
      amount: "1",
      status: "PENDING",
      createdAt: "2026-07-26T09:00:00.000Z",
      updatedAt: "2026-07-26T09:00:00.000Z",
    }],
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:00.000Z",
  };
}

function activityRecord(): ArcAgentActivityRecord {
  return Object.freeze({
    id: "activity_1",
    type: "PAYMENT",
    status: "PENDING",
    referenceId: RECEIPT_ID,
    metadata: Object.freeze({ amount: "1" }),
    createdAt: "2026-07-26T09:00:00.000Z",
  });
}
