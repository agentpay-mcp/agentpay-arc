import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPayInvoiceHandler,
  type ArcPaymentRequestRecord,
  type ArcPaymentRequestRepository,
} from "./invoice.ts";
import {
  createArcPaymentExecutor,
  createSendUsdcHandler,
  type ArcPaymentRepository,
} from "./arc-payments.ts";
import {
  BATCH_ID,
  BATCH_KEY,
  clone,
  completeTransaction,
  fakeCircleCli,
  fixedClock,
  memoryRepository,
  RECEIPT_ID,
  RECIPIENT_A,
  TX_HASH_A,
} from "./arc-payments.test-support.ts";

describe("Arc send and invoice concurrency", () => {
  it("atomically claims a send idempotency key so concurrent calls transfer once", async () => {
    const base = memoryRepository();
    let releaseInitialReads: (() => void) | undefined;
    const initialReadsReady = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let initialReads = 0;
    const repository: ArcPaymentRepository = {
      ...base,
      async getReceiptByIdempotencyKey(idempotencyKey) {
        const snapshot = await base.getReceiptByIdempotencyKey(idempotencyKey);
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) {
            releaseInitialReads?.();
          }
          await initialReadsReady;
        }
        return snapshot;
      },
    };
    let transfers = 0;
    let balanceReads = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        getBalance: async () => {
          balanceReads += 1;
          return {
            balances: [{
              amount: "100",
              token: {
                name: "USD Coin",
                symbol: "USDC",
                blockchain: "ARC-TESTNET",
                decimals: 6,
                isNative: false,
                tokenAddress: "0x3600000000000000000000000000000000000000",
              },
            }],
          };
        },
        transfer: async () => {
          transfers += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return completeTransaction("circle_tx_once", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });
    const input = {
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "2.5",
      purpose: "Concurrent invoice",
    };

    const outputs = await Promise.all([handler(input), handler(input)]);

    const stored = await base.getReceiptByIdempotencyKey(RECEIPT_ID);
    assert.equal(transfers, 1);
    assert.equal(balanceReads, 1);
    assert.equal(stored?.status, "COMPLETED");
    assert.equal(stored?.transactionId, "circle_tx_once");
    assert.ok(outputs.some((output) => output.status === "SUBMITTING"));
    assert.ok(outputs.some((output) => output.status === "COMPLETED"));
  });

  it("fails closed on an ambiguous persisted send receipt without transferring", async () => {
    const repository = memoryRepository();
    await repository.seedReceipt({
      id: RECEIPT_ID,
      idempotencyKey: RECEIPT_ID,
      walletAddress: "0x1111111111111111111111111111111111111111",
      recipient: RECIPIENT_A,
      amount: "2.5",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-1",
      status: "PENDING",
      transactionHash: TX_HASH_A,
      explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    });
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "2.5",
        purpose: "Invoice INV-1",
      }),
      /ambiguous persisted state/i,
    );
    assert.equal(transfers, 0);
  });

  it("inherits atomic send claims when concurrent callers pay the same invoice", async () => {
    const payments = memoryRepository();
    let releaseReceiptReads: (() => void) | undefined;
    const receiptReadsReady = new Promise<void>((resolve) => {
      releaseReceiptReads = resolve;
    });
    let receiptReads = 0;
    const concurrentPayments: ArcPaymentRepository = {
      ...payments,
      async getReceiptByIdempotencyKey(idempotencyKey) {
        const snapshot = await payments.getReceiptByIdempotencyKey(idempotencyKey);
        if (receiptReads < 2) {
          receiptReads += 1;
          if (receiptReads === 2) {
            releaseReceiptReads?.();
          }
          await receiptReadsReady;
        }
        return snapshot;
      },
    };
    let request: ArcPaymentRequestRecord = {
      id: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      recipient: RECIPIENT_A,
      amount: "2.5",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Concurrent invoice",
      status: "OPEN",
      expiresAt: "2026-07-26T10:00:00.000Z",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    };
    let releaseRequestReads: (() => void) | undefined;
    const requestReadsReady = new Promise<void>((resolve) => {
      releaseRequestReads = resolve;
    });
    let requestReads = 0;
    const paymentRequests: ArcPaymentRequestRepository = {
      async getById(id) {
        const snapshot = request.id === id ? clone(request) : null;
        if (requestReads < 2) {
          requestReads += 1;
          if (requestReads === 2) {
            releaseRequestReads?.();
          }
          await requestReadsReady;
        }
        return snapshot;
      },
      async getByIdempotencyKey(idempotencyKey) {
        return request.idempotencyKey === idempotencyKey
          ? clone(request)
          : null;
      },
      async save(next) {
        request = clone(next);
        return clone(request);
      },
    };
    let transfers = 0;
    const paymentExecutor = createArcPaymentExecutor({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return completeTransaction("circle_tx_invoice_once", TX_HASH_A);
        },
      }),
      payments: concurrentPayments,
      clock: fixedClock,
    });
    const handler = createPayInvoiceHandler({
      paymentRequests,
      paymentExecutor,
      clock: fixedClock,
    });
    const input = {
      paymentRequestId: BATCH_ID,
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "2.5",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Concurrent invoice",
    };

    const outputs = await Promise.all([handler(input), handler(input)]);

    assert.equal(transfers, 1);
    assert.equal(request.status, "PAID");
    assert.ok(outputs.some((output) => output.status === "SUBMITTING"));
    assert.ok(outputs.some((output) => output.status === "PAID"));
  });
});
