import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArcPaymentBatchRecord,
  ArcPaymentReceiptRecord,
  CircleAgentWallet,
  CircleTransactionResult,
  CircleWalletBalance,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";
import {
  batchPayoutTool,
  createBatchPayoutHandler,
  createSendUsdcHandler,
  type ArcPaymentRepository,
  sendUsdcTool,
} from "./arc-payments.ts";

const WALLET = "0x1111111111111111111111111111111111111111";
const RECIPIENT_A = "0x2222222222222222222222222222222222222222";
const RECIPIENT_B = "0x3333333333333333333333333333333333333333";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const RECEIPT_ID = "436dd5c3-d784-4980-b708-3f1ddc84010e";
const BATCH_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
const BATCH_KEY = "ea1e8ff1-edaa-4a27-a6de-715f76d5aa7c";
const TX_HASH_A = `0x${"a".repeat(64)}`;
const TX_HASH_B = `0x${"b".repeat(64)}`;

describe("Arc payment tools", () => {
  it("publishes isolated send_usdc and batch_payout schemas", () => {
    assert.equal(sendUsdcTool.name, "send_usdc");
    assert.equal(batchPayoutTool.name, "batch_payout");
    assert.equal(sendUsdcTool.inputSchema.additionalProperties, false);
    assert.equal(batchPayoutTool.inputSchema.additionalProperties, false);
  });

  it("rejects invalid addresses, non-Arc chains, and non-six-decimal amounts before dependencies", async () => {
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli(),
      payments: memoryRepository(),
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({ idempotencyKey: RECEIPT_ID, recipient: "0x1234", amount: "1" }),
      /address/i,
    );
    await assert.rejects(
      () => handler({ idempotencyKey: RECEIPT_ID, recipient: RECIPIENT_A, amount: "1.0000001" }),
      /six|decimal|precision/i,
    );
    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "1",
        chain: "ETH-SEPOLIA",
      }),
      /ARC-TESTNET|invalid/i,
    );
  });

  it("checks the selected wallet balance and rejects insufficient USDC without transfer", async () => {
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        getBalance: async () => usdcBalance("1"),
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_A);
        },
      }),
      payments: memoryRepository(),
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "1.000001",
        purpose: "Invoice INV-1",
      }),
      /insufficient/i,
    );
    assert.equal(transfers, 0);
  });

  it("persists transaction identity before completion and invokes Circle transfer exactly once", async () => {
    const events: string[] = [];
    let transfers = 0;
    const repository = memoryRepository(events);
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async (input) => {
          transfers += 1;
          assert.deepEqual(input, {
            address: WALLET,
            amount: "2.5",
            recipient: RECIPIENT_A,
          });
          return completeTransaction("circle_tx_1", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      idempotencyKey: RECEIPT_ID,
      walletAddress: WALLET,
      recipient: RECIPIENT_A,
      amount: "2.5",
      chain: "ARC-TESTNET",
      token: "USDC",
      purpose: "Invoice INV-1",
    });

    assert.equal(transfers, 1);
    assert.deepEqual(events.filter((event) => event.startsWith("receipt:")), [
      "receipt:PENDING",
      "receipt:SUBMITTED:circle_tx_1",
      "receipt:COMPLETED:circle_tx_1",
    ]);
    assert.equal(output.receipt.status, "COMPLETED");
    assert.equal(output.receipt.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH_A}`);
  });

  it("returns a previously persisted receipt without retrying the mutation", async () => {
    const repository = memoryRepository();
    await repository.saveReceipt({
      ...baseReceipt(RECEIPT_ID),
      status: "SUBMITTED",
      transactionId: "circle_tx_existing",
      transactionHash: TX_HASH_A,
      explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
    });
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "2.5",
      purpose: "Invoice INV-1",
    });

    assert.equal(transfers, 0);
    assert.equal(output.receipt.transactionId, "circle_tx_existing");
    assert.equal(output.receipt.status, "SUBMITTED");
  });

  it("binds receipt replay to the currently authenticated selected wallet", async () => {
    const repository = memoryRepository();
    await repository.saveReceipt({
      ...baseReceipt(RECEIPT_ID),
      status: "SUBMITTED",
      transactionId: "circle_tx_existing",
    });
    let transfers = 0;
    const foreignWallet: CircleAgentWallet = {
      address: "0x9999999999999999999999999999999999999999",
      type: "agent",
      blockchain: "ARC-TESTNET",
    };
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [foreignWallet],
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "2.5",
        purpose: "Invoice INV-1",
      }),
      /wallet|authenticated|bound/i,
    );
    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        walletAddress: WALLET,
        recipient: RECIPIENT_A,
        amount: "2.5",
        purpose: "Invoice INV-1",
      }),
      /authenticated Circle Agent Wallet/i,
    );
    assert.equal(transfers, 0);
  });

  it("does not overwrite a PENDING receipt as FAILED when submitted identity persistence fails", async () => {
    const stored: ArcPaymentReceiptRecord[] = [];
    let transfers = 0;
    const base = memoryRepository();
    const repository: ArcPaymentRepository = {
      ...base,
      async saveReceipt(receipt) {
        if (receipt.status === "SUBMITTED") {
          throw new Error("database unavailable");
        }
        stored.push(structuredClone(receipt));
        return base.saveReceipt(receipt);
      },
    };
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("circle_tx_unsafe_to_retry", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "1",
        purpose: "Persistence boundary",
      }),
      /database unavailable/i,
    );
    assert.equal(transfers, 1);
    assert.deepEqual(stored.map((receipt) => receipt.status), ["PENDING"]);
  });

  it("returns exact persisted item states on partial batch failure", async () => {
    const events: string[] = [];
    const repository = memoryRepository(events);
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        getBalance: async () => usdcBalance("10"),
        transfer: async ({ recipient }) => {
          transfers += 1;
          if (recipient === RECIPIENT_A) {
            return completeTransaction("circle_tx_a", TX_HASH_A);
          }
          throw new Error("adapter unavailable");
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [
        { recipient: RECIPIENT_A, amount: "1", purpose: "A" },
        { recipient: RECIPIENT_B, amount: "2", purpose: "B" },
      ],
    });

    assert.equal(transfers, 2);
    assert.equal(output.batch.status, "PARTIAL");
    assert.deepEqual(output.batch.items.map((item) => item.status), ["COMPLETED", "FAILED"]);
    assert.equal(output.batch.items[0]?.transactionId, "circle_tx_a");
    assert.equal(output.batch.items[0]?.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH_A}`);
    assert.equal(output.batch.items[1]?.transactionId, undefined);
    assert.match(output.batch.items[1]?.errorMessage ?? "", /adapter unavailable/i);
    assert.ok(events.indexOf("item:0:SUBMITTED:circle_tx_a") < events.indexOf("item:0:COMPLETED:circle_tx_a"));
  });

  it("resumes only pristine PENDING items and never retries an item with a transaction ID", async () => {
    const repository = memoryRepository();
    const batch = await repository.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "SUBMITTED",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      items: [
        {
          id: `${BATCH_ID}:0`,
          batchId: BATCH_ID,
          index: 0,
          recipient: RECIPIENT_A,
          amount: "1",
          purpose: "A",
          status: "SUBMITTED",
          transactionId: "circle_tx_existing",
          createdAt: fixedClock().toISOString(),
          updatedAt: fixedClock().toISOString(),
        },
        {
          id: `${BATCH_ID}:1`,
          batchId: BATCH_ID,
          index: 1,
          recipient: RECIPIENT_B,
          amount: "2",
          purpose: "B",
          status: "PENDING",
          createdAt: fixedClock().toISOString(),
          updatedAt: fixedClock().toISOString(),
        },
      ],
    });
    assert.equal(batch.items.length, 2);
    const transferred: string[] = [];
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async ({ recipient }) => {
          transferred.push(recipient);
          return completeTransaction("circle_tx_b", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [
        { recipient: RECIPIENT_A, amount: "1", purpose: "A" },
        { recipient: RECIPIENT_B, amount: "2", purpose: "B" },
      ],
    });

    assert.deepEqual(transferred, [RECIPIENT_B]);
    assert.equal(output.batch.items[0]?.transactionId, "circle_tx_existing");
    assert.equal(output.batch.items[1]?.status, "COMPLETED");
  });

  it("resumes by a matching batch idempotency key and rejects key reuse across batch IDs", async () => {
    const repository = memoryRepository();
    await repository.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "COMPLETED",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      items: [{
        id: `${BATCH_ID}:0`,
        batchId: BATCH_ID,
        index: 0,
        recipient: RECIPIENT_A,
        amount: "1",
        status: "COMPLETED",
        transactionId: "circle_tx_existing",
        transactionHash: TX_HASH_A,
        explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString(),
      }],
    });
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const replay = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    });
    assert.equal(replay.status, "COMPLETED");

    await assert.rejects(
      () => handler({
        batchId: "c612a50c-89db-4de7-94ae-bc19ce2ff4a7",
        idempotencyKey: BATCH_KEY,
        payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
      }),
      /idempotency.*different|already bound/i,
    );
    assert.equal(transfers, 0);
  });

  it("fails closed when a submitted batch transaction identity cannot be persisted", async () => {
    const storedStatuses: string[] = [];
    const base = memoryRepository();
    let failTransactionIdentityWrite = true;
    const repository: ArcPaymentRepository = {
      ...base,
      async saveBatchItem(item) {
        storedStatuses.push(`${item.status}:${item.transactionId ?? "CLAIMED"}`);
        if (item.status === "SUBMITTED" && item.transactionId && failTransactionIdentityWrite) {
          failTransactionIdentityWrite = false;
          throw new Error("database unavailable");
        }
        return base.saveBatchItem(item);
      },
    };
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("circle_tx_unsafe_to_retry", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        batchId: BATCH_ID,
        idempotencyKey: BATCH_KEY,
        payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
      }),
      /database unavailable/i,
    );
    const resumed = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    });

    assert.equal(transfers, 1);
    assert.equal(resumed.batch.status, "SUBMITTED");
    assert.equal(resumed.batch.items[0]?.status, "SUBMITTED");
    assert.equal(resumed.batch.items[0]?.transactionId, undefined);
    assert.deepEqual(storedStatuses, [
      "SUBMITTED:CLAIMED",
      "SUBMITTED:circle_tx_unsafe_to_retry",
    ]);
  });
});

function fixedClock(): Date {
  return new Date("2026-07-26T09:00:00.000Z");
}

function baseReceipt(id: string): ArcPaymentReceiptRecord {
  return {
    id,
    idempotencyKey: id,
    walletAddress: WALLET,
    recipient: RECIPIENT_A,
    amount: "2.5",
    token: "USDC",
    chain: "ARC-TESTNET",
    purpose: "Invoice INV-1",
    status: "PENDING",
    createdAt: fixedClock().toISOString(),
    updatedAt: fixedClock().toISOString(),
  };
}

function completeTransaction(id: string, txHash: string): CircleTransactionResult {
  return {
    id,
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash,
  };
}

function usdcBalance(amount: string): CircleWalletBalance {
  return {
    balances: [{
      amount,
      token: {
        name: "USD Coin",
        symbol: "USDC",
        blockchain: "ARC-TESTNET",
        decimals: 6,
        isNative: false,
        tokenAddress: ARC_USDC,
      },
    }],
  };
}

function fakeCircleCli(overrides: Partial<CircleCli> = {}): CircleCli {
  const wallet: CircleAgentWallet = {
    address: WALLET,
    type: "agent",
    blockchain: "ARC-TESTNET",
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected Circle CLI call");
  };
  return {
    status: unavailable,
    listAgentWallets: async () => [wallet],
    getBalance: async () => usdcBalance("100"),
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
  };
}

function memoryRepository(events: string[] = []): ArcPaymentRepository {
  const receipts = new Map<string, ArcPaymentReceiptRecord>();
  const batches = new Map<string, ArcPaymentBatchRecord>();

  return {
    async getReceiptByIdempotencyKey(idempotencyKey) {
      return clone(receipts.get(idempotencyKey) ?? null);
    },
    async saveReceipt(receipt) {
      receipts.set(receipt.idempotencyKey, clone(receipt));
      events.push(
        `receipt:${receipt.status}${receipt.transactionId ? `:${receipt.transactionId}` : ""}`,
      );
      return clone(receipt);
    },
    async appendActivity(activity) {
      assert.ok(Object.isFrozen(activity), "activity records must be immutable");
      events.push(`activity:${activity.type}:${activity.status}`);
    },
    async getBatch(batchId) {
      return clone(batches.get(batchId) ?? null);
    },
    async getBatchByIdempotencyKey(idempotencyKey) {
      return clone(
        [...batches.values()].find((batch) => batch.idempotencyKey === idempotencyKey) ?? null,
      );
    },
    async createBatch(batch) {
      batches.set(batch.batchId, clone(batch));
      events.push(`batch:${batch.status}`);
      return clone(batch);
    },
    async saveBatchItem(item) {
      const batch = batches.get(item.batchId);
      assert.ok(batch);
      const items = batch.items.map((stored) => stored.id === item.id ? clone(item) : stored);
      batches.set(item.batchId, { ...batch, items });
      events.push(`item:${item.index}:${item.status}${item.transactionId ? `:${item.transactionId}` : ""}`);
      return clone(item);
    },
    async saveBatch(batch) {
      const stored = batches.get(batch.batchId);
      const next = { ...clone(batch), items: stored?.items ?? clone(batch.items) };
      batches.set(batch.batchId, next);
      events.push(`batch:${batch.status}`);
      return clone(next);
    },
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
