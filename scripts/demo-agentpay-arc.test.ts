import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDeterministicArcDemo } from "./demo-agentpay-arc.ts";

describe("runDeterministicArcDemo", () => {
  it("covers all 19 approved features without credentials or network writes", async () => {
    const result = await runDeterministicArcDemo();

    assert.equal(result.features.length, 19);
    assert.equal(new Set(result.features.map(({ id }) => id)).size, 19);
    assert.equal(result.registeredTools.length, 31);
    assert.equal(new Set(result.registeredTools).size, 31);
    assert.equal(
      result.features.every(({ tools }) =>
        tools.every((tool) => result.registeredTools.includes(tool))),
      true,
    );

    assert.equal(result.wallet.status, "READY");
    assert.equal(result.budget.autonomousBudgetUsdc, "26.5");
    assert.equal(result.payment.status, "COMPLETED");
    assert.deepEqual(result.paymentReplay, result.payment);
    assert.equal(result.transferAttemptsAfterReplay, 1);
    assert.equal(result.reconciliation.status, "RECONCILIATION_REQUIRED");
    assert.equal(result.paidService.receipt.status, "SETTLED");
    assert.deepEqual(
      result.paidServiceReplay.receipt,
      result.paidService.receipt,
    );
    assert.equal(result.bridge.status, "COMPLETED");
    assert.equal(result.swap.status, "COMPLETED");
    assert.deepEqual(result.swapReplay, result.swap);
    assert.equal(result.swapAndPay.status, "COMPLETED");
    assert.equal(result.identity.status, "CONFIRMED");
    assert.deepEqual(result.identityReplay, result.identity);
    assert.equal(result.job.status, "SUBMITTED");
    assert.equal(result.job.jobId, "7");
    assert.deepEqual(result.mutationAttempts, {
      transfers: 3,
      paidServices: 1,
      bridges: 1,
      swaps: 2,
      contracts: 2,
    });
    assert.equal(result.receipt.status, "COMPLETED");
    assert.equal(result.activity.length >= 2, true);
    assert.equal(result.marketplace.catalogueStatus, 200);
    assert.equal(result.marketplace.tenantActivityStatus, 401);
    assert.equal(result.sellerEndpointReady, true);
    assert.match(result.transcript.join("\n"), /19\/19 features mapped/);
    assert.match(result.transcript.join("\n"), /replay reused the receipt/i);
    assert.match(result.transcript.join("\n"), /reconciliation required/i);
    assert.match(
      result.transcript.join("\n"),
      /x402, bridge, swap, swap-and-pay, ERC-8004, and ERC-8183 adapters completed/i,
    );
  });
});
