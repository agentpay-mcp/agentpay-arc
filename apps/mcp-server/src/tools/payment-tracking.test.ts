import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArcAgentActivityRecord,
  ArcPaymentReceiptRecord,
  PaymentIntentRecord,
} from "@agentpay-ai/shared-arc";

import {
  getPaymentReceipt,
  getPaymentReceiptTool,
  listAgentActivity,
  listAgentActivityTool,
  listPaymentEvents,
  listTransactions,
  trackPayment,
} from "./payment-tracking.ts";

const executingIntent: PaymentIntentRecord = {
  id: "pay_123",
  accountAddress: "0x3333333333333333333333333333333333333333",
  ownerAddress: "0x2222222222222222222222222222222222222222",
  status: "EXECUTING",
  paymentType: "WALLET_PAYMENT",
  sourceChainId: 196,
  destinationChainId: 8453,
  sourceTokenAddress: "0x5555555555555555555555555555555555555555",
  sourceTokenSymbol: "USDT0",
  destinationTokenAddress: "0x6666666666666666666666666666666666666666",
  destinationTokenSymbol: "USDC",
  recipientAddress: "0x1111111111111111111111111111111111111111",
  amountOut: "10",
  maxAmountIn: "10.18",
  maxNativeFee: "0",
  routeProvider: "LI.FI",
  routeTarget: "0x7777777777777777777777777777777777777777",
  routeCalldata: "0x1234",
  routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
  routeSummary: "Swap and bridge.",
  estimatedFee: "0.12",
  estimatedEtaSeconds: 120,
  nonce: "42",
  deadline: "2026-07-02T14:45:00.000Z",
  purpose: "design bounty",
  approvalPhrase: "APPROVE pay_123",
  approvedAt: "2026-07-02T14:40:00.000Z",
  sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  createdAt: "2026-07-02T14:30:00.000Z",
};

const directExecutingIntent: PaymentIntentRecord = {
  ...executingIntent,
  id: "pay_direct",
  destinationChainId: 196,
  destinationTokenAddress: executingIntent.sourceTokenAddress,
  destinationTokenSymbol: "USDT0",
  amountOut: "10",
  maxAmountIn: "10",
  routeProvider: "DIRECT",
  routeTarget: "0x0000000000000000000000000000000000000000",
  routeCalldata: "0x",
  routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  routeSummary: "Direct 10 USDT0 transfer on X Layer.",
  estimatedFee: "0",
  estimatedEtaSeconds: 0,
  sourceTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
};

describe("trackPayment", () => {
  it("marks an executing payment completed when LI.FI reports DONE", async () => {
    const updates: unknown[] = [];
    const statusRequests: unknown[] = [];

    const output = await trackPayment(
      { paymentIntentId: "pay_123" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return executingIntent;
          },
          async markPaymentCompleted(paymentIntentId, destinationTxHash, completedAt) {
            updates.push({ paymentIntentId, destinationTxHash, completedAt });
          },
          async markPaymentFailed() {
            throw new Error("should not fail");
          },
        },
        routeStatuses: {
          async getRouteStatus(request) {
            statusRequests.push(request);
            return {
              status: "DONE",
              substatus: "COMPLETED",
              substatusMessage: "The transfer is complete.",
              destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            };
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            throw new Error("should not poll source receipts for LI.FI routes");
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(statusRequests, [
      {
        txHash: executingIntent.sourceTxHash,
        fromChainId: 196,
        toChainId: 8453,
      },
    ]);
    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_123",
        destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        completedAt: "2026-07-02T14:43:00.000Z",
      },
    ]);
    assert.deepEqual(output, {
      paymentIntentId: "pay_123",
      status: "COMPLETED",
      sourceTxHash: executingIntent.sourceTxHash,
      destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "The transfer is complete.",
    });
  });

  it("marks direct executing payments completed without polling LI.FI", async () => {
    const updates: unknown[] = [];
    const sourceStatusRequests: unknown[] = [];

    const output = await trackPayment(
      { paymentIntentId: "pay_direct" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return directExecutingIntent;
          },
          async markPaymentCompleted(paymentIntentId, destinationTxHash, completedAt) {
            updates.push({ paymentIntentId, destinationTxHash, completedAt });
          },
          async markPaymentFailed() {
            throw new Error("should not fail");
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            throw new Error("should not poll LI.FI for direct payments");
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus(request) {
            sourceStatusRequests.push(request);
            return { status: "SUCCESS" };
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(sourceStatusRequests, [
      {
        txHash: directExecutingIntent.sourceTxHash,
        chainId: 196,
      },
    ]);
    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_direct",
        destinationTxHash: directExecutingIntent.sourceTxHash,
        completedAt: "2026-07-02T14:43:00.000Z",
      },
    ]);
    assert.deepEqual(output, {
      paymentIntentId: "pay_direct",
      status: "COMPLETED",
      sourceTxHash: directExecutingIntent.sourceTxHash,
      destinationTxHash: directExecutingIntent.sourceTxHash,
      message: "Direct payment completed in the source transaction.",
    });
  });

  it("keeps direct payments executing while the source transaction is pending", async () => {
    const output = await trackPayment(
      { paymentIntentId: "pay_direct" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return directExecutingIntent;
          },
          async markPaymentCompleted() {
            throw new Error("should not complete");
          },
          async markPaymentFailed() {
            throw new Error("should not fail");
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            throw new Error("should not poll LI.FI for direct payments");
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            return { status: "PENDING" };
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(output, {
      paymentIntentId: "pay_direct",
      status: "EXECUTING",
      sourceTxHash: directExecutingIntent.sourceTxHash,
      message: "Direct payment source transaction is still pending.",
    });
  });

  it("marks direct payments failed when the source transaction failed", async () => {
    const updates: unknown[] = [];

    const output = await trackPayment(
      { paymentIntentId: "pay_direct" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return directExecutingIntent;
          },
          async markPaymentCompleted() {
            throw new Error("should not complete");
          },
          async markPaymentFailed(paymentIntentId, errorCode, errorMessage) {
            updates.push({ paymentIntentId, errorCode, errorMessage });
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            throw new Error("should not poll LI.FI for direct payments");
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            return { status: "FAILED" };
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_direct",
        errorCode: "SOURCE_TX_FAILED",
        errorMessage: "Direct payment source transaction failed.",
      },
    ]);
    assert.deepEqual(output, {
      paymentIntentId: "pay_direct",
      status: "FAILED",
      sourceTxHash: directExecutingIntent.sourceTxHash,
      message: "Direct payment source transaction failed.",
    });
  });

  it("keeps payment executing when LI.FI is still pending", async () => {
    const output = await trackPayment(
      { paymentIntentId: "pay_123" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return executingIntent;
          },
          async markPaymentCompleted() {
            throw new Error("should not complete");
          },
          async markPaymentFailed() {
            throw new Error("should not fail");
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            return {
              status: "PENDING",
              substatus: "WAIT_DESTINATION_TRANSACTION",
              substatusMessage: "Waiting for destination transaction.",
            };
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            throw new Error("should not poll source receipts for LI.FI routes");
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(output, {
      paymentIntentId: "pay_123",
      status: "EXECUTING",
      sourceTxHash: executingIntent.sourceTxHash,
      message: "Waiting for destination transaction.",
    });
  });

  it("marks an executing payment failed when LI.FI reports FAILED", async () => {
    const updates: unknown[] = [];

    const output = await trackPayment(
      { paymentIntentId: "pay_123" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return executingIntent;
          },
          async markPaymentCompleted() {
            throw new Error("should not complete");
          },
          async markPaymentFailed(paymentIntentId, errorCode, errorMessage) {
            updates.push({ paymentIntentId, errorCode, errorMessage });
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            return {
              status: "FAILED",
              substatus: "SLIPPAGE_EXCEEDED",
              substatusMessage: "Received amount too low.",
            };
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            throw new Error("should not poll source receipts for LI.FI routes");
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_123",
        errorCode: "ROUTE_FAILED",
        errorMessage: "Received amount too low.",
      },
    ]);
    assert.deepEqual(output, {
      paymentIntentId: "pay_123",
      status: "FAILED",
      sourceTxHash: executingIntent.sourceTxHash,
      message: "Received amount too low.",
    });
  });

  it("returns stored status without polling before execution starts", async () => {
    const awaitingIntent = { ...executingIntent, status: "AWAITING_APPROVAL" as const, sourceTxHash: undefined };

    const output = await trackPayment(
      { paymentIntentId: "pay_123" },
      {
        paymentIntents: {
          async getPaymentIntent() {
            return awaitingIntent;
          },
          async markPaymentCompleted() {
            throw new Error("should not complete");
          },
          async markPaymentFailed() {
            throw new Error("should not fail");
          },
        },
        routeStatuses: {
          async getRouteStatus() {
            throw new Error("should not poll");
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            throw new Error("should not poll");
          },
        },
        clock: () => new Date("2026-07-02T14:43:00.000Z"),
      },
    );

    assert.deepEqual(output, {
      paymentIntentId: "pay_123",
      status: "AWAITING_APPROVAL",
      message: "Payment is awaiting approval.",
    });
  });
});

describe("listTransactions", () => {
  it("returns latest payment intent summaries", async () => {
    const requestedLimits: number[] = [];
    const output = await listTransactions(
      { limit: 2 },
      {
        paymentIntents: {
          async listPaymentIntents(request) {
            requestedLimits.push(request.limit);
            return [
              executingIntent,
              {
                ...executingIntent,
                id: "pay_122",
                status: "COMPLETED",
                destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                createdAt: "2026-07-02T14:20:00.000Z",
              },
            ];
          },
        },
      },
    );

    assert.deepEqual(requestedLimits, [2]);
    assert.deepEqual(output, {
      transactions: [
        {
          paymentIntentId: "pay_123",
          status: "EXECUTING",
          paymentType: "WALLET_PAYMENT",
          amountOut: "10",
          destinationTokenSymbol: "USDC",
          destinationChainId: 8453,
          recipientAddress: "0x1111111111111111111111111111111111111111",
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          createdAt: "2026-07-02T14:30:00.000Z",
        },
        {
          paymentIntentId: "pay_122",
          status: "COMPLETED",
          paymentType: "WALLET_PAYMENT",
          amountOut: "10",
          destinationTokenSymbol: "USDC",
          destinationChainId: 8453,
          recipientAddress: "0x1111111111111111111111111111111111111111",
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          createdAt: "2026-07-02T14:20:00.000Z",
        },
      ],
    });
  });
});

describe("listPaymentEvents", () => {
  it("returns payment lifecycle audit events", async () => {
    const requests: unknown[] = [];
    const output = await listPaymentEvents(
      { paymentIntentId: "pay_123", limit: 2 },
      {
        paymentEvents: {
          async listPaymentEvents(request) {
            requests.push(request);
            return [
              {
                id: "event_1",
                paymentIntentId: "pay_123",
                eventType: "PAYMENT_EXECUTING",
                message: "Payment execution started.",
                metadata: {
                  sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
                createdAt: "2026-07-02T14:40:00.000Z",
              },
              {
                id: "event_0",
                paymentIntentId: "pay_123",
                eventType: "PAYMENT_CREATED",
                message: "Payment intent created.",
                metadata: {
                  status: "AWAITING_APPROVAL",
                },
                createdAt: "2026-07-02T14:30:00.000Z",
              },
            ];
          },
        },
      },
    );

    assert.deepEqual(requests, [{ paymentIntentId: "pay_123", limit: 2 }]);
    assert.deepEqual(output, {
      events: [
        {
          eventId: "event_1",
          paymentIntentId: "pay_123",
          eventType: "PAYMENT_EXECUTING",
          message: "Payment execution started.",
          metadata: {
            sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          createdAt: "2026-07-02T14:40:00.000Z",
        },
        {
          eventId: "event_0",
          paymentIntentId: "pay_123",
          eventType: "PAYMENT_CREATED",
          message: "Payment intent created.",
          metadata: {
            status: "AWAITING_APPROVAL",
          },
          createdAt: "2026-07-02T14:30:00.000Z",
        },
      ],
    });
  });
});

describe("Arc payment tracking tools", () => {
  it("publishes strict list_agent_activity and get_payment_receipt tools", () => {
    assert.equal(listAgentActivityTool.name, "list_agent_activity");
    assert.equal(getPaymentReceiptTool.name, "get_payment_receipt");
    assert.equal(listAgentActivityTool.inputSchema.additionalProperties, false);
    assert.equal(getPaymentReceiptTool.inputSchema.additionalProperties, false);
  });

  it("returns immutable tenant-scoped activity snapshots", async () => {
    const record: ArcAgentActivityRecord = {
      id: "activity_1",
      type: "PAYMENT",
      status: "COMPLETED",
      referenceId: "436dd5c3-d784-4980-b708-3f1ddc84010e",
      metadata: { amount: "1" },
      createdAt: "2026-07-26T09:00:00.000Z",
    };
    const requests: unknown[] = [];
    const output = await listAgentActivity(
      { limit: 5 },
      {
        activity: {
          async listAgentActivity(request) {
            requests.push(request);
            return [record];
          },
        },
      },
    );

    assert.deepEqual(requests, [{ limit: 5 }]);
    assert.deepEqual(output.activities, [record]);
    assert.ok(Object.isFrozen(output.activities[0]));
    assert.ok(Object.isFrozen(output.activities[0]?.metadata));
    assert.notEqual(output.activities[0], record);
  });

  it("returns receipts with the exact Arc Testnet explorer link", async () => {
    const txHash = `0x${"c".repeat(64)}`;
    const receipt: ArcPaymentReceiptRecord = {
      id: "436dd5c3-d784-4980-b708-3f1ddc84010e",
      idempotencyKey: "436dd5c3-d784-4980-b708-3f1ddc84010e",
      walletAddress: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "1",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-1",
      status: "COMPLETED",
      transactionId: "circle_tx_1",
      transactionHash: txHash,
      explorerUrl: "https://evil.example/tx",
      createdAt: "2026-07-26T09:00:00.000Z",
      updatedAt: "2026-07-26T09:01:00.000Z",
    };

    const output = await getPaymentReceipt(
      { receiptId: receipt.id },
      {
        receipts: {
          async getPaymentReceipt(receiptId) {
            assert.equal(receiptId, receipt.id);
            return receipt;
          },
        },
      },
    );

    assert.equal(output.receipt.explorerUrl, `https://testnet.arcscan.app/tx/${txHash}`);
    assert.notEqual(output.receipt, receipt);
  });

  it("rejects invalid receipt IDs and missing receipts", async () => {
    const dependencies = {
      receipts: {
        async getPaymentReceipt() {
          return null;
        },
      },
    };
    await assert.rejects(
      () => getPaymentReceipt({ receiptId: "not-a-uuid" }, dependencies),
      /uuid|version 4/i,
    );
    await assert.rejects(
      () => getPaymentReceipt(
        { receiptId: "436dd5c3-d784-4980-b708-3f1ddc84010e" },
        dependencies,
      ),
      /not found/i,
    );
  });
});
