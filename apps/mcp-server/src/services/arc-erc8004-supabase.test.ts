import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTenantArcErc8004EvidenceRepository,
  type ArcErc8004SupabaseClient,
} from "./arc-erc8004-supabase.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);

describe("tenant Arc ERC-8004 evidence repository", () => {
  it("claims and completes mutations through tenant-scoped RPCs", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: ArcErc8004SupabaseClient = {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === "claim_arc_erc8004_mutation") {
          return {
            data: {
              claimed: true,
              record: {
                tenant_id: tenantId,
                mutation_key: "feedback:payment-1",
                fingerprint,
                status: "CLAIMED",
                output: null,
              },
            },
            error: null,
          };
        }
        return {
          data: {
            tenant_id: tenantId,
            mutation_key: "feedback:payment-1",
            fingerprint,
            status: "COMPLETED",
            output: args.p_output,
          },
          error: null,
        };
      },
    };
    const repository = createTenantArcErc8004EvidenceRepository(client, tenantId);

    const claim = await repository.claim({
      key: "feedback:payment-1",
      fingerprint,
      status: "CLAIMED",
    });
    assert.equal(claim.claimed, true);
    const completed = await repository.complete(
      "feedback:payment-1",
      fingerprint,
      {
        status: "CONFIRMED",
        operation: "FEEDBACK",
        transactionId: "circle-tx-1",
        transactionHash: `0x${"b".repeat(64)}`,
        arcscanUrl: `https://testnet.arcscan.app/tx/0x${"b".repeat(64)}`,
        blockNumber: "42",
        reconciliationRequired: false,
      },
    );
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(calls.map(({ name }) => name), [
      "claim_arc_erc8004_mutation",
      "complete_arc_erc8004_mutation",
    ]);
    assert.equal(calls[0]!.args.p_tenant_id, tenantId);
  });

  it("rejects foreign tenants and malformed stored proof", async () => {
    const repository = createTenantArcErc8004EvidenceRepository({
      async rpc() {
        return {
          data: {
            claimed: false,
            record: {
              tenant_id: "22222222-2222-4222-8222-222222222222",
              mutation_key: "feedback:payment-1",
              fingerprint,
              status: "COMPLETED",
              output: { privateKey: `0x${"1".repeat(64)}` },
            },
          },
          error: null,
        };
      },
    }, tenantId);
    await assert.rejects(
      repository.claim({
        key: "feedback:payment-1",
        fingerprint,
        status: "CLAIMED",
      }),
      /invalid data/,
    );
  });
});
