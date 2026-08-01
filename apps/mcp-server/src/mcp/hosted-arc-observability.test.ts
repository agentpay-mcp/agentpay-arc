import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArcHostedAuthority,
  ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";

import type { HostedArcWalletFacade } from "../runtime/hosted-arc-wallet-runtime.ts";
import type { ArcPaymentRepository } from "../tools/arc-payments.ts";
import { createHostedArcObservability } from "./hosted-arc-observability.ts";

const authority: ArcHostedAuthority = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  walletAddress: "0x1111111111111111111111111111111111111111",
  accountStatus: "ACTIVE",
  authEpoch: 3,
  capabilities: ["wallet:read", "payment:send"],
};
const receipt: ArcPaymentReceiptRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "44444444-4444-4444-8444-444444444444",
  walletAddress: authority.walletAddress,
  recipient: "0x2222222222222222222222222222222222222222",
  amount: "0.01",
  token: "USDC",
  chain: "ARC-TESTNET",
  purpose: "Hosted account withdrawal",
  status: "SUBMITTED",
  transactionId: "circle-tx-1",
  createdAt: "2026-07-31T01:00:00.000Z",
  updatedAt: "2026-07-31T01:01:00.000Z",
};

function createDependencies(
  transactionState = "COMPLETE",
  storedReceipt: ArcPaymentReceiptRecord = receipt,
) {
  const transitions: ArcPaymentReceiptRecord[] = [];
  let transactionReads = 0;
  const payments = {
    async getReceiptByIdempotencyKey() {
      return { ...storedReceipt };
    },
    async transitionReceipt(next: ArcPaymentReceiptRecord) {
      transitions.push({ ...next });
      return { ...next };
    },
  } as unknown as ArcPaymentRepository;
  const facade = {
    async getBalances() {
      return [
        {
          symbol: "USDC",
          amount: "19.98",
          address: "0x3600000000000000000000000000000000000000",
        },
        { symbol: "USDC", amount: "999", address: "0x2222222222222222222222222222222222222222" },
      ];
    },
    async getTransactionStatus(_authority: ArcHostedAuthority, transactionId: string) {
      transactionReads += 1;
      return {
        transactionId,
        state: transactionState,
        txHash: `0x${"a".repeat(64)}`,
      };
    },
  } as unknown as HostedArcWalletFacade;
  return { payments, facade, transitions, transactionReads: () => transactionReads };
}

describe("hosted Arc account projection and withdrawal reconciliation", () => {
  it("projects only canonical USDC and tenant-scoped receipt activity", async () => {
    const dependencies = createDependencies();
    const observability = createHostedArcObservability({
      facade: dependencies.facade,
      paymentsForTenant: () => dependencies.payments,
      async listReceiptsForTenant(tenantId, limit) {
        assert.equal(tenantId, authority.tenantId);
        assert.equal(limit, 20);
        return [{ ...receipt }];
      },
      clock: () => new Date("2026-07-31T01:02:00.000Z"),
    });

    assert.deepEqual(await observability.projectAccount(authority), {
      balanceUsdc: "19.98",
      activity: [{
        id: receipt.id,
        type: "Withdrawal",
        amount: "0.01",
        status: "SUBMITTED",
        timestamp: receipt.updatedAt,
      }],
    });
  });

  it("persists a terminal Circle status without ever resubmitting", async () => {
    const dependencies = createDependencies("COMPLETE");
    const observability = createHostedArcObservability({
      facade: dependencies.facade,
      paymentsForTenant: (tenantId) => {
        assert.equal(tenantId, authority.tenantId);
        return dependencies.payments;
      },
      async listReceiptsForTenant() {
        return [];
      },
      clock: () => new Date("2026-07-31T01:02:00.000Z"),
    });

    const result = await observability.reconcileWithdrawal(authority, {
      idempotencyKey: receipt.idempotencyKey,
      transactionId: receipt.transactionId!,
    });

    assert.deepEqual(result, {
      status: "COMPLETED",
      transactionId: "circle-tx-1",
      transactionHash: `0x${"a".repeat(64)}`,
      reconciliationRequired: false,
    });
    assert.equal(dependencies.transactionReads(), 1);
    assert.deepEqual(dependencies.transitions, [{
      ...receipt,
      status: "COMPLETED",
      transactionHash: `0x${"a".repeat(64)}`,
      updatedAt: "2026-07-31T01:02:00.000Z",
    }]);
  });

  it("rejects mismatched tenant receipt bindings before reading Circle", async () => {
    const dependencies = createDependencies();
    const payments = {
      ...dependencies.payments,
      async getReceiptByIdempotencyKey() {
        return { ...receipt, walletAddress: "0x9999999999999999999999999999999999999999" };
      },
    } as ArcPaymentRepository;
    const observability = createHostedArcObservability({
      facade: dependencies.facade,
      paymentsForTenant: () => payments,
      async listReceiptsForTenant() {
        return [];
      },
    });

    await assert.rejects(
      observability.reconcileWithdrawal(authority, {
        idempotencyKey: receipt.idempotencyKey,
        transactionId: receipt.transactionId!,
      }),
      /not found/i,
    );
    assert.equal(dependencies.transactionReads(), 0);
  });

  it("recovers a reconciliation-required receipt when Circle later confirms it", async () => {
    const quarantined = {
      ...receipt,
      status: "RECONCILIATION_REQUIRED" as const,
      errorMessage: "Circle transaction failed",
    };
    const dependencies = createDependencies("COMPLETE", quarantined);
    const observability = createHostedArcObservability({
      facade: dependencies.facade,
      paymentsForTenant: () => dependencies.payments,
      async listReceiptsForTenant() {
        return [];
      },
      clock: () => new Date("2026-07-31T01:02:00.000Z"),
    });

    const result = await observability.reconcileWithdrawal(authority, {
      idempotencyKey: receipt.idempotencyKey,
      transactionId: receipt.transactionId!,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.reconciliationRequired, false);
    const { errorMessage: _priorError, ...recovered } = quarantined;
    assert.deepEqual(dependencies.transitions, [{
      ...recovered,
      status: "COMPLETED",
      transactionHash: `0x${"a".repeat(64)}`,
      updatedAt: "2026-07-31T01:02:00.000Z",
    }]);
  });
});
