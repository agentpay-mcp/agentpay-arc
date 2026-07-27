import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runLocalAgentPayDemo } from "./demo-agentpay-flow.ts";

describe("runLocalAgentPayDemo", () => {
  it("runs an authenticated Arc Agent Wallet payment flow with in-memory adapters", async () => {
    const result = await runLocalAgentPayDemo();
    assert.equal(result.initialWallet.status, "NOT_CREATED");
    assert.equal(result.wallet.status, "ACTIVE");
    assert.equal(result.balance.status, "ACTIVE");
    assert.equal(result.invoice.status, "PARSED");
    assert.equal(result.invoice.invoiceId, "inv_demo");
    assert.equal(result.invoice.paymentInput.paymentType, "INVOICE_PAYMENT");
    assert.equal(result.x402.status, "PARSED");
    assert.equal(result.x402.paymentInput.paymentType, "X402_PAYMENT");
    assert.equal(result.x402.standardX402SignatureRequired, true);
    assert.equal(result.x402.resource.serviceName, "Market API");
    assert.equal(result.quote.paymentType, "SWAP_BRIDGE_PAY");
    assert.equal(result.quote.maxNativeFeeDisplay, "0.0025 USDC");
    assert.equal(result.routeAllowance.status, "ACTIVE");
    assert.equal(result.routeAllowance.routeTargetAllowed, true);
    assert.equal(result.prepared.paymentIntentId, "pay_demo");
    assert.equal(result.prepared.approvalPhrase, "APPROVE pay_demo");
    assert.equal(result.prepared.summary.maxNativeFeeDisplay, "0.0025 USDC");
    assert.match(result.prepared.summary.purpose, /^x402 payment for Market API: Premium market data \[x402-request:0x[a-f0-9]{64}\]$/);
    assert.equal(result.executed.status, "EXECUTING");
    assert.equal(result.tracked.status, "COMPLETED");
    assert.equal(result.x402Retry.status, "RESOURCE_FETCHED");
    assert.equal(result.x402Retry.httpStatus, 200);
    assert.equal(result.x402Retry.paymentResponse, "settled");
    assert.equal(result.x402Retry.bodyText, "{\"market\":\"premium\"}");
    assert.equal(result.transactions.transactions[0]?.status, "COMPLETED");
    assert.equal(result.transactions.transactions[0]?.paymentIntentId, "pay_demo");
    assert.equal(result.transactions.transactions[0]?.paymentType, "X402_PAYMENT");
    assert.deepEqual(
      result.events.events.map((event) => event.eventType),
      ["PAYMENT_PREPARED", "PAYMENT_APPROVED", "PAYMENT_EXECUTING", "PAYMENT_COMPLETED"],
    );
    assert.match(result.transcript.join("\n"), /Authenticated Agent Wallet: 0x3333333333333333333333333333333333333333 on Arc Testnet/);
    assert.match(result.transcript.join("\n"), /Invoice parsed: inv_demo/);
    assert.match(result.transcript.join("\n"), /x402 parsed: Market API/);
    assert.match(result.transcript.join("\n"), /x402 retry result: 200 with settled/);
    assert.match(result.transcript.join("\n"), /Approval required: APPROVE pay_demo/);
    assert.match(result.transcript.join("\n"), /Route target allowlisted: true/);
  });
});
