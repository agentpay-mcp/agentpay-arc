import {
  CIRCLE_ARC_CHAIN,
  arcUsdcAmountSchema,
  circleAddressSchema,
  parseInvoicePayment,
  type ParseInvoicePaymentInput,
  parseInvoicePaymentInputSchema,
  type StableTokenSymbol,
  uuidV4Schema,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type {
  ArcPaymentExecutor,
  SendUsdcOutput,
} from "./arc-payments.ts";

const createPaymentRequestInputSchema = z
  .object({
    requestId: uuidV4Schema,
    idempotencyKey: uuidV4Schema,
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    token: z.literal("USDC").default("USDC"),
    chain: z.literal(CIRCLE_ARC_CHAIN).default(CIRCLE_ARC_CHAIN),
    purpose: z.string().trim().min(1).max(512),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const payInvoiceInputSchema = z
  .object({
    paymentRequestId: uuidV4Schema,
    idempotencyKey: uuidV4Schema,
    walletAddress: circleAddressSchema.optional(),
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    token: z.literal("USDC"),
    chain: z.literal(CIRCLE_ARC_CHAIN),
    purpose: z.string().trim().min(1).max(512),
  })
  .strict();

export type CreatePaymentRequestInput = z.input<typeof createPaymentRequestInputSchema>;
export type PayInvoiceInput = z.input<typeof payInvoiceInputSchema>;

export interface ArcPaymentRequestRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly amount: string;
  readonly token: "USDC";
  readonly chain: typeof CIRCLE_ARC_CHAIN;
  readonly purpose: string;
  readonly status: "OPEN" | "PAID" | "EXPIRED";
  readonly expiresAt: string;
  readonly receiptId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcPaymentRequestRepository {
  getById(id: string): Promise<ArcPaymentRequestRecord | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ArcPaymentRequestRecord | null>;
  save(paymentRequest: ArcPaymentRequestRecord): Promise<ArcPaymentRequestRecord>;
}

export interface CreatePaymentRequestDependencies {
  readonly paymentRequests: ArcPaymentRequestRepository;
  readonly clock: () => Date;
}

export interface PayInvoiceDependencies extends CreatePaymentRequestDependencies {
  readonly paymentExecutor: ArcPaymentExecutor;
}

export interface ParseInvoicePaymentOutput {
  status: "PARSED";
  invoiceId?: string;
  paymentInput: {
    recipientAddress: string;
    destinationChainId: number;
    destinationChain: string;
    destinationTokenSymbol: StableTokenSymbol;
    amountOut: string;
    purpose: string;
    sourceTokenSymbol: StableTokenSymbol;
    paymentType: "INVOICE_PAYMENT";
  };
  instructionToAgent: string;
}

export async function parseInvoicePaymentForAgent(
  rawInput: ParseInvoicePaymentInput,
): Promise<ParseInvoicePaymentOutput> {
  const parsed = parseInvoicePayment(rawInput);

  return {
    status: "PARSED",
    invoiceId: parsed.invoiceId,
    paymentInput: {
      recipientAddress: parsed.recipientAddress,
      destinationChainId: parsed.destinationChainId,
      destinationChain: parsed.destinationChain,
      destinationTokenSymbol: parsed.destinationTokenSymbol,
      amountOut: parsed.amountOut,
      purpose: parsed.purpose,
      sourceTokenSymbol: parsed.sourceTokenSymbol,
      paymentType: parsed.paymentType,
    },
    instructionToAgent:
      "Review these invoice payment fields with the user, then call prepare_payment with paymentInput if they match the invoice.",
  };
}

export const parseInvoicePaymentTool = {
  name: "parse_invoice_payment",
  description: "Parse structured invoice text into AgentPay payment fields.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["invoice"],
    properties: {
      invoice: { type: "string" },
      sourceTokenSymbol: { type: "string", enum: ["USDC"] },
    },
  },
} as const;

export function createParseInvoicePaymentHandler() {
  return (input: ParseInvoicePaymentInput) => parseInvoicePaymentForAgent(input);
}

export { parseInvoicePaymentInputSchema };

export async function createPaymentRequest(
  rawInput: unknown,
  dependencies: CreatePaymentRequestDependencies,
) {
  const input = createPaymentRequestInputSchema.parse(rawInput);
  assertFutureExpiry(input.expiresAt, dependencies.clock());
  const [byIdempotencyKey, byId] = await Promise.all([
    dependencies.paymentRequests.getByIdempotencyKey(input.idempotencyKey),
    dependencies.paymentRequests.getById(input.requestId),
  ]);
  const existing = byIdempotencyKey ?? byId;
  if (existing) {
    assertPaymentRequestMatches(existing, input);
    return {
      status: existing.status,
      paymentRequest: { ...existing },
    };
  }

  const now = dependencies.clock().toISOString();
  const paymentRequest = await dependencies.paymentRequests.save({
    id: input.requestId,
    idempotencyKey: input.idempotencyKey,
    recipient: input.recipient,
    amount: input.amount,
    token: input.token,
    chain: input.chain,
    purpose: input.purpose,
    status: "OPEN",
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return {
    status: paymentRequest.status,
    paymentRequest: { ...paymentRequest },
  };
}

export async function payInvoice(
  rawInput: unknown,
  dependencies: PayInvoiceDependencies,
) {
  const input = payInvoiceInputSchema.parse(rawInput);
  const paymentRequest = await dependencies.paymentRequests.getById(input.paymentRequestId);
  if (!paymentRequest) {
    throw new Error(`Arc payment request ${input.paymentRequestId} was not found.`);
  }
  assertInvoiceMatches(paymentRequest, input);
  if (new Date(paymentRequest.expiresAt).getTime() <= dependencies.clock().getTime()) {
    if (paymentRequest.status === "OPEN") {
      await dependencies.paymentRequests.save({
        ...paymentRequest,
        status: "EXPIRED",
        updatedAt: dependencies.clock().toISOString(),
      });
    }
    throw new Error("Arc payment request has expired.");
  }
  if (paymentRequest.status !== "OPEN") {
    throw new Error(`Arc payment request is already ${paymentRequest.status.toLowerCase()}.`);
  }

  const payment = await dependencies.paymentExecutor.sendUsdc({
    idempotencyKey: input.idempotencyKey,
    ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
    recipient: paymentRequest.recipient,
    amount: paymentRequest.amount,
    token: paymentRequest.token,
    chain: paymentRequest.chain,
    purpose: paymentRequest.purpose,
  });
  if (payment.status !== "COMPLETED") {
    return {
      status: payment.status,
      paymentRequest: { ...paymentRequest },
      payment,
    };
  }
  const paid = await dependencies.paymentRequests.save({
    ...paymentRequest,
    status: "PAID",
    receiptId: payment.receipt.id,
    updatedAt: dependencies.clock().toISOString(),
  });
  return {
    status: "PAID" as const,
    paymentRequest: { ...paid },
    payment: clonePaymentOutput(payment),
  };
}

export function createCreatePaymentRequestHandler(
  dependencies: CreatePaymentRequestDependencies,
) {
  return (input: unknown) => createPaymentRequest(input, dependencies);
}

export function createPayInvoiceHandler(dependencies: PayInvoiceDependencies) {
  return (input: unknown) => payInvoice(input, dependencies);
}

export const createPaymentRequestTool = {
  name: "create_payment_request",
  description: "Create an expiring Arc Testnet USDC payment request bound to exact invoice fields.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "requestId",
      "idempotencyKey",
      "recipient",
      "amount",
      "purpose",
      "expiresAt",
    ],
    properties: {
      requestId: { type: "string", format: "uuid" },
      idempotencyKey: { type: "string", format: "uuid" },
      recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      amount: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
      token: { type: "string", enum: ["USDC"], default: "USDC" },
      chain: { type: "string", enum: [CIRCLE_ARC_CHAIN], default: CIRCLE_ARC_CHAIN },
      purpose: { type: "string", minLength: 1, maxLength: 512 },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
} as const;

export const payInvoiceTool = {
  name: "pay_invoice",
  description: "Pay an unexpired Arc request only when all bound invoice fields match exactly.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "paymentRequestId",
      "idempotencyKey",
      "recipient",
      "amount",
      "token",
      "chain",
      "purpose",
    ],
    properties: {
      paymentRequestId: { type: "string", format: "uuid" },
      idempotencyKey: { type: "string", format: "uuid" },
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      amount: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
      token: { type: "string", enum: ["USDC"] },
      chain: { type: "string", enum: [CIRCLE_ARC_CHAIN] },
      purpose: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

function assertFutureExpiry(expiresAt: string, now: Date): void {
  if (new Date(expiresAt).getTime() <= now.getTime()) {
    throw new Error("Arc payment request expiry must be in the future.");
  }
}

function assertPaymentRequestMatches(
  request: ArcPaymentRequestRecord,
  input: z.output<typeof createPaymentRequestInputSchema>,
): void {
  if (
    request.id !== input.requestId
    || request.idempotencyKey !== input.idempotencyKey
    || request.recipient.toLowerCase() !== input.recipient.toLowerCase()
    || request.amount !== input.amount
    || request.token !== input.token
    || request.chain !== input.chain
    || request.purpose !== input.purpose
    || request.expiresAt !== input.expiresAt
  ) {
    throw new Error("Payment request identifier is already bound to different fields.");
  }
}

function assertInvoiceMatches(
  request: ArcPaymentRequestRecord,
  input: z.output<typeof payInvoiceInputSchema>,
): void {
  if (
    request.recipient.toLowerCase() !== input.recipient.toLowerCase()
    || request.amount !== input.amount
    || request.token !== input.token
    || request.chain !== input.chain
    || request.purpose !== input.purpose
  ) {
    throw new Error("Invoice fields must exactly match the bound Arc payment request.");
  }
}

function clonePaymentOutput(payment: SendUsdcOutput): SendUsdcOutput {
  return {
    status: payment.status,
    receipt: { ...payment.receipt },
  };
}
