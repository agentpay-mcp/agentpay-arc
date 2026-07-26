import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARC_TESTNET, ARC_TESTNET_CCTP_DOMAIN, ARC_TESTNET_USDC } from "./arc.ts";

describe("Arc network foundation", () => {
  it("describes Circle's Arc Testnet identifiers", () => {
    assert.deepEqual(ARC_TESTNET, {
      chainId: 5042002,
      caip2: "eip155:5042002",
      circleChain: "ARC-TESTNET",
      name: "Arc Testnet",
      nativeCurrency: {
        symbol: "USDC",
        decimals: 18,
      },
      rpcUrl: "https://rpc.testnet.arc.io",
      websocketUrl: "wss://rpc.testnet.arc.io",
      explorerUrl: "https://testnet.arcscan.app",
      usdcAddress: "0x3600000000000000000000000000000000000000",
      usdcDecimals: 6,
      cctpDomain: 26,
    });
    assert.equal(ARC_TESTNET_CCTP_DOMAIN, 26);
  });

  it("keeps native and ERC-20 USDC views distinct but non-additive", () => {
    assert.deepEqual(ARC_TESTNET_USDC, {
      symbol: "USDC",
      native: {
        decimals: 18,
      },
      erc20: {
        address: "0x3600000000000000000000000000000000000000",
        decimals: 6,
      },
      balanceSemantics: {
        sameUnderlyingBalance: true,
        sumViews: false,
      },
    });
  });
});
