import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_GATEWAY_FACILITATOR_URL,
  ARC_TESTNET_CAIP2,
  arcPaidServiceRequestSchema,
  createArcPaidServiceQuoteBinding,
  formatArcX402UsdcAtomic,
  parseArcPaidServiceProof,
} from "./x402-commerce.ts";

describe("Arc x402 commerce model", () => {
  it("binds an inspected quote to the exact safe request and six-decimal amount", () => {
    const request = arcPaidServiceRequestSchema.parse({
      url: "https://seller.example/v1/report",
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{\"topic\":\"arc\"}",
    });
    const binding = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: "0x2222222222222222222222222222222222222222",
      inspectedAt: "2026-07-27T01:00:00.000Z",
      expiresAt: "2026-07-27T01:05:00.000Z",
    });

    assert.equal(binding.network, ARC_TESTNET_CAIP2);
    assert.equal(binding.facilitatorUrl, ARC_GATEWAY_FACILITATOR_URL);
    assert.equal(binding.amount, "1.25");
    assert.match(binding.requestHash, /^0x[a-f0-9]{64}$/);
    assert.match(binding.quoteHash, /^0x[a-f0-9]{64}$/);
    assert.equal(formatArcX402UsdcAtomic("1"), "0.000001");
  });

  it("rejects SSRF destinations, unsafe headers, oversized bodies, and imprecise amounts", () => {
    for (const input of [
      { url: "http://seller.example/report" },
      { url: "https://127.0.0.1/report" },
      { url: "https://metadata.google.internal/report" },
      { url: "https://[fd00::1]/report" },
      { url: "https://[fe80::1]/report" },
      { url: "https://[::ffff:127.0.0.1]/report" },
      { url: "https://seller.example/report", headers: { Authorization: "Bearer secret" } },
      { url: "https://seller.example/report", body: "x".repeat(65_537) },
    ]) {
      assert.throws(() => arcPaidServiceRequestSchema.parse(input));
    }
    assert.throws(() => formatArcX402UsdcAtomic("1.2"));
  });

  it("keeps only bounded Arc/Gateway settlement proof and excludes signatures", () => {
    const proof = parseArcPaidServiceProof({
      network: ARC_TESTNET_CAIP2,
      scheme: "exact",
      seller: "0x2222222222222222222222222222222222222222",
      transaction: `0x${"a".repeat(64)}`,
      payer: "0x1111111111111111111111111111111111111111",
      signature: `0x${"b".repeat(130)}`,
      credential: "must-not-survive",
    });

    assert.deepEqual(proof, {
      network: ARC_TESTNET_CAIP2,
      scheme: "exact",
      seller: "0x2222222222222222222222222222222222222222",
      transaction: `0x${"a".repeat(64)}`,
      payer: "0x1111111111111111111111111111111111111111",
    });
    assert.doesNotMatch(JSON.stringify(proof), /signature|credential/i);
  });
});
