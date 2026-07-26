import {
  ARC_GATEWAY_FACILITATOR_URL,
  ARC_GATEWAY_SCHEME,
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_USDC_ADDRESS,
  arcPaidServiceUrlSchema,
  circleAddressSchema,
  normalizeX402BazaarResource,
  type ArcPaidServiceProof,
  type ParsedSearchX402ServicesInput,
  type X402BazaarResource,
} from "@agentpay-ai/shared-arc";
import {
  createGatewayMiddleware,
  type GatewayMiddlewareConfig,
} from "@circle-fin/x402-batching/server";
import { z } from "zod";

import type { X402BazaarDiscoveryProvider } from "../tools/x402-bazaar.ts";

export const DEFAULT_X402_BAZAAR_FACILITATOR_URL = "https://x402.org/facilitator";

export interface X402BazaarDiscoveryProviderConfig {
  facilitatorUrl?: string;
  fetch?: typeof fetch;
}

export interface ArcGatewaySellerSettlementRecord {
  readonly paymentIdentifier: string;
  readonly buyerAgentId: string;
  readonly sellerAgentId: string;
  readonly serviceUrl: string;
  readonly amountAtomic: string;
  readonly maxAmount: string;
  readonly network: typeof ARC_TESTNET_CAIP2;
  readonly asset: typeof ARC_TESTNET_USDC_ADDRESS;
  readonly status: "CLAIMED" | "SETTLED";
  readonly settlementResult?: Readonly<Record<string, unknown>>;
  readonly proof?: ArcPaidServiceProof;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcGatewaySellerSettlementRepository {
  claim(record: ArcGatewaySellerSettlementRecord): Promise<{
    readonly claimed: boolean;
    readonly record: ArcGatewaySellerSettlementRecord;
  }>;
  complete(
    record: ArcGatewaySellerSettlementRecord,
    expectedStatus?: "CLAIMED",
  ): Promise<ArcGatewaySellerSettlementRecord>;
}

export interface ArcGatewaySellerSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    readonly data: unknown;
    readonly error: { readonly message: string } | null;
  }>;
}

type SellerRequest = {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
};
type SellerResponse = {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): void;
  end(chunk?: string): void;
};
type SellerNext = (error?: unknown) => void | Promise<void>;

export interface ArcGatewayMiddlewareLike {
  require(price: string): (
    request: SellerRequest,
    response: SellerResponse,
    next: SellerNext,
  ) => void | Promise<void>;
  onBeforeSettle(hook: (context: any) => Promise<any>): ArcGatewayMiddlewareLike;
  onAfterSettle(hook: (context: any) => Promise<void>): ArcGatewayMiddlewareLike;
}

export interface ArcGatewayPaidServiceConfig {
  readonly sellerAddress: string;
  readonly sellerAgentId: string;
  readonly resourceUrl: string;
  readonly price: string;
  readonly description?: string;
  readonly repository: ArcGatewaySellerSettlementRepository;
  readonly clock: () => Date;
  readonly gatewayFactory?: (
    config: GatewayMiddlewareConfig,
  ) => ArcGatewayMiddlewareLike;
}

const sellerConfigSchema = z.object({
  sellerAddress: circleAddressSchema,
  sellerAgentId: z.string().trim().min(1).max(256),
  resourceUrl: arcPaidServiceUrlSchema,
  price: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
    .refine((value) => /[1-9]/.test(value), "Expected a positive USDC price"),
  description: z.string().trim().min(1).max(1_024).optional(),
}).strict();

export function createArcGatewayPaidService(
  config: ArcGatewayPaidServiceConfig,
) {
  const parsed = sellerConfigSchema.parse({
    sellerAddress: config.sellerAddress,
    sellerAgentId: config.sellerAgentId,
    resourceUrl: config.resourceUrl,
    price: config.price,
    description: config.description,
  });
  const amountAtomic = parseUsdcPrice(parsed.price).toString();
  const factory = config.gatewayFactory
    ?? ((gatewayConfig: GatewayMiddlewareConfig) =>
      createGatewayMiddleware(gatewayConfig) as unknown as ArcGatewayMiddlewareLike);
  const gateway = factory({
    sellerAddress: parsed.sellerAddress,
    networks: ARC_TESTNET_CAIP2,
    facilitatorUrl: ARC_GATEWAY_FACILITATOR_URL,
    description: parsed.description ?? "AgentPay paid service",
  });

  gateway.onBeforeSettle(async (context) => {
    const identity = parseSellerPaymentIdentity(context.paymentPayload);
    assertSellerRequirements(context.requirements, parsed.sellerAddress, amountAtomic);
    const pending = createSellerPending(identity, parsed, amountAtomic, config.clock());
    const election = await config.repository.claim(pending);
    assertSellerReplay(election.record, pending);
    if (election.claimed) {
      return undefined;
    }
    if (election.record.status !== "SETTLED" || !election.record.proof) {
      return {
        abort: true,
        reason: "Payment identifier has an unresolved settlement.",
      };
    }
    return {
      skip: true,
      result: {
        success: true,
        payer: election.record.proof.payer,
        transaction: election.record.proof.transaction ?? "",
        network: election.record.proof.network,
      },
    };
  });

  gateway.onAfterSettle(async (context) => {
    const identity = parseSellerPaymentIdentity(context.paymentPayload);
    const existing = await config.repository.claim(
      createSellerPending(identity, parsed, amountAtomic, config.clock()),
    );
    if (existing.record.status === "SETTLED") {
      return;
    }
    const result = context.result as Record<string, unknown>;
    const proof = Object.freeze({
      network: ARC_TESTNET_CAIP2,
      scheme: ARC_GATEWAY_SCHEME,
      seller: parsed.sellerAddress,
      ...(typeof result.transaction === "string"
        && /^0x[a-fA-F0-9]{64}$/.test(result.transaction)
        ? { transaction: result.transaction }
        : {}),
      ...(typeof result.payer === "string"
        && circleAddressSchema.safeParse(result.payer).success
        ? { payer: result.payer }
        : {}),
    }) satisfies ArcPaidServiceProof;
    await config.repository.complete(Object.freeze({
      ...existing.record,
      status: "SETTLED",
      settlementResult: Object.freeze({
        success: true,
        network: ARC_TESTNET_CAIP2,
        amount: amountAtomic,
      }),
      proof,
      updatedAt: config.clock().toISOString(),
    }), "CLAIMED");
  });

  const required = gateway.require(parsed.price);
  const expectedPath = new URL(parsed.resourceUrl).pathname
    + new URL(parsed.resourceUrl).search;
  return Object.freeze({
    handle: async (
      request: SellerRequest,
      response: SellerResponse,
      next: SellerNext,
    ) => {
      if (
        request.method?.toUpperCase() !== "GET"
        || request.url !== expectedPath
        || hasUnsafeSellerHeaders(request.headers)
        || serializedBytes(request.body) > 65_536
      ) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: "Unsafe paid service request." }));
        return;
      }
      await required(request, response, async (error?: unknown) => {
        if (error) {
          await next(error);
          return;
        }
        const paymentHeader = request.headers["payment-signature"];
        if (typeof paymentHeader === "string") {
          const payload = decodeSellerPaymentHeader(paymentHeader);
          const identity = parseSellerPaymentIdentity(payload);
          const durable = await config.repository.claim(
            createSellerPending(identity, parsed, amountAtomic, config.clock()),
          );
          if (durable.record.status !== "SETTLED" || !durable.record.proof) {
            throw new Error("Gateway settlement was not durably recorded.");
          }
        }
        await next();
      });
    },
    terms: Object.freeze({
      network: ARC_TESTNET_CAIP2,
      facilitatorUrl: ARC_GATEWAY_FACILITATOR_URL,
      asset: ARC_TESTNET_USDC_ADDRESS,
      token: "USDC" as const,
      scheme: ARC_GATEWAY_SCHEME,
      amountAtomic,
    }),
  });
}

export function createTenantArcGatewaySellerSettlementRepository(
  client: ArcGatewaySellerSupabaseClient,
  trustedTenantId: string,
): ArcGatewaySellerSettlementRepository {
  const tenantId = z.string().uuid().parse(trustedTenantId);
  return {
    async claim(record) {
      const result = await client.rpc("claim_arc_gateway_seller_settlement", {
        p_tenant_id: tenantId,
        p_record: record,
      });
      if (result.error) throw new Error("Arc Gateway seller atomic claim failed.");
      const parsed = z.object({
        claimed: z.boolean(),
        record: sellerSettlementRowSchema,
      }).strict().parse(result.data);
      return {
        claimed: parsed.claimed,
        record: mapSellerSettlementRow(parsed.record, tenantId),
      };
    },
    async complete(record) {
      const result = await client.rpc("complete_arc_gateway_seller_settlement", {
        p_tenant_id: tenantId,
        p_record: record,
      });
      if (result.error) throw new Error("Arc Gateway seller completion failed.");
      return mapSellerSettlementRow(result.data, tenantId);
    },
  };
}

interface X402BazaarSearchResponse {
  resources?: unknown[];
  partialResults?: boolean;
  pagination?: {
    cursor?: string | null;
  } | null;
}

const sellerSettlementRowSchema = z.object({
  tenant_id: z.string().uuid(),
  payment_identifier: z.string(),
  buyer_agent_id: z.string(),
  seller_agent_id: z.string(),
  service_url: z.string(),
  amount_atomic: z.string(),
  max_amount: z.string(),
  network: z.literal(ARC_TESTNET_CAIP2),
  asset: z.string(),
  status: z.enum(["CLAIMED", "SETTLED"]),
  settlement_result: z.record(z.string(), z.unknown()).nullable(),
  proof: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export function createX402BazaarDiscoveryProvider(
  config: X402BazaarDiscoveryProviderConfig = {},
): X402BazaarDiscoveryProvider {
  const facilitatorUrl = (config.facilitatorUrl ?? DEFAULT_X402_BAZAAR_FACILITATOR_URL).replace(/\/+$/, "");
  const fetcher = config.fetch ?? fetch;

  return {
    async search(input: ParsedSearchX402ServicesInput) {
      const url = new URL(`${facilitatorUrl}/discovery/search`);
      url.searchParams.set("query", input.query);
      url.searchParams.set("type", input.type);

      if (input.network) {
        url.searchParams.set("network", input.network);
      }

      url.searchParams.set("limit", input.limit.toString());

      if (input.cursor) {
        url.searchParams.set("cursor", input.cursor);
      }

      const response = await fetcher(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`x402 Bazaar search failed (${response.status}): ${errorText}`);
      }

      const body = (await response.json()) as X402BazaarSearchResponse;
      const resources: X402BazaarResource[] = (body.resources ?? []).map((resource) =>
        normalizeX402BazaarResource(resource),
      );

      return {
        resources,
        ...(body.pagination?.cursor ? { nextCursor: body.pagination.cursor } : {}),
        ...(body.partialResults !== undefined ? { partialResults: body.partialResults } : {}),
      };
    },
  };
}

function parseSellerPaymentIdentity(paymentPayload: unknown): {
  readonly paymentIdentifier: string;
  readonly buyerAgentId: string;
} {
  const parsed = z.object({
    extensions: z.object({
      "payment-identifier": z.object({
        info: z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
        }).passthrough(),
      }).passthrough(),
      agentpay: z.object({
        buyerAgentId: z.string().trim().min(1).max(256),
      }).passthrough(),
    }).passthrough().optional(),
    payload: z.object({
      authorization: z.object({
        from: circleAddressSchema,
        nonce: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      }).passthrough(),
    }).passthrough(),
  }).passthrough().parse(paymentPayload);
  return Object.freeze({
    paymentIdentifier:
      parsed.extensions?.["payment-identifier"]?.info.id
      ?? `gateway-${parsed.payload.authorization.nonce}`,
    buyerAgentId:
      parsed.extensions?.agentpay?.buyerAgentId
      ?? `circle-agent-wallet:${parsed.payload.authorization.from.toLowerCase()}`,
  });
}

function decodeSellerPaymentHeader(header: string): unknown {
  if (Buffer.byteLength(header, "utf8") > 65_536) {
    throw new Error("Gateway payment header exceeded the allowed size.");
  }
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
  } catch {
    throw new Error("Gateway payment header is invalid.");
  }
}

function createSellerPending(
  identity: { readonly paymentIdentifier: string; readonly buyerAgentId: string },
  seller: {
    readonly sellerAgentId: string;
    readonly resourceUrl: string;
  },
  amountAtomic: string,
  now: Date,
): ArcGatewaySellerSettlementRecord {
  const timestamp = now.toISOString();
  return Object.freeze({
    paymentIdentifier: identity.paymentIdentifier,
    buyerAgentId: identity.buyerAgentId,
    sellerAgentId: seller.sellerAgentId,
    serviceUrl: seller.resourceUrl,
    amountAtomic,
    maxAmount: formatUsdcAtomic(amountAtomic),
    network: ARC_TESTNET_CAIP2,
    asset: ARC_TESTNET_USDC_ADDRESS,
    status: "CLAIMED",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function assertSellerRequirements(
  raw: unknown,
  sellerAddress: string,
  amountAtomic: string,
): void {
  const requirements = z.object({
    scheme: z.literal(ARC_GATEWAY_SCHEME),
    network: z.literal(ARC_TESTNET_CAIP2),
    asset: z.string(),
    amount: z.string(),
    payTo: circleAddressSchema,
  }).passthrough().parse(raw);
  if (
    requirements.asset.toLowerCase() !== ARC_TESTNET_USDC_ADDRESS.toLowerCase()
    || requirements.amount !== amountAtomic
    || requirements.payTo.toLowerCase() !== sellerAddress.toLowerCase()
  ) {
    throw new Error("Gateway seller requirements do not match the hosted resource.");
  }
}

function assertSellerReplay(
  actual: ArcGatewaySellerSettlementRecord,
  expected: ArcGatewaySellerSettlementRecord,
): void {
  if (
    actual.paymentIdentifier !== expected.paymentIdentifier
    || actual.buyerAgentId !== expected.buyerAgentId
    || actual.sellerAgentId !== expected.sellerAgentId
    || actual.serviceUrl !== expected.serviceUrl
    || actual.amountAtomic !== expected.amountAtomic
    || actual.maxAmount !== expected.maxAmount
    || actual.network !== expected.network
    || actual.asset.toLowerCase() !== expected.asset.toLowerCase()
  ) {
    throw new Error("Gateway payment identifier conflicts with persisted settlement.");
  }
}

function parseUsdcPrice(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatUsdcAtomic(value: string): string {
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function hasUnsafeSellerHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  return Object.keys(headers).some((name) =>
    /^(?:authorization|cookie|host|proxy-authorization|set-cookie|transfer-encoding|x-api-key|x-auth-token|x-circle-api-key)$/i
      .test(name),
  );
}

function serializedBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function mapSellerSettlementRow(
  raw: unknown,
  tenantId: string,
): ArcGatewaySellerSettlementRecord {
  const row = sellerSettlementRowSchema.parse(raw);
  if (row.tenant_id !== tenantId) {
    throw new Error("Arc Gateway seller repository returned another tenant.");
  }
  return Object.freeze({
    paymentIdentifier: row.payment_identifier,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    serviceUrl: arcPaidServiceUrlSchema.parse(row.service_url),
    amountAtomic: z.string().regex(/^[1-9]\d*$/).parse(row.amount_atomic),
    maxAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).parse(row.max_amount),
    network: row.network,
    asset: z.literal(ARC_TESTNET_USDC_ADDRESS).parse(row.asset.toLowerCase()),
    status: row.status,
    ...(row.settlement_result ? { settlementResult: row.settlement_result } : {}),
    ...(row.proof ? { proof: row.proof as ArcPaidServiceProof } : {}),
    createdAt: z.string().datetime({ offset: true }).parse(row.created_at),
    updatedAt: z.string().datetime({ offset: true }).parse(row.updated_at),
  });
}
