import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getBalanceInputSchema } from "./balance.ts";

describe("getBalanceInputSchema", () => {
  it("defaults to Arc USDC balance", () => {
    assert.deepEqual(getBalanceInputSchema.parse({}), {
      tokenSymbols: ["USDC"],
    });
  });

  it("accepts an explicit stablecoin subset", () => {
    assert.deepEqual(getBalanceInputSchema.parse({ tokenSymbols: ["USDC"] }), {
      tokenSymbols: ["USDC"],
    });
  });

  it("accepts only Arc Testnet selectors and USDC", () => {
    assert.deepEqual(getBalanceInputSchema.parse({ homeChainId: 5042002, network: "testnet" }), {
      tokenSymbols: ["USDC"],
      homeChainId: 5042002,
      network: "testnet",
    });
    assert.throws(() => getBalanceInputSchema.parse({ homeChainId: 42220 }));
    assert.throws(() => getBalanceInputSchema.parse({ homeChainId: 11142220 }));
    assert.throws(() => getBalanceInputSchema.parse({ tokenSymbols: ["USDT"] }));
    assert.throws(() => getBalanceInputSchema.parse({ tokenSymbols: ["USDT0"] }));
  });
});
