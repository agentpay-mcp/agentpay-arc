import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import {
  AGENTPAY_ARC_PUBLIC_URLS,
  AGENTPAY_CELO_PUBLIC_URLS,
  ARC_NETWORKS,
  CELO_NETWORKS,
  getNativeCurrency,
  networkSelectionShape,
} from "./chains.ts";

describe("getNativeCurrency", () => {
  it("returns native currency metadata for supported chains", () => {
    assert.deepEqual(getNativeCurrency(196), {
      symbol: "OKB",
      decimals: 18,
    });
    assert.deepEqual(getNativeCurrency(1952), {
      symbol: "OKB",
      decimals: 18,
    });
    assert.deepEqual(getNativeCurrency(42220), {
      symbol: "CELO",
      decimals: 18,
    });
    assert.deepEqual(getNativeCurrency(11142220), {
      symbol: "CELO",
      decimals: 18,
    });
    assert.deepEqual(getNativeCurrency(5042002), {
      symbol: "USDC",
      decimals: 18,
    });
  });

  it("throws for unsupported chains", () => {
    assert.throws(() => getNativeCurrency(1), /Unsupported chain 1/);
  });

  it("accepts only Celo network selectors for AgentPay Celo inputs", () => {
    const schema = z.object(networkSelectionShape);

    assert.deepEqual(schema.parse({ network: "mainnet", homeChainId: 42220 }), {
      network: "mainnet",
      homeChainId: 42220,
    });
    assert.deepEqual(schema.parse({ network: "testnet", homeChainId: 11142220 }), {
      network: "testnet",
      homeChainId: 11142220,
    });
    assert.throws(() => schema.parse({ homeChainId: 196 }));
    assert.throws(() => schema.parse({ homeChainId: 1952 }));
  });

  it("pins the isolated Celo production network and public paths", () => {
    assert.deepEqual(CELO_NETWORKS.mainnet, {
      chainId: 42220,
      caip2: "eip155:42220",
      name: "Celo Mainnet",
      nativeCurrency: { symbol: "CELO", decimals: 18 },
      rpcEnvName: "CELO_MAINNET_RPC_URL",
      fallbackRpcEnvName: "CELO_MAINNET_RPC_FALLBACK_URL",
      explorerUrl: "https://celoscan.io",
    });
    assert.deepEqual(AGENTPAY_CELO_PUBLIC_URLS, {
      consumerMcp: "https://wallet.agentpay.site/celo/mcp",
      paidMcp: "https://mcp.agentpay.site/celo/mcp",
      setup: "https://wallet.agentpay.site/celo/setup",
      review: "https://wallet.agentpay.site/celo/review",
    });
  });

  it("pins the isolated Arc testnet and public paths", () => {
    assert.deepEqual(ARC_NETWORKS.testnet, {
      chainId: 5042002,
      caip2: "eip155:5042002",
      circleChain: "ARC-TESTNET",
      name: "Arc Testnet",
      nativeCurrency: { symbol: "USDC", decimals: 18 },
      rpcUrl: "https://rpc.testnet.arc.network",
      wsRpcUrl: "wss://rpc.testnet.arc.network",
      explorerUrl: "https://testnet.arcscan.app",
    });
    assert.deepEqual(AGENTPAY_ARC_PUBLIC_URLS, {
      consumerMcp: "https://wallet.agentpay.site/arc/mcp",
      paidMcp: "https://mcp.agentpay.site/arc/mcp",
      setup: "https://wallet.agentpay.site/arc/setup",
      review: "https://wallet.agentpay.site/arc/review",
    });
  });
});
