import assert from "node:assert/strict";

import type {
  ArcPaymentBatchRecord,
  ArcPaymentReceiptRecord,
  CircleAgentWallet,
  CircleTransactionResult,
  CircleWalletBalance,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";
import type { ArcPaymentRepository } from "./arc-payments.ts";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const RECIPIENT_A = "0x2222222222222222222222222222222222222222";
export const RECIPIENT_B = "0x3333333333333333333333333333333333333333";
export const RECEIPT_ID = "436dd5c3-d784-4980-b708-3f1ddc84010e";
export const BATCH_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
export const BATCH_KEY = "ea1e8ff1-edaa-4a27-a6de-715f76d5aa7c";
export const TX_HASH_A = `0x${"a".repeat(64)}`;
export const TX_HASH_B = `0x${"b".repeat(64)}`;

const ARC_USDC = "0x3600000000000000000000000000000000000000";

export function fixedClock(): Date {
  return new Date("2026-07-26T09:00:00.000Z");
}

export function baseReceipt(id: string): ArcPaymentReceiptRecord {
  return {
    id,
    idempotencyKey: id,
    walletAddress: WALLET,
    recipient: RECIPIENT_A,
    amount: "2.5",
    token: "USDC",
    chain: "ARC-TESTNET",
    purpose: "Invoice INV-1",
    status: "SUBMITTING",
    createdAt: fixedClock().toISOString(),
    updatedAt: fixedClock().toISOString(),
  };
}

export function completeTransaction(
  id: string,
  txHash: string,
): CircleTransactionResult {
  return {
    id,
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash,
  };
}

export function usdcBalance(amount: string): CircleWalletBalance {
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

export function fakeCircleCli(
  overrides: Partial<CircleCli> = {},
): CircleCli {
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

export function memoryRepository(
  events: string[] = [],
): ArcPaymentRepository & {
  seedReceipt(receipt: ArcPaymentReceiptRecord): Promise<void>;
} {
  const receipts = new Map<string, ArcPaymentReceiptRecord>();
  const batches = new Map<string, ArcPaymentBatchRecord>();

  const repository: ArcPaymentRepository & {
    seedReceipt(receipt: ArcPaymentReceiptRecord): Promise<void>;
  } = {
    async getReceiptByIdempotencyKey(idempotencyKey) {
      return clone(receipts.get(idempotencyKey) ?? null);
    },
    async transitionReceipt(receipt) {
      receipts.set(receipt.idempotencyKey, clone(receipt));
      events.push(
        `receipt:${receipt.status}${receipt.transactionId ? `:${receipt.transactionId}` : ""}`,
      );
      events.push(`activity:PAYMENT:${receipt.status}`);
      return clone(receipt);
    },
    async claimReceipt(receipt) {
      const existing =
        receipts.get(receipt.idempotencyKey)
        ?? [...receipts.values()].find(
          (stored) =>
            receipt.paymentRequestId !== undefined
            && stored.paymentRequestId === receipt.paymentRequestId,
        );
      if (existing) {
        return { claimed: false, receipt: clone(existing) };
      }
      receipts.set(receipt.idempotencyKey, clone(receipt));
      events.push(`receipt:${receipt.status}`);
      events.push(`activity:PAYMENT:${receipt.status}`);
      return { claimed: true, receipt: clone(receipt) };
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
        [...batches.values()].find((batch) =>
          batch.idempotencyKey === idempotencyKey
        ) ?? null,
      );
    },
    async createBatch(batch) {
      batches.set(batch.batchId, clone(batch));
      events.push(`batch:${batch.status}`);
      return clone(batch);
    },
    async claimBatchItem(item) {
      const batch = batches.get(item.batchId);
      assert.ok(batch);
      const stored = batch.items.find((candidate) => candidate.id === item.id);
      if (
        !stored
        || stored.status !== "PENDING"
        || stored.transactionId !== undefined
        || stored.transactionHash !== undefined
      ) {
        return null;
      }
      const claimed = {
        ...stored,
        status: "SUBMITTED" as const,
        updatedAt: item.updatedAt,
      };
      batches.set(item.batchId, {
        ...batch,
        items: batch.items.map((candidate) =>
          candidate.id === item.id ? clone(claimed) : candidate
        ),
      });
      events.push(`item:${item.index}:SUBMITTED:CLAIMED`);
      return clone(claimed);
    },
    async saveBatchItem(item) {
      const batch = batches.get(item.batchId);
      assert.ok(batch);
      const items = batch.items.map((stored) =>
        stored.id === item.id ? clone(item) : stored
      );
      batches.set(item.batchId, { ...batch, items });
      events.push(
        `item:${item.index}:${item.status}${item.transactionId ? `:${item.transactionId}` : ""}`,
      );
      return clone(item);
    },
    async saveBatch(batch) {
      const stored = batches.get(batch.batchId);
      const next = {
        ...clone(batch),
        items: stored?.items ?? clone(batch.items),
      };
      batches.set(batch.batchId, next);
      events.push(`batch:${batch.status}`);
      return clone(next);
    },
    async seedReceipt(receipt) {
      receipts.set(receipt.idempotencyKey, clone(receipt));
    },
  };
  return repository;
}

export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
