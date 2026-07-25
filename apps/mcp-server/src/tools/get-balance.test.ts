import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configureStableTokenMetadataOverrides } from "@agentpay-ai/shared-arc";

import { getBalance } from "./get-balance.ts";

describe("getBalance", () => {
  it("reads configured stablecoin balances for the active wallet", async () => {
    const walletReads: unknown[] = [];
    const reads: unknown[] = [];
    const nativeReads: unknown[] = [];

    const output = await getBalance(
      { network: "mainnet" },
      {
        wallets: {
          async getActiveWallet(request) {
            walletReads.push(request);
            return {
              ownerAddress: "0x2222222222222222222222222222222222222222",
              accountAddress: "0x3333333333333333333333333333333333333333",
              homeChainId: 42220,
              executorAddress: "0x4444444444444444444444444444444444444444",
              status: "ACTIVE",
            };
          },
        },
        tokenBalances: {
          async getTokenBalance(request) {
            reads.push(request);
            return {
              amount: request.tokenSymbol === "USDC" ? "12.5" : "3",
            };
          },
        },
        nativeBalances: {
          async getNativeBalance(request) {
            nativeReads.push(request);
            return { amount: "0.03" };
          },
        },
      },
    );

    assert.deepEqual(walletReads, [{ homeChainId: 42220 }]);
    assert.deepEqual(reads, [
      {
        accountAddress: "0x3333333333333333333333333333333333333333",
        chainId: 42220,
        tokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        tokenSymbol: "USDC",
        decimals: 6,
      },
      {
        accountAddress: "0x3333333333333333333333333333333333333333",
        chainId: 42220,
        tokenAddress: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
        tokenSymbol: "USDT",
        decimals: 6,
      },
      {
        accountAddress: "0x3333333333333333333333333333333333333333",
        chainId: 42220,
        tokenAddress: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
        tokenSymbol: "USDm",
        decimals: 18,
      },
    ]);
    assert.deepEqual(nativeReads, [
      {
        accountAddress: "0x3333333333333333333333333333333333333333",
        chainId: 42220,
        tokenSymbol: "CELO",
        decimals: 18,
      },
    ]);
    assert.deepEqual(output, {
      status: "ACTIVE",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      chainId: 42220,
      chain: "Celo",
      balances: [
        {
          tokenSymbol: "USDC",
          tokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          amount: "12.5",
          decimals: 6,
        },
        {
          tokenSymbol: "USDT",
          tokenAddress: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
          amount: "3",
          decimals: 6,
        },
        {
          tokenSymbol: "USDm",
          tokenAddress: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
          amount: "3",
          decimals: 18,
        },
      ],
      nativeBalance: {
        tokenSymbol: "CELO",
        tokenAddress: "native",
        amount: "0.03",
        decimals: 18,
      },
    });
  });

  it("allows callers to request a stablecoin subset", async () => {
    configureStableTokenMetadataOverrides({
      11142220: {
        USDC: {
          address: "0x9999999999999999999999999999999999999999",
          decimals: 6,
        },
      },
    });
    const walletReads: unknown[] = [];

    try {
      const output = await getBalance(
        { tokenSymbols: ["USDC"], homeChainId: 11142220 },
        {
          wallets: {
            async getActiveWallet(request) {
              walletReads.push(request);
              return {
                ownerAddress: "0x2222222222222222222222222222222222222222",
                accountAddress: "0x3333333333333333333333333333333333333333",
                homeChainId: 11142220,
                executorAddress: "0x4444444444444444444444444444444444444444",
                status: "ACTIVE",
              };
            },
          },
          tokenBalances: {
            async getTokenBalance() {
              return { amount: "12.5" };
            },
          },
          nativeBalances: {
            async getNativeBalance() {
              return { amount: "0.03" };
            },
          },
        },
      );

      assert.deepEqual(
        output.balances.map((balance) => balance.tokenSymbol),
        ["USDC"],
      );
      assert.deepEqual(walletReads, [{ homeChainId: 11142220 }]);
    } finally {
      configureStableTokenMetadataOverrides({});
    }
  });

  it("returns NOT_CREATED when no active wallet exists", async () => {
    const output = await getBalance(
      {},
      {
        wallets: {
          async getActiveWallet() {
            return null;
          },
        },
        tokenBalances: {
          async getTokenBalance() {
            throw new Error("balance reader should not be called");
          },
        },
        nativeBalances: {
          async getNativeBalance() {
            throw new Error("native balance reader should not be called");
          },
        },
      },
    );

    assert.deepEqual(output, {
      status: "NOT_CREATED",
      accountAddress: null,
      ownerAddress: null,
      chainId: null,
      chain: null,
      balances: [],
      nativeBalance: null,
    });
  });
});
