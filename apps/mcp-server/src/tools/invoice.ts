import {
  parseInvoicePayment,
  type ParseInvoicePaymentInput,
  parseInvoicePaymentInputSchema,
  type StableTokenSymbol,
} from "@agentpay-ai/shared-arc";

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
