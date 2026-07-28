import {
  ARC_GATEWAY_SCHEME,
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_USDC_ADDRESS,
  CIRCLE_ARC_CHAIN,
  arcAgentCommerceReceiptSchema,
  arcPaidServiceQuoteBindingSchema,
  arcPaidServiceRequestSchema,
  circleAddressSchema,
  circleServiceSearchInputSchema,
  createArcPaidServiceQuoteBinding,
  createArcPaidServiceRequestHash,
  parseArcPaidServiceProof,
  uuidV4Schema,
  type ArcAgentCommerceReceipt,
  type ArcPaidServiceProof,
  type ArcPaidServiceQuoteBinding,
  type ArcPaidServiceRequest,
  type CircleServiceQuote,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { CircleCli } from "../services/circle-cli.ts";
import type { CompliancePaymentGate } from "../services/circle-compliance.ts";

const DEFAULT_QUOTE_TTL_MS = 300_000;
const MAX_SERVICE_RESPONSE_BYTES = 65_536;

const inspectPaidServiceInputSchema = arcPaidServiceRequestSchema;
const payPaidServiceInputSchema = z
  .object({
    idempotencyKey: uuidV4Schema,
    buyerAgentId: z.string().trim().min(1).max(256),
    sellerAgentId: z.string().trim().min(1).max(256),
    walletAddress: circleAddressSchema.optional(),
    request: arcPaidServiceRequestSchema,
    inspectedQuote: arcPaidServiceQuoteBindingSchema,
  })
  .strict();

export interface ArcAgentCommerceRepository {
  getByIdempotencyKey(idempotencyKey: string): Promise<ArcAgentCommerceReceipt | null>;
  claim(receipt: ArcAgentCommerceReceipt): Promise<{
    readonly claimed: boolean;
    readonly receipt: ArcAgentCommerceReceipt;
  }>;
  complete(
    receipt: ArcAgentCommerceReceipt,
    expectedStatus: "CLAIMED",
  ): Promise<ArcAgentCommerceReceipt>;
}

export interface ArcAgentCommerceSupabaseResult {
  readonly data: unknown;
  readonly error: { readonly message: string } | null;
}

export interface ArcAgentCommerceSupabaseQuery {
  select(columns?: string): ArcAgentCommerceSupabaseQuery;
  eq(column: string, value: unknown): ArcAgentCommerceSupabaseQuery;
  maybeSingle(): Promise<ArcAgentCommerceSupabaseResult>;
}

export interface ArcAgentCommerceSupabaseClient {
  from(table: string): ArcAgentCommerceSupabaseQuery;
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<ArcAgentCommerceSupabaseResult>;
}

const tenantIdSchema = z.string().uuid();
const commerceRowSchema = z.object({
  tenant_id: tenantIdSchema,
  idempotency_key: uuidV4Schema,
  buyer_agent_id: z.string(),
  seller_agent_id: z.string(),
  service_url: z.string(),
  request_hash: z.string(),
  quote_hash: z.string(),
  inspected_amount_atomic: z.string(),
  max_amount: z.string(),
  wallet_address: z.string(),
  payment_identifier: z.string(),
  status: z.enum(["CLAIMED", "SETTLED", "RECONCILIATION_REQUIRED"]),
  settlement_result: z.record(z.string(), z.unknown()).nullable(),
  proof: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export interface CircleServicesDependencies {
  readonly circleCli: CircleCli;
}

export interface InspectPaidServiceDependencies extends CircleServicesDependencies {
  readonly clock: () => Date;
  readonly quoteTtlMs?: number;
}

export interface PayPaidServiceDependencies extends CircleServicesDependencies {
  readonly commerce: ArcAgentCommerceRepository;
  readonly compliance: CompliancePaymentGate;
  readonly clock: () => Date;
}

export async function searchPaidServices(
  rawInput: unknown,
  dependencies: CircleServicesDependencies,
) {
  const input = circleServiceSearchInputSchema.parse(rawInput);
  const services = await dependencies.circleCli.searchServices(input);
  return Object.freeze({
    services: Object.freeze(services.map((service) => Object.freeze({ ...service }))),
  });
}

export async function inspectPaidService(
  rawInput: unknown,
  dependencies: InspectPaidServiceDependencies,
) {
  const request = inspectPaidServiceInputSchema.parse(rawInput);
  const quote = await inspectCompatibleQuote(request, dependencies.circleCli);
  const inspectedAt = dependencies.clock();
  const expiresAt = new Date(
    inspectedAt.getTime() + (dependencies.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS),
  );
  const binding = createArcPaidServiceQuoteBinding({
    request,
    amountAtomic: quote.price!.amount,
    seller: quote.seller!,
    inspectedAt: inspectedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return Object.freeze({
    quote: Object.freeze(binding),
    seller: quote.seller!,
    description: quote.description,
  });
}

export async function payPaidService(
  rawInput: unknown,
  dependencies: PayPaidServiceDependencies,
) {
  const input = payPaidServiceInputSchema.parse(rawInput);
  const now = dependencies.clock();

  assertQuoteRequestBinding(input.request, input.inspectedQuote);
  assertQuoteNotExpired(input.inspectedQuote, now);
  const fresh = await inspectCompatibleQuote(input.request, dependencies.circleCli);
  assertQuoteDidNotDrift(input.inspectedQuote, fresh);

  const wallet = await selectAuthenticatedWallet(
    dependencies.circleCli,
    input.walletAddress,
  );
  await assertBudget(
    dependencies.circleCli,
    wallet,
    input.inspectedQuote.amountAtomic,
  );

  const existing = await dependencies.commerce.getByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    assertReceiptMatches(existing, input, wallet);
    return immutablePaymentOutput(existing);
  }

  const timestamp = now.toISOString();
  const pending = arcAgentCommerceReceiptSchema.parse({
    idempotencyKey: input.idempotencyKey,
    buyerAgentId: input.buyerAgentId,
    sellerAgentId: input.sellerAgentId,
    serviceUrl: input.request.url,
    requestHash: input.inspectedQuote.requestHash,
    quoteHash: input.inspectedQuote.quoteHash,
    inspectedAmountAtomic: input.inspectedQuote.amountAtomic,
    maxAmount: input.inspectedQuote.amount,
    walletAddress: wallet,
    paymentIdentifier: createPaymentIdentifier(input.idempotencyKey),
    status: "CLAIMED",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const claim = await dependencies.commerce.claim(pending);
  assertReceiptMatches(claim.receipt, input, wallet);
  if (!claim.claimed) {
    return immutablePaymentOutput(claim.receipt);
  }
  if (claim.receipt.status !== "CLAIMED" || claim.receipt.proof) {
    throw new Error("Paid service atomic claim returned an ambiguous state.");
  }

  try {
    await assertComplianceAllowed(dependencies.compliance, {
      operationId: claim.receipt.idempotencyKey,
      address: fresh.seller!,
      direction: "SEND",
      channel: "AGENT_WALLET_PAID_SERVICE",
    });
    const payment = await dependencies.circleCli.payService({
      ...input.request,
      address: wallet,
      maxAmount: input.inspectedQuote.amount,
    });
    assertPaymentMatchesQuote(payment.payment, fresh, input.inspectedQuote);
    const serviceResponse = boundedClone(payment.response);
    const proof = extractProof(payment.payment, wallet);
    const settled = arcAgentCommerceReceiptSchema.parse({
      ...claim.receipt,
      status: "SETTLED",
      settlementResult: {
        success: true,
        amount: payment.payment.amount,
        chain: payment.payment.chain,
        scheme: payment.payment.scheme,
        seller: payment.payment.seller,
      },
      proof,
      updatedAt: dependencies.clock().toISOString(),
    });
    const persisted = await dependencies.commerce.complete(settled, "CLAIMED");
    return immutablePaymentOutput(persisted, serviceResponse);
  } catch (error) {
    const reconciliation = arcAgentCommerceReceiptSchema.parse({
      ...claim.receipt,
      status: "RECONCILIATION_REQUIRED",
      settlementResult: {
        success: false,
        outcome: error instanceof ComplianceBlockedError
          ? "COMPLIANCE_BLOCKED"
          : "UNKNOWN",
      },
      updatedAt: dependencies.clock().toISOString(),
    });
    try {
      return immutablePaymentOutput(
        await dependencies.commerce.complete(reconciliation, "CLAIMED"),
      );
    } catch {
      return immutablePaymentOutput(claim.receipt);
    }
  }
}

async function assertComplianceAllowed(
  gate: CompliancePaymentGate | undefined,
  input: Parameters<CompliancePaymentGate["screen"]>[0],
): Promise<void> {
  if (!gate) {
    throw new ComplianceBlockedError();
  }
  try {
    const result = await gate.screen(input);
    if (!result.allowed) {
      throw new ComplianceBlockedError();
    }
  } catch {
    throw new ComplianceBlockedError();
  }
}

class ComplianceBlockedError extends Error {
  constructor() {
    super("Payment blocked because compliance approval is unavailable.");
  }
}

export function createSearchPaidServicesHandler(dependencies: CircleServicesDependencies) {
  return (input: unknown) => searchPaidServices(input, dependencies);
}

export function createInspectPaidServiceHandler(dependencies: InspectPaidServiceDependencies) {
  return (input: unknown) => inspectPaidService(input, dependencies);
}

export function createPayPaidServiceHandler(dependencies: PayPaidServiceDependencies) {
  return (input: unknown) => payPaidService(input, dependencies);
}

export function createTenantArcAgentCommerceRepository(
  client: ArcAgentCommerceSupabaseClient,
  trustedTenantId: string,
): ArcAgentCommerceRepository {
  const tenantId = tenantIdSchema.parse(trustedTenantId);
  return {
    async getByIdempotencyKey(idempotencyKey) {
      const result = await client
        .from("arc_agent_commerce_receipts")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("idempotency_key", uuidV4Schema.parse(idempotencyKey))
        .maybeSingle();
      if (result.error) throw new Error("Arc agent commerce receipt read failed.");
      return result.data === null ? null : mapCommerceRow(result.data, tenantId);
    },
    async claim(receipt) {
      const result = await client.rpc("claim_arc_agent_commerce_receipt", {
        p_tenant_id: tenantId,
        p_receipt: receipt,
      });
      if (result.error) throw new Error("Arc agent commerce atomic claim failed.");
      const parsed = z.object({
        claimed: z.boolean(),
        receipt: commerceRowSchema,
      }).strict().parse(result.data);
      return {
        claimed: parsed.claimed,
        receipt: mapCommerceRow(parsed.receipt, tenantId),
      };
    },
    async complete(receipt, expectedStatus) {
      if (expectedStatus !== "CLAIMED") {
        throw new Error("Arc agent commerce completion expected status is invalid.");
      }
      const result = await client.rpc("complete_arc_agent_commerce_receipt", {
        p_tenant_id: tenantId,
        p_receipt: receipt,
      });
      if (result.error) throw new Error("Arc agent commerce completion failed.");
      return mapCommerceRow(result.data, tenantId);
    },
  };
}

export const searchPaidServicesTool = {
  name: "search_paid_services",
  description: "Search Circle's x402 service directory without making a payment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
} as const;

export const inspectPaidServiceTool = {
  name: "inspect_paid_service",
  description: "Inspect and bind an Arc Testnet USDC/Gateway paid-service quote.",
  inputSchema: requestJsonSchema(),
} as const;

export const payPaidServiceTool = {
  name: "pay_paid_service",
  description:
    "Autonomously pay one previously inspected Arc Testnet service from the selected Circle Agent Wallet budget.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "idempotencyKey",
      "buyerAgentId",
      "sellerAgentId",
      "request",
      "inspectedQuote",
    ],
    properties: {
      idempotencyKey: { type: "string", format: "uuid" },
      buyerAgentId: { type: "string", minLength: 1, maxLength: 256 },
      sellerAgentId: { type: "string", minLength: 1, maxLength: 256 },
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      request: requestJsonSchema(),
      inspectedQuote: {
        type: "object",
        additionalProperties: false,
        required: [
          "url", "method", "requestHash", "quoteHash", "amountAtomic", "amount", "seller",
          "token", "asset", "network", "scheme", "facilitatorUrl", "inspectedAt",
        ],
        properties: {
          url: { type: "string", format: "uri" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          requestHash: { type: "string", pattern: "^0x[a-f0-9]{64}$" },
          quoteHash: { type: "string", pattern: "^0x[a-f0-9]{64}$" },
          amountAtomic: { type: "string", pattern: "^[1-9]\\d*$" },
          amount: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
          seller: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          token: { type: "string", const: "USDC" },
          asset: { type: "string", const: ARC_TESTNET_USDC_ADDRESS },
          network: { type: "string", const: ARC_TESTNET_CAIP2 },
          scheme: { type: "string", const: ARC_GATEWAY_SCHEME },
          facilitatorUrl: {
            type: "string",
            const: "https://gateway-api-testnet.circle.com",
          },
          inspectedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;

async function inspectCompatibleQuote(
  request: ArcPaidServiceRequest,
  circleCli: CircleCli,
): Promise<CircleServiceQuote> {
  const quote = await circleCli.inspectService(request);
  const method = quote.method?.toUpperCase() ?? request.method;
  const chains = quote.chains ?? [];
  if (
    quote.status !== "payable"
    || quote.httpStatus !== 402
    || quote.url !== request.url
    || method !== request.method
    || !quote.price
    || !quote.seller
    || !chains.some((chain) => chain === ARC_TESTNET_CAIP2 || chain === CIRCLE_ARC_CHAIN || chain === "Arc Testnet")
    || quote.scheme?.toLowerCase() !== ARC_GATEWAY_SCHEME
  ) {
    throw new Error("Paid service quote is not compatible with Arc Testnet USDC Gateway.");
  }
  return quote;
}

function assertQuoteRequestBinding(
  request: ArcPaidServiceRequest,
  quote: ArcPaidServiceQuoteBinding,
): void {
  if (
    quote.url !== request.url
    || quote.method !== request.method
    || quote.requestHash !== createArcPaidServiceRequestHash(request)
  ) {
    throw new Error("Paid service request does not match the inspected quote.");
  }
}

function assertQuoteNotExpired(quote: ArcPaidServiceQuoteBinding, now: Date): void {
  if (!quote.expiresAt || new Date(quote.expiresAt).getTime() <= now.getTime()) {
    throw new Error("Paid service quote has expired.");
  }
}

function assertQuoteDidNotDrift(
  quote: ArcPaidServiceQuoteBinding,
  fresh: CircleServiceQuote,
): void {
  if (
    fresh.price?.amount !== quote.amountAtomic
    || fresh.seller?.toLowerCase() !== quote.seller.toLowerCase()
    || fresh.url !== quote.url
    || (fresh.method?.toUpperCase() ?? quote.method) !== quote.method
  ) {
    throw new Error("Paid service quote changed after inspection.");
  }
}

async function selectAuthenticatedWallet(
  circleCli: CircleCli,
  requested: string | undefined,
): Promise<string> {
  const session = await circleCli.status();
  if (session.type !== "agent" || session.testnet.tokenStatus !== "VALID") {
    throw new Error("Circle Agent Wallet testnet authentication is required.");
  }
  const wallets = await circleCli.listAgentWallets();
  const wallet = requested
    ? wallets.find((candidate) => candidate.address.toLowerCase() === requested.toLowerCase())
    : wallets.length === 1 ? wallets[0] : undefined;
  if (!wallet || wallet.type !== "agent" || wallet.blockchain !== CIRCLE_ARC_CHAIN) {
    throw new Error("Select one authenticated Arc Circle Agent Wallet.");
  }
  return wallet.address;
}

async function assertBudget(
  circleCli: CircleCli,
  wallet: string,
  requiredAtomic: string,
): Promise<void> {
  const [onchain, gateway] = await Promise.all([
    circleCli.getBalance(wallet),
    circleCli.getGatewayBalance(wallet),
  ]);
  const onchainAtomic = onchain.balances
    .filter((balance) => balance.token.symbol === "USDC")
    .reduce((sum, balance) => sum + parseUsdcDecimal(balance.amount), 0n);
  const available = onchainAtomic + parseUsdcDecimal(gateway.total);
  if (available < BigInt(requiredAtomic)) {
    throw new Error("Selected Circle Agent Wallet budget is insufficient.");
  }
}

function parseUsdcDecimal(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Circle returned an invalid USDC budget amount.");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function assertReceiptMatches(
  receipt: ArcAgentCommerceReceipt,
  input: z.output<typeof payPaidServiceInputSchema>,
  wallet: string,
): void {
  if (
    receipt.idempotencyKey !== input.idempotencyKey
    || receipt.buyerAgentId !== input.buyerAgentId
    || receipt.sellerAgentId !== input.sellerAgentId
    || receipt.serviceUrl !== input.request.url
    || receipt.requestHash !== input.inspectedQuote.requestHash
    || receipt.quoteHash !== input.inspectedQuote.quoteHash
    || receipt.inspectedAmountAtomic !== input.inspectedQuote.amountAtomic
    || receipt.maxAmount !== input.inspectedQuote.amount
    || receipt.walletAddress.toLowerCase() !== wallet.toLowerCase()
  ) {
    throw new Error("Paid service idempotency replay conflicts with persisted input.");
  }
}

function assertPaymentMatchesQuote(
  payment: {
    amount: string;
    chain: string;
    scheme: string;
    seller: string;
  },
  quote: CircleServiceQuote,
  binding: ArcPaidServiceQuoteBinding,
): void {
  if (
    parseUsdcDecimal(payment.amount) !== BigInt(binding.amountAtomic)
    || payment.chain !== CIRCLE_ARC_CHAIN
    || payment.scheme.toLowerCase() !== ARC_GATEWAY_SCHEME
    || payment.seller.toLowerCase() !== quote.seller?.toLowerCase()
  ) {
    throw new Error("Circle paid-service settlement does not match the inspected quote.");
  }
}

function extractProof(
  payment: {
    receipt?: string;
    scheme: string;
    seller: string;
  },
  wallet: string,
): ArcPaidServiceProof {
  if (!payment.receipt || Buffer.byteLength(payment.receipt, "utf8") > 16_384) {
    throw new Error("Circle paid-service settlement proof is unavailable.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payment.receipt, "base64").toString("utf8"));
  } catch {
    throw new Error("Circle paid-service settlement proof is invalid.");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Circle paid-service settlement proof is invalid.");
  }
  const candidate = decoded as Record<string, unknown>;
  if (
    candidate.network !== ARC_TESTNET_CAIP2
    || typeof candidate.transaction !== "string"
    || !/^0x[a-fA-F0-9]{64}$/.test(candidate.transaction)
    || typeof candidate.payer !== "string"
    || !circleAddressSchema.safeParse(candidate.payer).success
    || candidate.payer.toLowerCase() !== wallet.toLowerCase()
  ) {
    throw new Error("Circle paid-service settlement proof is incomplete.");
  }
  return parseArcPaidServiceProof({
    network: candidate.network,
    scheme: payment.scheme,
    seller: payment.seller,
    transaction: candidate.transaction,
    payer: candidate.payer,
  });
}

function boundedClone(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_SERVICE_RESPONSE_BYTES) {
    throw new Error("Paid service response exceeded the allowed size.");
  }
  return JSON.parse(serialized) as unknown;
}

function immutablePaymentOutput(receipt: ArcAgentCommerceReceipt, serviceResponse?: unknown) {
  return Object.freeze({
    receipt: Object.freeze(structuredClone(receipt)),
    ...(serviceResponse === undefined ? {} : { serviceResponse }),
  });
}

function createPaymentIdentifier(idempotencyKey: string): string {
  return `agentpay-${idempotencyKey.replaceAll("-", "")}`;
}

function requestJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", format: "uri", maxLength: 2_048 },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        default: "GET",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string", maxLength: 4_096 },
      },
      body: { type: "string", maxLength: 65_536 },
    },
  } as const;
}

function mapCommerceRow(raw: unknown, tenantId: string): ArcAgentCommerceReceipt {
  const row = commerceRowSchema.parse(raw);
  if (row.tenant_id !== tenantId) {
    throw new Error("Arc agent commerce repository returned another tenant.");
  }
  return arcAgentCommerceReceiptSchema.parse({
    idempotencyKey: row.idempotency_key,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    serviceUrl: row.service_url,
    requestHash: row.request_hash,
    quoteHash: row.quote_hash,
    inspectedAmountAtomic: row.inspected_amount_atomic,
    maxAmount: row.max_amount,
    walletAddress: row.wallet_address,
    paymentIdentifier: row.payment_identifier,
    status: row.status,
    ...(row.settlement_result ? { settlementResult: row.settlement_result } : {}),
    ...(row.proof ? { proof: row.proof } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
