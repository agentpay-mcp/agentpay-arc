import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CircleAgentWallet,
  CircleGatewayBalance,
  CircleSessionStatus,
  CircleWalletBalance,
} from "@agentpay-ai/shared-arc";

import { CircleCliCommandError, type CircleCli } from "../services/circle-cli.ts";
import {
  createFundAgentWalletHandler,
  createGetAgentBudgetHandler,
  createSetupAgentWalletHandler,
  createWithdrawAgentBudgetHandler,
  fundAgentWalletTool,
  getAgentBudgetTool,
  setupAgentWalletTool,
  withdrawAgentBudgetTool,
} from "./circle-agent-wallet.ts";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ARC_USDC = "0x3600000000000000000000000000000000000000";

const validSession: CircleSessionStatus = {
  type: "agent",
  mainnet: { tokenStatus: "NOT_LOGGED_IN" },
  testnet: {
    email: "builder@example.com",
    tokenStatus: "VALID",
    expiresIn: "6d 23h",
  },
};

const walletA: CircleAgentWallet = {
  address: WALLET_A,
  type: "agent",
  blockchain: "ARC-TESTNET",
};

const gatewayBalance: CircleGatewayBalance = {
  message: "Gateway balance: 1.660001 USDC",
  address: WALLET_A,
  backingEOA: WALLET_B,
  total: "1.660001",
  token: "USDC",
  balances: [{ network: "Arc Testnet", domain: 26, balance: "1.660001" }],
};

const duplicateArcBalanceViews: CircleWalletBalance = {
  balances: [
    {
      amount: "12.34",
      token: {
        name: "USDC",
        symbol: "USDC",
        blockchain: "ARC-TESTNET",
        decimals: 18,
        isNative: true,
      },
    },
    {
      amount: "12.34",
      token: {
        name: "USD Coin",
        symbol: "USDC",
        blockchain: "ARC-TESTNET",
        decimals: 6,
        isNative: false,
        tokenAddress: ARC_USDC,
      },
    },
  ],
};

describe("Circle Agent Wallet tools", () => {
  it("publishes four narrow tools without email, OTP, or Terms inputs", () => {
    assert.deepEqual(
      [
        setupAgentWalletTool.name,
        getAgentBudgetTool.name,
        fundAgentWalletTool.name,
        withdrawAgentBudgetTool.name,
      ],
      [
        "setup_agent_wallet",
        "get_agent_budget",
        "fund_agent_wallet",
        "withdraw_agent_budget",
      ],
    );

    for (const tool of [
      setupAgentWalletTool,
      getAgentBudgetTool,
      fundAgentWalletTool,
      withdrawAgentBudgetTool,
    ]) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      assert.equal("email" in properties, false);
      assert.equal("otp" in properties, false);
      assert.equal("acceptTerms" in properties, false);
    }
  });

  it("maps manual authentication and Terms states without accepting secrets", async () => {
    const loginRequired = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => {
          throw new CircleCliCommandError("AUTH_REQUIRED");
        },
      }),
    });
    const termsRequired = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => {
          throw new CircleCliCommandError("TERMS_REQUIRED");
        },
      }),
    });
    const expired = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => ({
          ...validSession,
          testnet: { tokenStatus: "EXPIRED" },
        }),
      }),
    });

    assert.equal((await loginRequired({})).status, "LOGIN_REQUIRED");
    assert.equal((await termsRequired({})).status, "TERMS_REQUIRED");
    assert.equal((await expired({})).status, "LOGIN_REQUIRED");
    await assert.rejects(() => loginRequired({ otp: "B1X-123456" }), /unrecognized|invalid|otp/i);
    await assert.rejects(() => termsRequired({ acceptTerms: true }), /unrecognized|invalid|terms/i);
  });

  it("reports WALLET_REQUIRED or READY from the authenticated Arc wallet list", async () => {
    const missing = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => validSession,
        listAgentWallets: async () => [],
      }),
    });
    const ready = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => validSession,
        listAgentWallets: async () => [walletA],
      }),
    });

    assert.equal((await missing({})).status, "WALLET_REQUIRED");
    assert.deepEqual(await ready({}), {
      status: "READY",
      chain: "ARC-TESTNET",
      wallets: [walletA],
      selectedWalletAddress: WALLET_A,
      instructionToAgent:
        "The Circle Agent Wallet is ready. Its funded USDC balance is the autonomous AgentPay budget.",
    });
  });

  it("returns all safe wallet addresses before requiring a multi-wallet selection", async () => {
    const ready = createSetupAgentWalletHandler({
      circleCli: fakeCircleCli({
        status: async () => validSession,
        listAgentWallets: async () => [walletA, { ...walletA, address: WALLET_B }],
      }),
    });

    assert.deepEqual(await ready({}), {
      status: "READY",
      chain: "ARC-TESTNET",
      wallets: [walletA, { ...walletA, address: WALLET_B }],
      selectedWalletAddress: null,
      instructionToAgent:
        "Multiple Circle Agent Wallets are ready. Ask the user which listed walletAddress to use.",
    });
  });

  it("fails closed for ambiguous or foreign wallet selection", async () => {
    const handler = createGetAgentBudgetHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA, { ...walletA, address: WALLET_B }],
      }),
    });

    await assert.rejects(() => handler({}), /walletAddress.*multiple/i);
    await assert.rejects(
      () => handler({ walletAddress: RECIPIENT }),
      /authenticated Circle Agent Wallet/i,
    );
  });

  it("uses the canonical six-decimal Arc USDC view and exact Gateway addition", async () => {
    const handler = createGetAgentBudgetHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA],
        getBalance: async () => duplicateArcBalanceViews,
        getGatewayBalance: async () => gatewayBalance,
      }),
    });

    assert.deepEqual(await handler({}), {
      status: "READY",
      walletAddress: WALLET_A,
      chain: "ARC-TESTNET",
      onchainUsdc: "12.34",
      gatewayConfirmedUsdc: "1.660001",
      gatewayPendingUsdc: null,
      pendingSource: "NOT_AVAILABLE_FROM_CIRCLE_CLI",
      autonomousBudgetUsdc: "14.000001",
    });
  });

  it("normalizes an 18-decimal native-only Arc USDC fallback without losing value", async () => {
    const handler = createGetAgentBudgetHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA],
        getBalance: async () => ({
          balances: [{
            amount: "1.230000000000000000",
            token: {
              name: "USDC",
              symbol: "USDC",
              blockchain: "ARC-TESTNET",
              decimals: 18,
              isNative: true,
            },
          }],
        }),
        getGatewayBalance: async () => ({ ...gatewayBalance, total: "0" }),
      }),
    });

    assert.equal((await handler({})).onchainUsdc, "1.23");
  });

  it("funds the selected testnet wallet exactly once", async () => {
    let calls = 0;
    const funding = {
      message: "Wallet funded",
      address: WALLET_A,
      blockchain: "ARC-TESTNET" as const,
      token: "USDC",
    };
    const handler = createFundAgentWalletHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA],
        fundFromFaucet: async (address) => {
          calls += 1;
          assert.equal(address, WALLET_A);
          return funding;
        },
      }),
    });

    assert.deepEqual(await handler({}), {
      status: "SUBMITTED",
      walletAddress: WALLET_A,
      chain: "ARC-TESTNET",
      funding,
    });
    assert.equal(calls, 1);
  });

  it("validates exact USDC amounts and requires an onchain recipient", async () => {
    const handler = createWithdrawAgentBudgetHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA],
      }),
    });

    await assert.rejects(() => handler({ amount: "0", recipient: RECIPIENT }), /positive/i);
    await assert.rejects(
      () => handler({ amount: "1.0000001", recipient: RECIPIENT }),
      /six|decimal|precision/i,
    );
    await assert.rejects(() => handler({ amount: "1" }), /recipient/i);
  });

  it("withdraws onchain or Gateway funds exactly once with safe defaults", async () => {
    const transferInputs: unknown[] = [];
    const gatewayInputs: unknown[] = [];
    const transaction = {
      id: "tx_123",
      state: "COMPLETE",
      blockchain: "ARC-TESTNET" as const,
      txHash: `0x${"a".repeat(64)}`,
    };
    const withdrawal = {
      message: "Withdrawal complete",
      amount: "1.5",
      sourceAddress: WALLET_A,
      backingEOA: WALLET_B,
      sourceBlockchain: "ARC-TESTNET" as const,
      destinationBlockchain: "ARC-TESTNET" as const,
      recipient: WALLET_A,
      transferId: "transfer_123",
      mintTxHash: `0x${"b".repeat(64)}`,
    };
    const circleCli = fakeCircleCli({
      listAgentWallets: async () => [walletA],
      transfer: async (input) => {
        transferInputs.push(input);
        return transaction;
      },
      withdrawGateway: async (input) => {
        gatewayInputs.push(input);
        return withdrawal;
      },
    });

    const handler = createWithdrawAgentBudgetHandler({ circleCli });
    const onchain = await handler({ amount: "2.5", recipient: RECIPIENT });
    const gateway = await handler({ amount: "1.5", source: "GATEWAY" });

    assert.deepEqual(transferInputs, [{
      address: WALLET_A,
      amount: "2.5",
      recipient: RECIPIENT,
    }]);
    assert.deepEqual(gatewayInputs, [{
      address: WALLET_A,
      amount: "1.5",
      recipient: WALLET_A,
    }]);
    assert.equal(onchain.source, "ONCHAIN");
    assert.equal(gateway.source, "GATEWAY");
  });

  it("never retries a failed mutation", async () => {
    let attempts = 0;
    const handler = createWithdrawAgentBudgetHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [walletA],
        transfer: async () => {
          attempts += 1;
          throw new CircleCliCommandError("TRANSIENT");
        },
      }),
    });

    await assert.rejects(
      () => handler({ amount: "1", recipient: RECIPIENT }),
      /temporarily unavailable/i,
    );
    assert.equal(attempts, 1);
  });
});

function fakeCircleCli(overrides: Partial<CircleCli>): CircleCli {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected Circle CLI call.");
  };

  return {
    status: unavailable,
    listAgentWallets: unavailable,
    getBalance: unavailable,
    fundFromFaucet: unavailable,
    transfer: unavailable,
    swap: unavailable,
    executeContract: unavailable,
    searchServices: unavailable,
    inspectService: unavailable,
    payService: unavailable,
    getGatewayBalance: unavailable,
    depositGateway: unavailable,
    withdrawGateway: unavailable,
    bridge: unavailable,
    ...overrides,
  } as CircleCli;
}
