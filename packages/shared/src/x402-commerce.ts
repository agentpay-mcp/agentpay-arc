import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";

import { uuidV4Schema } from "./batch-payout.ts";
import { circleAddressSchema } from "./circle.ts";

export const ARC_TESTNET_CAIP2 = "eip155:5042002" as const;
export const ARC_GATEWAY_FACILITATOR_URL =
  "https://gateway-api-testnet.circle.com" as const;
export const ARC_GATEWAY_SCHEME = "exact" as const;
export const ARC_TESTNET_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;

const unsafeHeaders =
  /^(?:authorization|cookie|host|proxy-authorization|set-cookie|transfer-encoding|x-api-key|x-auth-token|x-circle-api-key)$/i;
const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
const headerValueSchema = z
  .string()
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Unsafe HTTP header value");
const safeHeadersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .superRefine((headers, context) => {
    const seen = new Set<string>();
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (unsafeHeaders.test(normalized)) {
        context.addIssue({ code: "custom", path: [name], message: "Unsafe HTTP header" });
      }
      if (seen.has(normalized)) {
        context.addIssue({ code: "custom", path: [name], message: "Duplicate HTTP header" });
      }
      seen.add(normalized);
    }
  })
  .transform((headers) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(headers)
          .map(([name, value]) => [name.toLowerCase(), value] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );

export const arcPaidServiceUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || isUnsafeHostname(url.hostname)) {
      context.addIssue({ code: "custom", message: "Paid service URL must be public HTTPS without credentials" });
    }
  });

export const arcPaidServiceRequestSchema = z
  .object({
    url: arcPaidServiceUrlSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: safeHeadersSchema.default({}),
    body: z.string().max(65_536).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.method === "GET" || request.method === "DELETE") && request.body !== undefined) {
      context.addIssue({ code: "custom", path: ["body"], message: "This method cannot carry a body" });
    }
  })
  .transform((request) => Object.freeze({
    ...request,
    headers: request.headers,
  }));

export type ArcPaidServiceRequest = z.output<typeof arcPaidServiceRequestSchema>;

export const arcPaidServiceQuoteBindingSchema = z
  .object({
    url: arcPaidServiceUrlSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    requestHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    quoteHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    amountAtomic: z.string().regex(/^[1-9]\d*$/),
    amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/),
    seller: circleAddressSchema,
    token: z.literal("USDC"),
    asset: z.literal(ARC_TESTNET_USDC_ADDRESS),
    network: z.literal(ARC_TESTNET_CAIP2),
    scheme: z.literal(ARC_GATEWAY_SCHEME),
    facilitatorUrl: z.literal(ARC_GATEWAY_FACILITATOR_URL),
    inspectedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ArcPaidServiceQuoteBinding = z.output<typeof arcPaidServiceQuoteBindingSchema>;

export const arcPaidServiceProofSchema = z.object({
  network: z.literal(ARC_TESTNET_CAIP2),
  scheme: z.literal(ARC_GATEWAY_SCHEME),
  seller: circleAddressSchema,
  transaction: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  payer: circleAddressSchema.optional(),
});
export type ArcPaidServiceProof = z.output<typeof arcPaidServiceProofSchema>;

export const arcAgentCommerceReceiptSchema = z
  .object({
    idempotencyKey: uuidV4Schema,
    buyerAgentId: z.string().trim().min(1).max(256),
    sellerAgentId: z.string().trim().min(1).max(256),
    serviceUrl: arcPaidServiceUrlSchema,
    requestHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    quoteHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    inspectedAmountAtomic: z.string().regex(/^[1-9]\d*$/),
    maxAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/),
    walletAddress: circleAddressSchema,
    paymentIdentifier: z.string().min(16).max(128),
    status: z.enum(["CLAIMED", "SETTLED", "RECONCILIATION_REQUIRED"]),
    settlementResult: z.record(z.string(), z.unknown()).optional(),
    proof: arcPaidServiceProofSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ArcAgentCommerceReceipt = z.output<typeof arcAgentCommerceReceiptSchema>;

export function createArcPaidServiceQuoteBinding(input: {
  readonly request: ArcPaidServiceRequest;
  readonly amountAtomic: string;
  readonly seller: string;
  readonly inspectedAt: string;
  readonly expiresAt?: string;
}): ArcPaidServiceQuoteBinding {
  const amount = formatArcX402UsdcAtomic(input.amountAtomic);
  const requestHash = hashJson({
    url: input.request.url,
    method: input.request.method,
    headers: input.request.headers,
    body: input.request.body ?? null,
  });
  const quoteCore = {
    url: input.request.url,
    method: input.request.method,
    requestHash,
    amountAtomic: input.amountAtomic,
    amount,
    seller: circleAddressSchema.parse(input.seller),
    token: "USDC",
    asset: ARC_TESTNET_USDC_ADDRESS,
    network: ARC_TESTNET_CAIP2,
    scheme: ARC_GATEWAY_SCHEME,
    facilitatorUrl: ARC_GATEWAY_FACILITATOR_URL,
    inspectedAt: input.inspectedAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  } as const;
  return arcPaidServiceQuoteBindingSchema.parse({
    ...quoteCore,
    quoteHash: hashJson(quoteCore),
  });
}

export function createArcPaidServiceRequestHash(input: ArcPaidServiceRequest): string {
  return hashJson({
    url: input.url,
    method: input.method,
    headers: input.headers,
    body: input.body ?? null,
  });
}

export function formatArcX402UsdcAtomic(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Expected a positive atomic USDC integer.");
  }
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseArcPaidServiceProof(value: unknown): ArcPaidServiceProof {
  return arcPaidServiceProofSchema.parse(value);
}

function hashJson(value: unknown): string {
  return `0x${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))}`;
}

function isUnsafeHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    hostname === "localhost"
    || [".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid"]
      .some((suffix) => hostname.endsWith(suffix))
    || hostname === "::"
    || hostname === "::1"
    || /^f[cd][0-9a-f]{2}:/.test(hostname)
    || /^fe[89ab][0-9a-f]:/.test(hostname)
    || /^::ffff:/.test(hostname)
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^192\.168\./.test(hostname)
  ) {
    return true;
  }
  const parts = hostname.split(".").map(Number);
  return parts.length === 4
    && parts.every(Number.isInteger)
    && parts[0] === 172
    && parts[1]! >= 16
    && parts[1]! <= 31;
}
