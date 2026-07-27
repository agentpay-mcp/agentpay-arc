import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createArcCircleComplianceProvider,
  createCircleComplianceGate,
  createInMemoryComplianceEvidenceRepository,
  createTenantComplianceEvidenceRepository,
  type ComplianceEvidenceSupabaseClient,
  type ComplianceScreeningProvider,
} from "./circle-compliance.ts";

const operationId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const address = "0x1111111111111111111111111111111111111111";
const clock = () => new Date("2026-07-27T12:00:00.000Z");

describe("Circle compliance gate", () => {
  it("never claims a live Arc decision from the standalone provider", async () => {
    let transports = 0;
    const provider = createArcCircleComplianceProvider({
      configured: true,
      transport: async () => {
        transports += 1;
        return { decision: "APPROVED", referenceId: "must-not-be-used" };
      },
    });

    assert.deepEqual(await provider.screen({
      address,
      chain: "ARC-TESTNET",
      direction: "SEND",
    }), {
      decision: "UNAVAILABLE",
      availability: "UNSUPPORTED_CHAIN",
    });
    assert.equal(transports, 0);
  });

  it("records built-in provenance separately while optional live screening is disabled", async () => {
    const evidence = createInMemoryComplianceEvidenceRepository();
    const gate = createCircleComplianceGate({
      mode: "DISABLED",
      evidence,
      clock,
    });

    const result = await gate.screen({
      operationId,
      address,
      direction: "SEND",
      channel: "AGENT_WALLET_TRANSFER",
    });

    assert.equal(result.allowed, true);
    assert.equal((await gate.screen({
      operationId,
      address,
      direction: "SEND",
      channel: "AGENT_WALLET_TRANSFER",
    })).allowed, true);
    assert.equal(result.engineDecision, "UNAVAILABLE");
    assert.deepEqual(
      (await evidence.list(operationId)).map(({ evidenceType, status }) => ({
        evidenceType,
        status,
      })),
      [
        {
          evidenceType: "CIRCLE_AGENT_WALLET_BUILT_IN",
          status: "DECLARED_RUNTIME_CONTROL",
        },
        {
          evidenceType: "CIRCLE_COMPLIANCE_ENGINE",
          status: "DISABLED",
        },
      ],
    );
  });

  it("allows only an approved live-required decision and replays durable evidence", async () => {
    let calls = 0;
    const provider: ComplianceScreeningProvider = {
      async screen() {
        calls += 1;
        return { decision: "APPROVED", referenceId: "screen_123" };
      },
    };
    const evidence = createInMemoryComplianceEvidenceRepository();
    const gate = createCircleComplianceGate({
      mode: "LIVE_REQUIRED",
      provider,
      evidence,
      clock,
    });
    const input = {
      operationId,
      address,
      direction: "SEND" as const,
      channel: "AGENT_WALLET_TRANSFER" as const,
    };

    assert.equal((await gate.screen(input)).allowed, true);
    assert.equal((await gate.screen(input)).allowed, true);
    assert.equal(calls, 1);
    const engine = (await evidence.list(operationId)).find(
      ({ evidenceType }) => evidenceType === "CIRCLE_COMPLIANCE_ENGINE",
    );
    assert.equal(engine?.decision, "APPROVED");
    assert.equal(engine?.referenceId, "screen_123");
  });

  it("fails closed and redacts provider errors for denied, review, and unavailable results", async () => {
    for (const decision of ["DENIED", "REVIEW", "UNAVAILABLE"] as const) {
      const evidence = createInMemoryComplianceEvidenceRepository();
      const gate = createCircleComplianceGate({
        mode: "LIVE_REQUIRED",
        provider: { screen: async () => ({ decision }) },
        evidence,
        clock,
      });
      await assert.rejects(
        gate.screen({
          operationId,
          address,
          direction: "RECEIVE",
          channel: "AGENT_WALLET_PAID_SERVICE",
        }),
        /compliance/i,
      );
    }

    const evidence = createInMemoryComplianceEvidenceRepository();
    const gate = createCircleComplianceGate({
      mode: "LIVE_REQUIRED",
      provider: {
        screen: async () => {
          throw new Error("authorization=secret-api-key");
        },
      },
      evidence,
      clock,
    });
    await assert.rejects(
      gate.screen({
        operationId,
        address,
        direction: "SEND",
        channel: "AGENT_WALLET_TRANSFER",
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret|authorization/i);
        return true;
      },
    );
    assert.doesNotMatch(JSON.stringify(await evidence.list(operationId)), /secret-api-key/);
  });

  it("does not persist a provider reference for an unavailable engine result", async () => {
    const evidence = createInMemoryComplianceEvidenceRepository();
    const gate = createCircleComplianceGate({
      mode: "LIVE_REQUIRED",
      provider: {
        screen: async () => ({
          decision: "UNAVAILABLE",
          availability: "UNSUPPORTED_CHAIN",
          referenceId: "unsupported_attempt",
        }),
      },
      evidence,
      clock,
    });

    await assert.rejects(
      gate.screen({
        operationId,
        address,
        direction: "SEND",
        channel: "AGENT_WALLET_TRANSFER",
      }),
      /compliance/i,
    );
    const engine = (await evidence.list(operationId)).find(
      ({ evidenceType }) => evidenceType === "CIRCLE_COMPLIANCE_ENGINE",
    );
    assert.equal(engine?.status, "UNSUPPORTED_CHAIN");
    assert.equal(engine?.referenceId, undefined);
  });

  it("fails closed on an approved decision paired with unavailable screening", async () => {
    const evidence = createInMemoryComplianceEvidenceRepository();
    const gate = createCircleComplianceGate({
      mode: "LIVE_REQUIRED",
      provider: {
        screen: async () => ({
          decision: "APPROVED",
          availability: "UNSUPPORTED_CHAIN",
        }),
      },
      evidence,
      clock,
    });

    await assert.rejects(
      gate.screen({
        operationId,
        address,
        direction: "SEND",
        channel: "AGENT_WALLET_TRANSFER",
      }),
      /compliance/i,
    );
    const engine = (await evidence.list(operationId)).find(
      ({ evidenceType }) => evidenceType === "CIRCLE_COMPLIANCE_ENGINE",
    );
    assert.equal(engine?.decision, "UNAVAILABLE");
    assert.equal(engine?.status, "UNAVAILABLE");
  });
});

describe("tenant compliance evidence repository", () => {
  it("uses only tenant-scoped atomic RPCs and validates returned evidence", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: ComplianceEvidenceSupabaseClient = {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === "list_arc_compliance_evidence") {
          return { data: [], error: null };
        }
        const evidence = args.p_evidence as Record<string, unknown>;
        return {
          data: {
            tenant_id: tenantId,
            evidence_key: evidence.evidenceKey,
            operation_id: evidence.operationId,
            address: evidence.address,
            direction: evidence.direction,
            channel: evidence.channel,
            evidence_type: evidence.evidenceType,
            status: evidence.status,
            decision: evidence.decision ?? null,
            reference_id: evidence.referenceId ?? null,
            created_at: evidence.createdAt,
          },
          error: null,
        };
      },
    };
    const repository = createTenantComplianceEvidenceRepository(client, tenantId);

    assert.deepEqual(await repository.list(operationId), []);
    const stored = await repository.record({
      evidenceKey: `${operationId}:engine`,
      operationId,
      address,
      direction: "SEND",
      channel: "AGENT_WALLET_TRANSFER",
      evidenceType: "CIRCLE_COMPLIANCE_ENGINE",
      status: "SCREENED",
      decision: "APPROVED",
      referenceId: "screen_123",
      createdAt: clock().toISOString(),
    });
    assert.equal(stored.decision, "APPROVED");
    assert.deepEqual(calls.map(({ name }) => name), [
      "list_arc_compliance_evidence",
      "record_arc_compliance_evidence",
    ]);
    assert.ok(calls.every(({ args }) => args.p_tenant_id === tenantId));
  });
});
