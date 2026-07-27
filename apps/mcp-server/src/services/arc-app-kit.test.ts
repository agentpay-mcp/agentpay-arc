import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertReadOnlyRpcMethod,
  createArcAppKitService,
  type ArcAppKitClient,
} from "./arc-app-kit.ts";

const address = "0x1111111111111111111111111111111111111111";

describe("Arc App Kit read-only adapter", () => {
  it("delegates only to supported-chain, estimate, and balance APIs", async () => {
    const calls: string[] = [];
    const client: ArcAppKitClient = {
      getSupportedChains(operation) {
        calls.push(`chains:${operation ?? "all"}`);
        return [
          { chain: "Arc_Testnet", name: "Arc Testnet", isTestnet: true },
          { chain: "Base_Sepolia", name: "Base Sepolia", isTestnet: true },
        ];
      },
      unifiedBalance: {
        async getBalances(input) {
          calls.push("balances");
          assert.deepEqual(input, {
            token: "USDC",
            sources: { address },
            includePending: true,
            networkType: "testnet",
          });
          return {
            token: "USDC",
            totalConfirmedBalance: "12.340000",
            totalPendingBalance: "0.25",
            breakdown: [],
          };
        },
      },
      async estimateBridge(input) {
        calls.push("bridge");
        assert.equal(input.token, "USDC");
        return { fees: [{ token: "USDC", amount: "0.01", type: "protocol" }] };
      },
      async estimateSwap(input) {
        calls.push("swap");
        assert.equal(input.config.slippageBps, 75);
        return {
          stopLimit: { token: "EURC", amount: "9.8" },
          estimatedOutput: { token: "EURC", amount: "9.9" },
          fees: [{ token: "USDC", amount: "0.1", type: "provider" }],
        };
      },
    };
    const service = createArcAppKitService({
      client,
      adapterFactory: (chain, walletAddress) => ({ chain, walletAddress, readOnly: true }),
      clock: () => new Date("2026-07-27T00:00:00.000Z"),
      quoteTtlMs: 30_000,
    });

    const balances = await service.getUnifiedBalances(address, true);
    const bridge = await service.estimateBridge({
      sourceChain: "Base_Sepolia",
      destinationChain: "Arc_Testnet",
      sourceAddress: address,
      recipient: address,
      amount: "10",
    });
    const swap = await service.estimateSwap({
      chain: "Arc_Testnet",
      walletAddress: address,
      sellToken: "USDC",
      buyToken: "EURC",
      sellAmount: "10",
      slippageBps: 75,
    });

    assert.deepEqual(balances, {
      token: "USDC",
      confirmed: "12.34",
      pending: "0.25",
      pendingAvailable: true,
      breakdown: [],
    });
    assert.equal(bridge.expiresAt, "2026-07-27T00:00:30.000Z");
    assert.equal(swap.minimumReceive, "9.8");
    assert.equal(swap.estimatedReceive, "9.9");
    assert.deepEqual(calls, [
      "balances",
      "chains:bridge",
      "bridge",
      "chains:swap",
      "swap",
    ]);
    assert.equal("bridge" in client, false);
    assert.equal("swap" in client, false);
  });

  it("rejects unsupported routes and malformed provider amounts", async () => {
    const client: ArcAppKitClient = {
      getSupportedChains: () => [{ chain: "Arc_Testnet", name: "Arc Testnet", isTestnet: true }],
      unifiedBalance: {
        getBalances: async () => ({
          token: "USDC",
          totalConfirmedBalance: "secret=KIT_KEY:abc",
          breakdown: [],
        }),
      },
      estimateBridge: async () => ({ fees: [] }),
      estimateSwap: async () => ({
        stopLimit: { token: "EURC", amount: "1" },
        estimatedOutput: { token: "EURC", amount: "1" },
      }),
    };
    const service = createArcAppKitService({
      client,
      adapterFactory: () => ({ readOnly: true }),
    });

    await assert.rejects(
      service.estimateBridge({
        sourceChain: "Ethereum",
        destinationChain: "Arc_Testnet",
        sourceAddress: address,
        recipient: address,
        amount: "1",
      }),
      /Unsupported App Kit bridge chain/,
    );
    await assert.rejects(service.getUnifiedBalances(address, false), /unexpected response/);
  });

  it("rejects non-public RPC endpoints supplied by chain metadata", () => {
    const client: ArcAppKitClient = {
      getSupportedChains: () => [{
        chain: "Arc_Testnet",
        name: "Arc Testnet",
        isTestnet: true,
        type: "evm",
        chainId: 5_042_002,
        rpcEndpoints: ["http://127.0.0.1:8545"],
      }],
      unifiedBalance: { getBalances: async () => ({}) },
      estimateBridge: async () => ({}),
      estimateSwap: async () => ({}),
    };
    const service = createArcAppKitService({ client });

    assert.throws(() => service.getSupportedChains(), /public HTTPS RPC endpoint/);
  });

  it("blocks every signing and transaction RPC on the quote-only adapter", () => {
    for (const method of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_sendUserOperation",
      "eth_sendCalls",
      "eth_sign",
      "eth_signTransaction",
      "eth_signTypedData_v4",
      "eth_requestAccounts",
      "personal_sign",
      "wallet_sendCalls",
      "debug_traceCall",
    ]) {
      assert.throws(() => assertReadOnlyRpcMethod(method), /read-only/);
    }
    for (const method of [
      "eth_call",
      "eth_estimateGas",
      "eth_chainId",
      "eth_blockNumber",
      "eth_feeHistory",
      "eth_getBalance",
      "net_version",
      "web3_clientVersion",
    ]) {
      assert.doesNotThrow(() => assertReadOnlyRpcMethod(method));
    }
  });
});
