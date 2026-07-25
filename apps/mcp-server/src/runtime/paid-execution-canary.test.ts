import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDirectPaymentRouteQuote } from "@agentpay-ai/shared-arc";
import { MAINNET_USDC_ADDRESS } from "./production-readiness.ts";
import {
  assertCanaryRequestAllowed,
  createCanaryUsageStore,
  decimalToAtomic18,
  decimalToAtomic6,
  DEFAULT_CANARY_CAPS,
} from "./paid-execution-canary.ts";

const intent = {
  id: "pay_canary",
  tenantId: "tenant_1",
  accountAddress: "0x2222222222222222222222222222222222222222",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  status: "AWAITING_APPROVAL" as const,
  paymentType: "WALLET_PAYMENT" as const,
  sourceChainId: 42220,
  destinationChainId: 42220,
  sourceTokenSymbol: "USDC",
  destinationTokenSymbol: "USDC",
  recipientAddress: "0x3333333333333333333333333333333333333333",
  amountOut: "0.10",
  minAmountOut: "0.10",
  nativeValue: "0",
  ...createDirectPaymentRouteQuote({ chainId: 42220, tokenSymbol: "USDC", amountOut: "0.10" }),
  sourceTokenAddress: MAINNET_USDC_ADDRESS,
  destinationTokenAddress: MAINNET_USDC_ADDRESS,
  maxAmountIn: "0.10",
  maxNativeFee: "0",
  nonce: "1",
  deadline: "2026-07-14T00:00:00.000Z",
  purpose: "canary",
  approvalPhrase: "APPROVE pay_canary",
};

const allowlist = {
  tenantId: "tenant_1",
  ownerAddress: intent.ownerAddress,
  accountAddress: intent.accountAddress,
  payerAddress: "0x4444444444444444444444444444444444444444",
  recipientAddress: intent.recipientAddress,
};

describe("mainnet canary caps", () => {
  it("rejects malformed decimal values instead of ignoring extra separators", () => {
    assert.throws(() => decimalToAtomic6("1..9"), /at most 6 decimals/i);
    assert.throws(() => decimalToAtomic18("0.05.1"), /at most 18 decimals/i);
  });

  it("allows exactly the first bounded direct payment and auto-stops the second", () => {
    const usage = createCanaryUsageStore();
    assertCanaryRequestAllowed(intent, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, new Date("2026-07-13T00:00:00.000Z"));
    usage.accept(intent.amountOut);
    assert.throws(() => assertCanaryRequestAllowed(intent, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, new Date("2026-07-13T00:00:00.000Z")), /auto-stopped/i);
  });

  it("rejects non-USDC, cross-chain, and over-cap intents before a challenge", () => {
    const usage = createCanaryUsageStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, destinationChainId: 1 }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /direct Celo mainnet/i);
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, sourceTokenAddress: "0x5555555555555555555555555555555555555555" }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /USDC/i);
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, amountOut: "0.100001" }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /cap/i);
    assert.equal(DEFAULT_CANARY_CAPS.maxAcceptedLifecycles, 1);
    assert.equal(DEFAULT_CANARY_CAPS.maxExecutorGasCostWei, 50_000_000_000_000_000n);
  });

  it("makes a repeated lifecycle reservation idempotent", () => {
    const usage = createCanaryUsageStore();
    const first = usage.reserve("lifecycle_1", "tenant_1", intent.amountOut);
    const replay = usage.reserve("lifecycle_1", "tenant_1", intent.amountOut);
    assert.deepEqual(replay, first);
    assert.throws(() => usage.reserve("lifecycle_2", "tenant_1", intent.amountOut), /OFF|cap/i);
    usage.complete("lifecycle_1");
    assert.equal(usage.snapshot().tenantInFlight, 0);
  });

  it("permits exactly one audited retry when the manifest cap is two", () => {
    const retryCaps = {
      ...DEFAULT_CANARY_CAPS,
      maxAcceptedLifecycles: 2,
    };
    const usage = createCanaryUsageStore(retryCaps);

    usage.reserve("rejected_lifecycle", "tenant_1", "0.05");
    usage.complete("rejected_lifecycle");
    usage.reserve("retry_lifecycle", "tenant_1", "0.05");
    usage.complete("retry_lifecycle");

    assert.deepEqual(usage.snapshot(), {
      acceptedLifecycles: 2,
      tenantDailyAtomic: 100_000n,
      globalDailyAtomic: 100_000n,
      tenantInFlight: 0,
    });
    assert.throws(
      () => usage.reserve("third_lifecycle", "tenant_1", "0.000001"),
      /OFF|auto-stop|accepted lifecycle/i,
    );
  });
});
