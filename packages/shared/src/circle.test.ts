import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  circleAgentWalletSchema,
  circleBridgeInputSchema,
  circleContractExecutionInputSchema,
  circleGatewayBalanceSchema,
  circleSessionStatusSchema,
  circleServicePaymentInputSchema,
  circleServiceSearchInputSchema,
  circleSwapInputSchema,
  circleTransactionResultSchema,
  circleTransferInputSchema,
  circleWalletBalanceSchema,
} from "./circle.ts";

describe("Circle schemas", () => {
  it("parses an Arc Agent Wallet and balance response", () => {
    assert.deepEqual(
      circleAgentWalletSchema.parse({
        address: "0x1111111111111111111111111111111111111111",
        type: "agent",
        blockchain: "ARC-TESTNET",
      }),
      {
        address: "0x1111111111111111111111111111111111111111",
        type: "agent",
        blockchain: "ARC-TESTNET",
      },
    );

    assert.deepEqual(
      circleWalletBalanceSchema.parse({
        balances: [{
          amount: "12.34",
          token: {
            name: "USD Coin",
            symbol: "USDC",
            blockchain: "ARC-TESTNET",
            decimals: 6,
            isNative: false,
            tokenAddress: "0x3600000000000000000000000000000000000000",
          },
        }],
      }),
      {
        balances: [{
          amount: "12.34",
          token: {
            name: "USD Coin",
            symbol: "USDC",
            blockchain: "ARC-TESTNET",
            decimals: 6,
            isNative: false,
            tokenAddress: "0x3600000000000000000000000000000000000000",
          },
        }],
      },
    );
  });

  it("parses the Circle CLI 0.0.6 status, transaction, and Gateway balance shapes", () => {
    assert.equal(
      circleSessionStatusSchema.parse({
        type: "agent",
        mainnet: { tokenStatus: "NOT_LOGGED_IN" },
        testnet: {
          email: "builder@example.com",
          tokenStatus: "VALID",
          expiresIn: "6d 23h",
        },
      }).testnet.tokenStatus,
      "VALID",
    );

    assert.equal(
      circleTransactionResultSchema.parse({
        id: "tx_123",
        state: "COMPLETE",
        blockchain: "ARC-TESTNET",
        txHash: `0x${"a".repeat(64)}`,
      }).txHash,
      `0x${"a".repeat(64)}`,
    );

    assert.equal(
      circleGatewayBalanceSchema.parse({
        message: "Gateway balance: 1 USDC",
        address: "0x1111111111111111111111111111111111111111",
        backingEOA: "0x2222222222222222222222222222222222222222",
        total: "1",
        token: "USDC",
        balances: [{ network: "Arc Testnet", domain: 26, balance: "1" }],
      }).total,
      "1",
    );
  });

  it("rejects private keys and secret-bearing service fields", () => {
    const privateKey = `0x${"a".repeat(64)}`;

    assert.throws(
      () =>
        circleTransferInputSchema.parse({
          recipient: privateKey,
          amount: "1",
          address: "0x1111111111111111111111111111111111111111",
        }),
      /private key|address/i,
    );

    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address: "0x1111111111111111111111111111111111111111",
          maxAmount: "1",
          headers: {
            Authorization: "Bearer secret-token",
          },
        }),
      /secret|credential|header/i,
    );

    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address: "0x1111111111111111111111111111111111111111",
          maxAmount: "1",
          body: "mnemonic: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        }),
      /mnemonic|seed|secret/i,
    );

    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address: "0x1111111111111111111111111111111111111111",
          maxAmount: "1",
          body: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        }),
      /mnemonic|seed|secret/i,
    );
  });

  it("rejects OTP-shaped and seed-labeled data even when nested in headers or bodies", () => {
    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address: "0x1111111111111111111111111111111111111111",
          maxAmount: "1",
          headers: {
            "X-Login-Code": "OTP: 123456",
          },
        }),
      /OTP|secret|credential/i,
    );

    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address: "0x1111111111111111111111111111111111111111",
          maxAmount: "1",
          body: "seed phrase=correct horse battery staple",
        }),
      /seed|secret/i,
    );
  });

  it("rejects unsafe URL credentials, non-HTTPS services, zero spend, and null bytes", () => {
    const base = {
      address: "0x1111111111111111111111111111111111111111",
      maxAmount: "1",
    };

    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          ...base,
          url: "http://merchant.example/resource",
        }),
      /HTTPS/i,
    );
    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          ...base,
          url: "https://user:password@merchant.example/resource",
        }),
      /credential|secret/i,
    );
    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          ...base,
          url: "https://merchant.example/resource",
          maxAmount: "0.000",
        }),
      /positive/i,
    );
    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          ...base,
          url: "https://merchant.example/resource",
          body: "safe\0unsafe",
        }),
      /null byte/i,
    );
  });

  it("rejects positional option injection and HTTP header control characters", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";

    assert.throws(
      () =>
        circleSwapInputSchema.parse({
          sellToken: "--chain",
          sellAmount: "1",
          buyToken: "USDC",
          minimumBuy: "1",
          address,
          idempotencyKey,
        }),
      /option|positional|hyphen/i,
    );
    assert.throws(
      () =>
        circleContractExecutionInputSchema.parse({
          address,
          contract: "0x2222222222222222222222222222222222222222",
          functionSignature: "approve(address,uint256)",
          parameters: ["--amount", "1"],
        }),
      /option|positional|hyphen/i,
    );
    assert.throws(
      () =>
        circleBridgeInputSchema.parse({
          destination: "--chain",
          recipient: "0x2222222222222222222222222222222222222222",
          amount: "1",
          address,
          idempotencyKey,
        }),
      /option|positional|hyphen/i,
    );
    assert.throws(
      () => circleServiceSearchInputSchema.parse({ query: "--limit" }),
      /option|positional|hyphen/i,
    );
    assert.throws(
      () =>
        circleServicePaymentInputSchema.parse({
          url: "https://merchant.example/resource",
          address,
          maxAmount: "1",
          headers: {
            "X-Agent-Request": "ok\r\nX-Injected: yes",
          },
        }),
      /control|header/i,
    );
  });
});
