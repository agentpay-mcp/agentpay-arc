import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  configureStableTokenMetadataOverrides,
  getStableTokenAddress,
  getStableTokenDecimalsForChain,
  getStableTokenMetadata,
} from "./tokens.ts";

describe("stable token metadata", () => {
  it("returns X Layer USDt0 and USDC metadata", () => {
    assert.deepEqual(getStableTokenMetadata(196, "USDT0"), {
      symbol: "USDT0",
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(196, "USDC"), {
      symbol: "USDC",
      address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
      decimals: 6,
    });
    assert.equal(getStableTokenAddress(196, "USDT"), "0x779Ded0c9e1022225f8E0630b35a9b54bE713736");
    assert.equal(getStableTokenDecimalsForChain(196, "USDT0"), 6);
  });

  it("keeps Base stablecoin decimals distinct from X Layer", () => {
    assert.equal(getStableTokenDecimalsForChain(8453, "USDC"), 6);
    assert.equal(getStableTokenAddress(8453, "USDC"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("returns canonical Celo mainnet x402 stablecoin metadata", () => {
    assert.deepEqual(getStableTokenMetadata(42220, "USDC"), {
      symbol: "USDC",
      address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(42220, "USDT"), {
      symbol: "USDT",
      address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(42220, "USDm"), {
      symbol: "USDm",
      address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
      decimals: 18,
    });
  });

  it("returns canonical Celo Sepolia stablecoin metadata", () => {
    assert.deepEqual(getStableTokenMetadata(11142220, "USDC"), {
      symbol: "USDC",
      address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(11142220, "USDT"), {
      symbol: "USDT",
      address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(11142220, "USDm"), {
      symbol: "USDm",
      address: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b",
      decimals: 18,
    });
  });

  it("returns Arc Testnet's ERC-20 view of native USDC", () => {
    assert.deepEqual(getStableTokenMetadata(5042002, "USDC"), {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(5042002, "EURC"), {
      symbol: "EURC",
      address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      decimals: 6,
    });
  });

  it("returns X Layer testnet faucet stablecoin metadata", () => {
    assert.deepEqual(getStableTokenMetadata(1952, "USDT0"), {
      symbol: "USDT0",
      address: "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c",
      decimals: 6,
    });
    assert.deepEqual(getStableTokenMetadata(1952, "USDC"), {
      symbol: "USDC",
      address: "0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D",
      decimals: 6,
    });
    assert.equal(getStableTokenAddress(1952, "USDT"), "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c");
  });

  it("can override X Layer testnet token addresses for hackathon demos", () => {
    configureStableTokenMetadataOverrides({
      1952: {
        USDT0: {
          address: "0x1111111111111111111111111111111111111111",
        },
        USDC: {
          address: "0x2222222222222222222222222222222222222222",
        },
      },
    });

    try {
      assert.deepEqual(getStableTokenMetadata(1952, "USDT0"), {
        symbol: "USDT0",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 6,
      });
      assert.deepEqual(getStableTokenMetadata(1952, "USDC"), {
        symbol: "USDC",
        address: "0x2222222222222222222222222222222222222222",
        decimals: 6,
      });
    } finally {
      configureStableTokenMetadataOverrides({});
    }
  });

  it("throws for unsupported token metadata", () => {
    assert.throws(() => getStableTokenMetadata(1, "USDT"), /Unsupported stable token USDT on chain 1/);
  });
});
