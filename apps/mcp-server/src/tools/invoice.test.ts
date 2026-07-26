import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SendUsdcInput, SendUsdcOutput } from "./arc-payments.ts";
import {
  createCreatePaymentRequestHandler,
  createPayInvoiceHandler,
  createPaymentRequestTool,
  payInvoiceTool,
  parseInvoicePaymentForAgent,
  type ArcPaymentRequestRecord,
  type ArcPaymentRequestRepository,
} from "./invoice.ts";

const REQUEST_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
const REQUEST_KEY = "ea1e8ff1-edaa-4a27-a6de-715f76d5aa7c";
const PAYMENT_KEY = "436dd5c3-d784-4980-b708-3f1ddc84010e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

describe("parseInvoicePaymentForAgent", () => {
  it("returns normalized payment fields for prepare_payment", async () => {
    const output = await parseInvoicePaymentForAgent({
      invoice: [
        "Invoice ID: inv_456",
        "Recipient: 0x1111111111111111111111111111111111111111",
        "Destination Chain: Base",
        "Token: USDC",
        "Amount: 10",
        "Purpose: design bounty",
      ].join("\n"),
    });

    assert.deepEqual(output, {
      status: "PARSED",
      invoiceId: "inv_456",
      paymentInput: {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationChain: "Base",
        destinationTokenSymbol: "USDC",
        amountOut: "10",
        purpose: "design bounty",
        sourceTokenSymbol: "USDC",
        paymentType: "INVOICE_PAYMENT",
      },
      instructionToAgent:
        "Review these invoice payment fields with the user, then call prepare_payment with paymentInput if they match the invoice.",
    });
  });
});

describe("Arc payment request and invoice tools", () => {
  it("publishes strict create_payment_request and pay_invoice tools", () => {
    assert.equal(createPaymentRequestTool.name, "create_payment_request");
    assert.equal(payInvoiceTool.name, "pay_invoice");
    assert.equal(createPaymentRequestTool.inputSchema.additionalProperties, false);
    assert.equal(payInvoiceTool.inputSchema.additionalProperties, false);
  });

  it("creates an Arc Testnet USDC request bound to exact payment fields", async () => {
    const repository = paymentRequestRepository();
    const handler = createCreatePaymentRequestHandler({
      paymentRequests: repository,
      clock: fixedClock,
    });

    const output = await handler({
      requestId: REQUEST_ID,
      idempotencyKey: REQUEST_KEY,
      recipient: RECIPIENT,
      amount: "12.000001",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-42",
      expiresAt: "2026-07-26T10:00:00.000Z",
    });

    assert.equal(output.status, "OPEN");
    assert.deepEqual(output.paymentRequest, {
      id: REQUEST_ID,
      idempotencyKey: REQUEST_KEY,
      recipient: RECIPIENT,
      amount: "12.000001",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-42",
      status: "OPEN",
      expiresAt: "2026-07-26T10:00:00.000Z",
      createdAt: "2026-07-26T09:00:00.000Z",
      updatedAt: "2026-07-26T09:00:00.000Z",
    });
  });

  it("rejects expired requests and every mismatched bound field before payment", async () => {
    const base = requestRecord();
    for (const override of [
      { recipient: "0x2222222222222222222222222222222222222222" },
      { amount: "12.000002" },
      { token: "EURC" },
      { chain: "ETH-SEPOLIA" },
      { purpose: "Different invoice" },
    ]) {
      let sends = 0;
      const handler = createPayInvoiceHandler({
        paymentRequests: paymentRequestRepository(base),
        paymentExecutor: {
          async sendUsdc() {
            sends += 1;
            throw new Error("unexpected");
          },
        },
        clock: fixedClock,
      });
      await assert.rejects(
        () => handler({
          paymentRequestId: REQUEST_ID,
          idempotencyKey: PAYMENT_KEY,
          recipient: RECIPIENT,
          amount: "12.000001",
          token: "USDC",
          chain: "ARC-TESTNET",
          purpose: "Invoice INV-42",
          ...override,
        }),
        /match|invalid|USDC|ARC-TESTNET/i,
      );
      assert.equal(sends, 0);
    }

    const expired = createPayInvoiceHandler({
      paymentRequests: paymentRequestRepository({
        ...base,
        expiresAt: "2026-07-26T08:59:59.999Z",
      }),
      paymentExecutor: {
        async sendUsdc() {
          throw new Error("unexpected");
        },
      },
      clock: fixedClock,
    });
    await assert.rejects(
      () => expired({
        paymentRequestId: REQUEST_ID,
        idempotencyKey: PAYMENT_KEY,
        recipient: RECIPIENT,
        amount: "12.000001",
        token: "USDC",
        chain: "ARC-TESTNET",
        purpose: "Invoice INV-42",
      }),
      /expired/i,
    );
  });

  it("passes only the exact request binding to send_usdc and marks paid after completion", async () => {
    const saves: ArcPaymentRequestRecord[] = [];
    const repository = paymentRequestRepository(requestRecord(), saves);
    const sendInputs: SendUsdcInput[] = [];
    const handler = createPayInvoiceHandler({
      paymentRequests: repository,
      paymentExecutor: {
        async sendUsdc(input) {
          sendInputs.push(input);
          return completedPayment(input);
        },
      },
      clock: fixedClock,
    });

    const output = await handler({
      paymentRequestId: REQUEST_ID,
      idempotencyKey: PAYMENT_KEY,
      recipient: RECIPIENT,
      amount: "12.000001",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-42",
    });

    assert.deepEqual(sendInputs, [{
      idempotencyKey: PAYMENT_KEY,
      recipient: RECIPIENT,
      amount: "12.000001",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-42",
    }]);
    assert.equal(output.status, "PAID");
    assert.equal(saves.at(-1)?.status, "PAID");
    assert.equal(saves.at(-1)?.receiptId, PAYMENT_KEY);
  });

  it("keeps the invoice open when the payment requires reconciliation", async () => {
    const saves: ArcPaymentRequestRecord[] = [];
    const handler = createPayInvoiceHandler({
      paymentRequests: paymentRequestRepository(requestRecord(), saves),
      paymentExecutor: {
        async sendUsdc(input) {
          const completed = completedPayment(input);
          return {
            ...completed,
            status: "SUBMITTING",
            receipt: {
              ...completed.receipt,
              status: "SUBMITTING",
              transactionId: undefined,
              transactionHash: undefined,
            },
            reconciliationRequired: true,
            reconciliationMessage: "Do not retry; reconcile manually.",
          };
        },
      },
      clock: fixedClock,
    });

    const output = await handler({
      paymentRequestId: REQUEST_ID,
      idempotencyKey: PAYMENT_KEY,
      recipient: RECIPIENT,
      amount: "12.000001",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice INV-42",
    });

    assert.equal(output.status, "SUBMITTING");
    assert.equal(output.payment.reconciliationRequired, true);
    assert.match(output.payment.reconciliationMessage ?? "", /do not retry/i);
    assert.equal(saves.length, 0);
  });
});

function fixedClock(): Date {
  return new Date("2026-07-26T09:00:00.000Z");
}

function requestRecord(): ArcPaymentRequestRecord {
  return {
    id: REQUEST_ID,
    idempotencyKey: REQUEST_KEY,
    recipient: RECIPIENT,
    amount: "12.000001",
    token: "USDC",
    chain: "ARC-TESTNET",
    purpose: "Invoice INV-42",
    status: "OPEN",
    expiresAt: "2026-07-26T10:00:00.000Z",
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:00.000Z",
  };
}

function paymentRequestRepository(
  initial?: ArcPaymentRequestRecord,
  saves: ArcPaymentRequestRecord[] = [],
): ArcPaymentRequestRepository {
  let stored = initial ? structuredClone(initial) : null;
  return {
    async getById(id) {
      return stored?.id === id ? structuredClone(stored) : null;
    },
    async getByIdempotencyKey(idempotencyKey) {
      return stored?.idempotencyKey === idempotencyKey ? structuredClone(stored) : null;
    },
    async save(paymentRequest) {
      stored = structuredClone(paymentRequest);
      saves.push(structuredClone(paymentRequest));
      return structuredClone(paymentRequest);
    },
  };
}

function completedPayment(input: SendUsdcInput): SendUsdcOutput {
  const parsed = input as Required<Omit<SendUsdcInput, "walletAddress">>;
  return {
    status: "COMPLETED",
    reconciliationRequired: false,
    receipt: {
      id: parsed.idempotencyKey,
      idempotencyKey: parsed.idempotencyKey,
      walletAddress: "0x9999999999999999999999999999999999999999",
      recipient: parsed.recipient,
      amount: parsed.amount,
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: parsed.purpose,
      status: "COMPLETED",
      transactionId: "circle_tx_invoice",
      transactionHash: `0x${"a".repeat(64)}`,
      explorerUrl: `https://testnet.arcscan.app/tx/0x${"a".repeat(64)}`,
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    },
  };
}
