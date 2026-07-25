import { z } from "zod";

import { getChainName } from "./chains.ts";
import { preparePaymentInputSchema } from "./payment-intent.ts";
import {
  arcStableTokenSymbolSchema,
  stableTokenSymbolSchema,
  type ArcStableTokenSymbol,
  type StableTokenSymbol,
} from "./tokens.ts";

export const parseInvoicePaymentInputSchema = z.object({
  invoice: z.string().trim().min(1),
  sourceTokenSymbol: arcStableTokenSymbolSchema.default("USDC"),
});

export type ParseInvoicePaymentInput = z.input<typeof parseInvoicePaymentInputSchema>;

export interface ParsedInvoicePayment {
  invoiceId?: string;
  recipientAddress: string;
  destinationChainId: number;
  destinationChain: string;
  destinationTokenSymbol: StableTokenSymbol;
  amountOut: string;
  purpose: string;
  sourceTokenSymbol: ArcStableTokenSymbol;
  paymentType: "INVOICE_PAYMENT";
}

export function parseInvoicePayment(rawInput: ParseInvoicePaymentInput): ParsedInvoicePayment {
  const input = parseInvoicePaymentInputSchema.parse(rawInput);
  const invoice = parseInvoiceFields(input.invoice);
  const invoiceId = readField(invoice, ["invoiceid", "id", "invoice"]);
  const purpose = readField(invoice, ["purpose", "memo", "description", "note"]) ?? invoicePurpose(invoiceId);
  const candidate = {
    recipientAddress: readField(invoice, ["recipientaddress", "recipient", "to", "payto"]),
    destinationChainId: parseDestinationChainId(
      readField(invoice, ["destinationchainid", "destinationchain", "chainid", "chain"]),
    ),
    destinationTokenSymbol: parseToken(readField(invoice, ["destinationtokensymbol", "token", "currency"])),
    amountOut: readField(invoice, ["amountout", "amount", "amountdue", "total"]),
    purpose,
    sourceTokenSymbol: parseToken(readField(invoice, ["sourcetokensymbol", "sourcetoken"]) ?? input.sourceTokenSymbol),
  };

  const parsed = parsePaymentFields(candidate);

  return {
    invoiceId,
    recipientAddress: parsed.recipientAddress,
    destinationChainId: parsed.destinationChainId,
    destinationChain: getChainName(parsed.destinationChainId),
    destinationTokenSymbol: parsed.destinationTokenSymbol,
    amountOut: parsed.amountOut,
    purpose: parsed.purpose,
    sourceTokenSymbol: parsed.sourceTokenSymbol,
    paymentType: "INVOICE_PAYMENT",
  };
}

function parseInvoiceFields(invoice: string): Record<string, unknown> {
  const trimmed = invoice.trim();

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid invoice: expected a JSON object.");
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [normalizeKey(key), value]),
    );
  }

  return Object.fromEntries(
    trimmed
      .split(/\r?\n|;/)
      .map((line) => line.match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [normalizeKey(match[1]), match[2].trim()]),
  );
}

function readField(fields: Record<string, unknown>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = fields[alias];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return undefined;
}

function parseDestinationChainId(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const normalized = normalizeKey(value);
  const knownChains: Record<string, number> = {
    celo: 42220,
    celomainnet: 42220,
    celosepolia: 11142220,
    celotestnet: 11142220,
    xlayer: 196,
    xlayermainnet: 196,
    xlayertestnet: 1952,
    base: 8453,
  };

  return knownChains[normalized];
}

function parseToken(value: string | undefined): StableTokenSymbol | undefined {
  if (!value) {
    return undefined;
  }

  return stableTokenSymbolSchema.parse(normalizeTokenSymbol(value));
}

function parsePaymentFields(candidate: {
  recipientAddress: string | undefined;
  destinationChainId: number | undefined;
  destinationTokenSymbol: StableTokenSymbol | undefined;
  amountOut: string | undefined;
  purpose: string | undefined;
  sourceTokenSymbol: StableTokenSymbol | undefined;
}) {
  const parsed = preparePaymentInputSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new Error(`Invalid invoice payment fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }

  return parsed.data;
}

function invoicePurpose(invoiceId: string | undefined): string | undefined {
  return invoiceId ? `Invoice ${invoiceId}` : undefined;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeTokenSymbol(value: string): string {
  const normalized = value.trim().toUpperCase().replace("USD₮0", "USDT0");
  return normalized === "USDM" ? "USDm" : normalized;
}
