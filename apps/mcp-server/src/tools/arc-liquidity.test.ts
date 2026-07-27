import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CircleCli } from "../services/circle-cli.ts";
import type { ArcAppKitService } from "../services/arc-app-kit.ts";
import {
  createInMemoryArcLiquidityRepository,
  getUnifiedBalance,
  bridgeUsdc,
  fundFromAnyChain,
  swapAndPay,
  swapTokens,
  type ArcLiquidityDependencies,
  type ArcLiquidityRepository,
} from "./arc-liquidity.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;
const uuid = "11111111-1111-4111-8111-111111111111";

function dependencies(overrides: Partial<ArcLiquidityDependencies> = {}): ArcLiquidityDependencies {
  const circleCli = {
    listAgentWallets: async () => [{ address: wallet, type: "agent", blockchain: "ARC-TESTNET" }],
    getBalance: async () => ({
      balances: [
        {
          amount: "4",
          token: {
            name: "native USDC",
            symbol: "USDC",
            blockchain: "ARC-TESTNET",
            decimals: 18,
            isNative: true,
          },
        },
        {
          amount: "12.500000",
          token: {
            name: "USDC",
            symbol: "USDC",
            blockchain: "ARC-TESTNET",
            decimals: 6,
            isNative: false,
            tokenAddress: "0x3600000000000000000000000000000000000000",
          },
        },
      ],
    }),
    bridge: async () => ({
      message: "ok",
      traceId: "trace-1",
      transferId: "transfer-1",
      burnTxHash: hash,
      forwardTxHash: `0x${"f".repeat(64)}`,
      fromChain: "ARC-TESTNET",
      toChain: "Base_Sepolia",
      amount: "2",
      status: "complete",
      transactions: [{ id: "bridge-1", state: "COMPLETE", blockchain: "ARC-TESTNET", txHash: hash }],
    }),
    swap: async () => ({
      message: "ok",
      sellToken: "0x3600000000000000000000000000000000000000",
      sellAmount: "10",
      buyToken: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      buyMin: "9.8",
      chain: "ARC-TESTNET",
      transactions: [{ id: "swap-1", state: "COMPLETE", blockchain: "ARC-TESTNET", txHash: hash }],
    }),
  } as unknown as CircleCli;
  const appKit: ArcAppKitService = {
    getSupportedChains: () => [
      { chain: "Arc_Testnet", name: "Arc Testnet", isTestnet: true },
      { chain: "Base_Sepolia", name: "Base Sepolia", isTestnet: true },
    ],
    getUnifiedBalances: async () => ({
      token: "USDC",
      confirmed: "7.25",
      pending: null,
      pendingAvailable: false,
      breakdown: [],
    }),
    estimateBridge: async () => ({
      token: "USDC",
      sourceChain: "Arc_Testnet",
      destinationChain: "Base_Sepolia",
      amount: "2",
      fees: [],
      quotedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-07-27T00:05:00.000Z",
    }),
    estimateSwap: async (input) => ({
      chain: "Arc_Testnet",
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount,
      minimumReceive: "9.8",
      estimatedReceive: "9.9",
      fees: [],
      quotedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-07-27T00:05:00.000Z",
    }),
  };
  return {
    circleCli,
    appKit,
    operations: createInMemoryArcLiquidityRepository(),
    clock: () => new Date("2026-07-27T00:01:00.000Z"),
    settlementVerifier: { verify: async () => ({ status: "UNAVAILABLE" }) },
    paymentExecutor: { pay: async () => ({ transactionHash: hash }) },
    ...overrides,
  };
}

describe("Arc liquidity tools", () => {
  it("uses canonical Arc ERC-20 USDC once and keeps Gateway pending unavailable", async () => {
    const result = await getUnifiedBalance({}, dependencies());
    assert.deepEqual(result, {
      status: "READY",
      walletAddress: wallet,
      onchainArcUsdc: "12.5",
      gatewayConfirmedUsdc: "7.25",
      gatewayPendingUsdc: null,
      gatewayPendingAvailable: false,
      confirmedAvailableUsdc: "19.75",
    });
  });

  it("quotes funding from a supported source without invoking a custody write", async () => {
    let mutations = 0;
    const deps = dependencies({
      circleCli: {
        ...dependencies().circleCli,
        bridge: async () => {
          mutations += 1;
          throw new Error("must not execute");
        },
      } as CircleCli,
    });
    const result = await fundFromAnyChain(
      {
        sourceChain: "Base_Sepolia",
        sourceAddress: recipient,
        amount: "5",
        walletAddress: wallet,
      },
      deps,
    );
    assert.equal(result.status, "SOURCE_ACTION_REQUIRED");
    assert.equal(mutations, 0);
  });

  it("rejects non-USDC bridges and stale bridge quotes before a write", async () => {
    let writes = 0;
    const deps = dependencies({
      circleCli: {
        ...dependencies().circleCli,
        bridge: async () => {
          writes += 1;
          throw new Error("unexpected");
        },
      } as CircleCli,
      clock: () => new Date("2026-07-27T00:10:00.000Z"),
    });
    await assert.rejects(
      bridgeUsdc(
        {
          idempotencyKey: uuid,
          destinationChain: "Base_Sepolia",
          recipient,
          amount: "2",
          token: "EURC",
          minimumReceive: "2",
          slippageBps: 0,
        },
        deps,
      ),
    );
    await assert.rejects(
      bridgeUsdc(
        {
          idempotencyKey: uuid,
          destinationChain: "Base_Sepolia",
          recipient,
          amount: "2",
          token: "USDC",
          minimumReceive: "2",
          slippageBps: 0,
        },
        deps,
      ),
      /expired/,
    );
    assert.equal(writes, 0);
  });

  it("bridges exact USDC once and refuses unenforceable receive slippage", async () => {
    let writes = 0;
    const base = dependencies();
    const deps = dependencies({
      circleCli: {
        ...base.circleCli,
        bridge: async (input) => {
          writes += 1;
          return await dependencies().circleCli.bridge(input);
        },
      } as CircleCli,
    });
    await assert.rejects(
      bridgeUsdc({
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        destinationChain: "Base_Sepolia",
        recipient,
        amount: "2",
        minimumReceive: "1.99",
        slippageBps: 50,
      }, deps),
      /exact receive/,
    );
    const result = await bridgeUsdc({
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      destinationChain: "Base_Sepolia",
      recipient,
      amount: "2",
      minimumReceive: "2",
      slippageBps: 0,
    }, deps);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.operation.steps[0]?.name, "BRIDGE");
    assert.equal(result.operation.steps[0]?.transactionHash, hash);
    assert.equal(result.operation.steps[0]?.burnTransactionHash, hash);
    assert.equal(result.operation.steps[0]?.forwardTransactionHash, `0x${"f".repeat(64)}`);
    assert.equal(result.operation.steps[0]?.traceId, "trace-1");
    assert.equal(result.operation.steps[0]?.transferId, "transfer-1");
    assert.equal(result.operation.steps[0]?.arcscanUrl, `https://testnet.arcscan.app/tx/${hash}`);
    assert.equal(writes, 1);
  });

  it("validates Arc swap assets, slippage, and minimum receive with bigint arithmetic", async () => {
    let writes = 0;
    const deps = dependencies({
      circleCli: {
        ...dependencies().circleCli,
        swap: async (input) => {
          writes += 1;
          return await dependencies().circleCli.swap(input);
        },
      } as CircleCli,
    });
    await assert.rejects(
      swapTokens(
        {
          idempotencyKey: uuid,
          sellToken: "USDT",
          buyToken: "EURC",
          sellAmount: "10",
          minimumReceive: "9.8",
          slippageBps: 100,
        },
        deps,
      ),
    );
    await assert.rejects(
      swapTokens(
        {
          idempotencyKey: uuid,
          sellToken: "USDC",
          buyToken: "EURC",
          sellAmount: "10",
          minimumReceive: "10",
          slippageBps: 100,
        },
        deps,
      ),
      /minimumReceive exceeds/,
    );
    const result = await swapTokens(
      {
        idempotencyKey: uuid,
        sellToken: "USDC",
        buyToken: "EURC",
        sellAmount: "10",
        minimumReceive: "9.8",
        slippageBps: 100,
      },
      deps,
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(writes, 1);
  });

  it("replays and concurrently claims a swap exactly once", async () => {
    let writes = 0;
    const base = dependencies();
    const deps = dependencies({
      operations: base.operations,
      circleCli: {
        ...base.circleCli,
        swap: async (input) => {
          writes += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return await dependencies().circleCli.swap(input);
        },
      } as CircleCli,
    });
    const input = {
      idempotencyKey: uuid,
      sellToken: "USDC",
      buyToken: "EURC",
      sellAmount: "10",
      minimumReceive: "9.8",
      slippageBps: 100,
    };
    const [first, second] = await Promise.all([swapTokens(input, deps), swapTokens(input, deps)]);
    assert.equal(writes, 1);
    assert.ok(["COMPLETED", "SUBMITTING"].includes(first.status));
    assert.ok(["COMPLETED", "SUBMITTING"].includes(second.status));
  });

  it("returns persisted replay state without requiring a fresh quote", async () => {
    let writes = 0;
    let current = new Date("2026-07-27T00:01:00.000Z");
    const base = dependencies();
    const deps = dependencies({
      operations: base.operations,
      clock: () => current,
      circleCli: {
        ...base.circleCli,
        swap: async (input) => {
          writes += 1;
          return await dependencies().circleCli.swap(input);
        },
      } as CircleCli,
    });
    const input = {
      idempotencyKey: uuid,
      sellToken: "USDC",
      buyToken: "EURC",
      sellAmount: "10",
      minimumReceive: "9.8",
      slippageBps: 100,
    };

    const first = await swapTokens(input, deps);
    current = new Date("2026-07-27T00:10:00.000Z");
    const replay = await swapTokens(input, deps);

    assert.equal(first.status, "COMPLETED");
    assert.equal(replay.status, "COMPLETED");
    assert.equal(writes, 1);
  });

  it("marks partial writes for reconciliation and never retries blindly", async () => {
    let writes = 0;
    const deps = dependencies({
      circleCli: {
        ...dependencies().circleCli,
        bridge: async () => {
          writes += 1;
          throw new Error("rpc response contained authorization=secret");
        },
      } as CircleCli,
    });
    const input = {
      idempotencyKey: uuid,
      destinationChain: "Base_Sepolia",
      recipient,
      amount: "2",
      token: "USDC",
      minimumReceive: "2",
      slippageBps: 0,
    };
    const first = await bridgeUsdc(input, deps);
    const second = await bridgeUsdc(input, deps);
    assert.equal(first.status, "RECONCILIATION_REQUIRED");
    assert.equal(second.status, "RECONCILIATION_REQUIRED");
    assert.equal(writes, 1);
    assert.doesNotMatch(JSON.stringify(first), /secret|authorization/i);
  });

  it("preserves known bridge proof when normal result persistence fails", async () => {
    const durable = createInMemoryArcLiquidityRepository();
    let failedCompletion = false;
    const repository: ArcLiquidityRepository = {
      get: (id) => durable.get(id),
      claim: (operation) => durable.claim(operation),
      transition: async (operation, expected) => {
        if (operation.status === "COMPLETED" && !failedCompletion) {
          failedCompletion = true;
          throw new Error("completion write failed");
        }
        return await durable.transition(operation, expected);
      },
    };

    const result = await bridgeUsdc({
      idempotencyKey: uuid,
      destinationChain: "Base_Sepolia",
      recipient,
      amount: "2",
      minimumReceive: "2",
      slippageBps: 0,
    }, dependencies({ operations: repository }));

    assert.equal(result.status, "RECONCILIATION_REQUIRED");
    assert.equal(result.operation.steps[0]?.transactionHash, hash);
    assert.equal(result.operation.steps[0]?.traceId, "trace-1");
    assert.equal(result.operation.steps[0]?.transferId, "transfer-1");
    assert.equal(result.operation.steps[0]?.burnTransactionHash, hash);
    assert.equal(
      result.operation.steps[0]?.forwardTransactionHash,
      `0x${"f".repeat(64)}`,
    );
  });

  it("returns reconciliation-required even when persisting an ambiguous payment state fails", async () => {
    const durable = createInMemoryArcLiquidityRepository();
    const failingReconciliationRepository: ArcLiquidityRepository = {
      get: (id) => durable.get(id),
      claim: (operation) => durable.claim(operation),
      transition: async (operation, expected) => {
        if (operation.status === "RECONCILIATION_REQUIRED") {
          throw new Error("database unavailable");
        }
        return await durable.transition(operation, expected);
      },
    };
    const result = await swapAndPay(
      {
        idempotencyKey: uuid,
        sellToken: "EURC",
        buyToken: "USDC",
        sellAmount: "10",
        minimumReceive: "9.8",
        slippageBps: 100,
        payment: { recipient, minimumAmount: "9.8", purpose: "invoice 42" },
      },
      dependencies({
        operations: failingReconciliationRepository,
        settlementVerifier: {
          verify: async () => ({
            status: "MINED",
            transactionHash: hash,
            actualReceivedAtomic: "9800000",
          }),
        },
        paymentExecutor: { pay: async () => { throw new Error("timeout"); } },
      }),
    );

    assert.equal(result.status, "PAYING");
    assert.equal(result.reconciliationRequired, true);
    assert.equal(result.operation.status, "PAYING");
    assert.equal(result.reconciliationPersistenceFailed, true);
    assert.match(result.reconciliationMessage ?? "", /last persisted state/i);
  });

  it("preserves known payment proof when completion persistence fails", async () => {
    const durable = createInMemoryArcLiquidityRepository();
    let failedCompletion = false;
    const repository: ArcLiquidityRepository = {
      get: (id) => durable.get(id),
      claim: (operation) => durable.claim(operation),
      transition: async (operation, expected) => {
        if (operation.status === "COMPLETED" && !failedCompletion) {
          failedCompletion = true;
          throw new Error("completion write failed");
        }
        return await durable.transition(operation, expected);
      },
    };
    const paymentHash = `0x${"c".repeat(64)}`;
    const result = await swapAndPay(
      {
        idempotencyKey: uuid,
        sellToken: "EURC",
        buyToken: "USDC",
        sellAmount: "10",
        minimumReceive: "9.8",
        slippageBps: 100,
        payment: { recipient, minimumAmount: "9.8", purpose: "invoice 42" },
      },
      dependencies({
        operations: repository,
        settlementVerifier: {
          verify: async () => ({
            status: "MINED",
            transactionHash: hash,
            actualReceivedAtomic: "9800000",
          }),
        },
        paymentExecutor: {
          pay: async () => ({ transactionId: "payment-1", transactionHash: paymentHash }),
        },
      }),
    );

    const paymentStep = result.operation.steps.find(({ name }) => name === "PAY");
    assert.equal(result.status, "RECONCILIATION_REQUIRED");
    assert.equal(paymentStep?.transactionId, "payment-1");
    assert.equal(paymentStep?.transactionHash, paymentHash);
    assert.equal(
      paymentStep?.arcscanUrl,
      `https://testnet.arcscan.app/tx/${paymentHash}`,
    );
  });

  it("does not pay when proof is unavailable, pending, or below the service minimum", async () => {
    for (const proof of [
      { status: "UNAVAILABLE" as const },
      { status: "PENDING" as const, transactionHash: hash },
      {
        status: "MINED" as const,
        transactionHash: hash,
        actualReceivedAtomic: "9799999",
      },
    ]) {
      let payments = 0;
      const result = await swapAndPay(
        {
          idempotencyKey: uuid,
          sellToken: "EURC",
          buyToken: "USDC",
          sellAmount: "10",
          minimumReceive: "9.8",
          slippageBps: 100,
          payment: {
            recipient,
            minimumAmount: "9.8",
            purpose: "invoice 42",
          },
        },
        dependencies({
          operations: createInMemoryArcLiquidityRepository(),
          appKit: {
            ...dependencies().appKit,
            estimateSwap: async () => ({
              ...(await dependencies().appKit.estimateSwap({
                chain: "Arc_Testnet",
                walletAddress: wallet,
                sellToken: "EURC",
                buyToken: "USDC",
                sellAmount: "10",
                slippageBps: 100,
              })),
              sellToken: "EURC",
              buyToken: "USDC",
            }),
          },
          settlementVerifier: { verify: async () => proof },
          paymentExecutor: {
            pay: async () => {
              payments += 1;
              return { transactionHash: hash };
            },
          },
        }),
      );
      assert.equal(result.status, "RECONCILIATION_REQUIRED");
      assert.equal(payments, 0);
    }
  });

  it("surfaces proof-stop reconciliation when its durable transition fails", async () => {
    const durable = createInMemoryArcLiquidityRepository();
    const repository: ArcLiquidityRepository = {
      get: (id) => durable.get(id),
      claim: (operation) => durable.claim(operation),
      transition: async (operation, expected) => {
        if (operation.status === "RECONCILIATION_REQUIRED") {
          throw new Error("database unavailable");
        }
        return await durable.transition(operation, expected);
      },
    };
    const result = await swapAndPay(
      {
        idempotencyKey: uuid,
        sellToken: "EURC",
        buyToken: "USDC",
        sellAmount: "10",
        minimumReceive: "9.8",
        slippageBps: 100,
        payment: { recipient, minimumAmount: "9.8", purpose: "invoice 42" },
      },
      dependencies({
        operations: repository,
        settlementVerifier: { verify: async () => ({ status: "UNAVAILABLE" }) },
      }),
    );

    assert.equal(result.status, "SUBMITTED");
    assert.equal(result.reconciliationRequired, true);
    assert.equal(result.reconciliationPersistenceFailed, true);
  });

  it("pays exactly once only after authoritative mined proof meets the minimum", async () => {
    let payments = 0;
    const deps = dependencies({
      settlementVerifier: {
        verify: async () => ({
          status: "MINED",
          transactionHash: hash,
          actualReceivedAtomic: "9800000",
          blockNumber: "123",
        }),
      },
      paymentExecutor: {
        pay: async () => {
          payments += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return { transactionHash: `0x${"b".repeat(64)}` };
        },
      },
    });
    const input = {
      idempotencyKey: uuid,
      sellToken: "EURC",
      buyToken: "USDC",
      sellAmount: "10",
      minimumReceive: "9.8",
      slippageBps: 100,
      payment: { recipient, minimumAmount: "9.8", purpose: "invoice 42" },
    };
    const [first, second] = await Promise.all([swapAndPay(input, deps), swapAndPay(input, deps)]);
    assert.equal(payments, 1);
    assert.ok([first.status, second.status].includes("COMPLETED"));
  });
});
