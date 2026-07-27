import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTenantArcLiquidityRepository,
  type ArcLiquiditySupabaseClient,
} from "./arc-liquidity-supabase.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const wallet = "0x1111111111111111111111111111111111111111";
const fingerprint = "a".repeat(64);
const createdAt = "2026-07-27T00:00:00.000Z";

describe("tenant Arc liquidity repository", () => {
  it("claims and transitions through tenant-scoped atomic RPCs", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: ArcLiquiditySupabaseClient = {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === "get_arc_liquidity_operation") {
          return { data: null, error: null };
        }
        const operation = args.p_operation as Record<string, unknown>;
        if (name === "claim_arc_liquidity_operation") {
          return {
            data: {
              claimed: true,
              operation: toRow(operation),
            },
            error: null,
          };
        }
        return {
          data: toRow(operation),
          error: null,
        };
      },
    };
    const repository = createTenantArcLiquidityRepository(client, tenantId);
    const operation = {
      id: operationId,
      kind: "SWAP" as const,
      inputFingerprint: fingerprint,
      status: "SUBMITTING" as const,
      walletAddress: wallet,
      quoteExpiresAt: "2026-07-27T00:05:00.000Z",
      steps: [],
      createdAt,
      updatedAt: createdAt,
    };

    assert.equal(await repository.get(operationId), null);
    const claim = await repository.claim(operation);
    assert.equal(claim.claimed, true);
    const transitioned = await repository.transition(
      {
        ...operation,
        status: "SUBMITTED",
        steps: [{ name: "SWAP", status: "SUBMITTED", transactionId: "tx-1" }],
      },
      ["SUBMITTING"],
    );
    assert.equal(transitioned.status, "SUBMITTED");
    assert.deepEqual(calls.map(({ name }) => name), [
      "get_arc_liquidity_operation",
      "claim_arc_liquidity_operation",
      "transition_arc_liquidity_operation",
    ]);
    assert.equal(calls[0]!.args.p_tenant_id, tenantId);
    assert.deepEqual(calls[2]!.args.p_expected_statuses, ["SUBMITTING"]);
  });

  it("rejects invalid tenant data and conflicting RPC responses", async () => {
    assert.throws(
      () => createTenantArcLiquidityRepository({ rpc: async () => ({ data: null, error: null }) }, "tenant"),
    );
    const repository = createTenantArcLiquidityRepository({
      async rpc() {
        return {
          data: {
            claimed: true,
            operation: toRow({
              id: operationId,
              kind: "BRIDGE",
              inputFingerprint: fingerprint,
              status: "SUBMITTING",
              walletAddress: wallet,
              quoteExpiresAt: "2026-07-27T00:05:00.000Z",
              steps: [],
              createdAt,
              updatedAt: createdAt,
            }),
          },
          error: null,
        };
      },
    }, tenantId);
    await assert.rejects(
      repository.claim({
        id: operationId,
        kind: "SWAP",
        inputFingerprint: fingerprint,
        status: "SUBMITTING",
        walletAddress: wallet,
        quoteExpiresAt: "2026-07-27T00:05:00.000Z",
        steps: [],
        createdAt,
        updatedAt: createdAt,
      }),
      /conflicting data/,
    );
  });

  it("accepts an identical replay whose newly generated quote timestamps differ", async () => {
    const persisted = {
      id: operationId,
      kind: "SWAP" as const,
      inputFingerprint: fingerprint,
      status: "COMPLETED" as const,
      walletAddress: wallet,
      quoteExpiresAt: "2026-07-27T00:05:00.000Z",
      steps: [{ name: "SWAP" as const, status: "COMPLETED" as const }],
      createdAt,
      updatedAt: createdAt,
    };
    const repository = createTenantArcLiquidityRepository({
      async rpc() {
        return {
          data: { claimed: false, operation: toRow(persisted) },
          error: null,
        };
      },
    }, tenantId);

    const replay = await repository.claim({
      ...persisted,
      status: "SUBMITTING",
      steps: [],
      quoteExpiresAt: "2026-07-27T00:06:00.000Z",
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    });

    assert.equal(replay.claimed, false);
    assert.equal(replay.operation.status, "COMPLETED");
  });
});

function toRow(operation: Record<string, unknown>) {
  return {
    tenant_id: tenantId,
    id: operation.id,
    kind: operation.kind,
    input_fingerprint: operation.inputFingerprint,
    status: operation.status,
    wallet_address: operation.walletAddress,
    quote_expires_at: operation.quoteExpiresAt,
    steps: operation.steps,
    error_code: operation.errorCode ?? null,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
  };
}
