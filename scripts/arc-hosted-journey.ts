import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ARC_TESTNET,
  arcPaymentStatusSchema,
  arcUsdcBalanceSchema,
  arcUsdcAmountSchema,
  circleAddressSchema,
  parseUsdcAtomic,
  uuidV4Schema,
  type ObservedService,
  type PurchaseObjective,
  type ArcPaymentStatus,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import {
  runGoldenJourney,
  type GoldenJourneyDependencies,
  type GoldenJourneyTrace,
} from "./arc-golden-journey.ts";

const MAX_HTTP_RESPONSE_BYTES = 64 * 1_024;
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const MINIMUM_OFFER_COUNT = 2;
const LIVE_CONFIRMATION = "I_UNDERSTAND_ARC_TESTNET_PAYMENT";
const HOSTED_ARC_CHAIN = "ARC-TESTNET";
const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

const httpsUrlSchema = z.string().url().superRefine((value, context) => {
  try {
    if (new URL(value).protocol !== "https:") {
      context.addIssue({ code: "custom", message: "HTTPS is required" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "URL is invalid" });
  }
});

const objectiveSchema = z.object({
  description: z.string().trim().min(1).max(512),
  maxPriceUsdc: arcUsdcAmountSchema,
  minimumFeedbackCount: z.number().int().min(0).max(1_000_000),
  minimumAverageScore: z.number().min(0).max(5),
  requireVerifiedEndpoint: z.boolean(),
}).strict();

const hostedOfferSchema = z.object({
  id: z.string().trim().min(1).max(128),
  priceUsdc: arcUsdcAmountSchema,
  token: z.literal("USDC"),
  chainId: z.literal(ARC_TESTNET.chainId),
  endpointDomainVerified: z.boolean(),
  feedbackCount: z.number().int().min(0).max(1_000_000),
  averageScore: z.number().min(0).max(5).nullable(),
  recipient: circleAddressSchema,
  resultUrl: httpsUrlSchema,
}).strict();

const offerFeedSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  offers: z.array(hostedOfferSchema).max(20),
}).strict();

const budgetSchema = z.object({
  walletAddress: circleAddressSchema,
  chain: z.literal(HOSTED_ARC_CHAIN),
  balances: z.array(z.object({
    symbol: z.string().trim().min(1).max(32),
    amount: arcUsdcBalanceSchema,
    address: circleAddressSchema.optional(),
  }).strict()).max(32),
}).strict();

const transferSchema = z.object({
  status: arcPaymentStatusSchema,
  transactionId: z.string().trim().max(256).optional(),
  transactionHash: txHashSchema.optional(),
  reconciliationRequired: z.boolean().optional(),
}).strict();

const receiptSchema = z.object({
  transactionId: z.string().trim().max(256).optional(),
  state: z.string().trim().min(1).max(64),
  txHash: txHashSchema.optional(),
}).strict();

const protectedResultSchema = z.object({
  serviceId: z.string().trim().min(1).max(128),
  transactionId: z.string().trim().min(1).max(256),
  content: z.string().min(1).max(MAX_HTTP_RESPONSE_BYTES),
}).strict();

const releaseShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "ARC_RELEASE_SHA must be a 40-character commit SHA");
const hostedHealthSchema = z.object({
  ok: z.literal(true),
  version: z.string().trim().min(1).max(64),
  releaseSha: releaseShaSchema,
}).strict();

export type HostedOffer = z.output<typeof hostedOfferSchema>;

export interface HostedArcJourneyMcpClient {
  callTool(input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface HostedArcJourneyOptions {
  readonly mcp: HostedArcJourneyMcpClient;
  readonly offersUrl: string | URL;
  readonly objective: PurchaseObjective;
  readonly idempotencyKey: string;
  readonly mode: "LIVE" | "SIMULATED";
  readonly hostedMcpUrl?: string | URL;
  readonly releaseHealthUrl?: string | URL;
  readonly releaseSha?: string;
  readonly allowLivePayments?: boolean;
  readonly allowedServiceOrigins?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
}

export interface HostedArcJourneyTrace {
  readonly schemaVersion: "agentpay.arc.hosted-journey/v1";
  readonly journeyId: string;
  readonly mode: "LIVE" | "SIMULATED";
  readonly releaseSha?: string;
  readonly hostedReleaseSha?: string;
  readonly releaseHealthOrigin?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly objective: PurchaseObjective;
  readonly offerFeed: {
    readonly sourceOrigin: string;
    readonly observedAt: string;
    readonly retrievedAt: string;
    readonly offerCount: number;
    readonly offerIds: readonly string[];
    readonly quoteDigest: string;
  };
  readonly wallet: {
    readonly address: string;
    readonly beforeUsdc: string;
    readonly afterUsdc?: string;
  };
  readonly journey: GoldenJourneyTrace;
  readonly outcome: GoldenJourneyTrace["outcome"];
  readonly receipt?: {
    readonly status: ArcPaymentStatus;
    readonly transactionId?: string;
    readonly transactionHash?: string;
    readonly explorerUrl?: string;
  };
  readonly resultDigest?: string;
}

export interface HostedArcJourneyEnv {
  readonly mode: "LIVE";
  readonly mcpUrl: string;
  readonly offersUrl: string;
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly releaseSha: string;
  readonly releaseHealthUrl: string;
  readonly objective: PurchaseObjective;
  readonly allowedServiceOrigins?: readonly string[];
}

export class HostedArcJourneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedArcJourneyError";
  }
}

/**
 * Run the exact decision loop against the hosted wallet surface and an
 * independently served paid-result contract. The caller never receives a
 * wallet secret and never sends a payment unless live mode was explicitly
 * enabled by its caller.
 */
export async function runHostedArcJourney(
  options: HostedArcJourneyOptions,
): Promise<HostedArcJourneyTrace> {
  const clock = options.clock ?? (() => new Date());
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, "timeoutMs");
  const journeyId = parseIdempotencyKey(options.idempotencyKey);
  const objective = Object.freeze(objectiveSchema.parse(options.objective) as PurchaseObjective);
  const releaseSha = options.releaseSha === undefined
    ? undefined
    : releaseShaSchema.parse(options.releaseSha);

  if (options.mode === "LIVE" && options.allowLivePayments !== true) {
    throw new HostedArcJourneyError(
      "Live Arc journey is disabled; set the explicit live-payment guard before running.",
    );
  }
  if (options.mode === "LIVE" && releaseSha === undefined) {
    throw new HostedArcJourneyError("Live Arc journey must be bound to an exact release SHA.");
  }

  const hostedMcpUrl = options.hostedMcpUrl === undefined
    ? undefined
    : parseHttpsUrl(options.hostedMcpUrl, "hosted MCP URL");
  let hostedReleaseSha: string | undefined;
  let releaseHealthOrigin: string | undefined;
  if (options.mode === "LIVE") {
    if (!hostedMcpUrl) {
      throw new HostedArcJourneyError("Live Arc journey must identify the hosted MCP origin.");
    }
    const healthUrl = options.releaseHealthUrl === undefined
      ? new URL("/healthz", hostedMcpUrl)
      : parseHttpsUrl(options.releaseHealthUrl, "release health URL");
    if (healthUrl.origin !== hostedMcpUrl.origin) {
      throw new HostedArcJourneyError("Release health must come from the hosted MCP origin.");
    }
    const health = hostedHealthSchema.parse(await fetchJson(healthUrl, fetcher, timeoutMs));
    hostedReleaseSha = health.releaseSha.toLowerCase();
    if (hostedReleaseSha !== releaseSha!.toLowerCase()) {
      throw new HostedArcJourneyError("Hosted release SHA does not match the requested release.");
    }
    releaseHealthOrigin = healthUrl.origin;
  }

  const offersUrl = parseHttpsUrl(options.offersUrl, "offers URL");
  const allowedOrigins = new Set(
    (options.allowedServiceOrigins ?? [offersUrl.origin]).map((origin) =>
      parseHttpsUrl(origin, "service origin").origin,
    ),
  );
  const startedAt = clock().toISOString();
  const budgetBefore = await readHostedBudget(options.mcp);
  const feedBody = await fetchJson(offersUrl, fetcher, timeoutMs);
  const feed = parseOfferFeed(feedBody, allowedOrigins);
  const retrievedAt = clock().toISOString();
  const offers = feed.offers;
  const observed = offers.map((offer) => Object.freeze({
    id: offer.id,
    priceUsdc: offer.priceUsdc,
    availableBalanceUsdc: budgetBefore.balanceUsdc,
    token: offer.token,
    chainId: offer.chainId,
    endpointDomainVerified: offer.endpointDomainVerified,
    feedbackCount: offer.feedbackCount,
    averageScore: offer.averageScore,
  })) satisfies readonly ObservedService[];
  const offerById = new Map(offers.map((offer) => [offer.id, offer] as const));
  let paymentStatus: ArcPaymentStatus | undefined;
  let paymentTransactionId: string | undefined;
  let paymentTransactionHash: string | undefined;

  const dependencies: GoldenJourneyDependencies = {
    async observe() {
      return observed;
    },
    async pay(service, idempotencyKey) {
      const offer = offerById.get(service.id);
      if (!offer || !sameObservedOffer(service, offer)) {
        throw new HostedArcJourneyError("Observed offer changed before payment.");
      }
      const transfer = transferSchema.parse(
        await callHostedTool(options.mcp, "send_usdc", {
          recipient: offer.recipient,
          amount: offer.priceUsdc,
          idempotencyKey,
        }),
      );
      paymentStatus = transfer.status;
      paymentTransactionId = transfer.transactionId;
      if (!transfer.transactionId) {
        const status = transfer.status === "COMPLETED"
          ? "RECONCILIATION_REQUIRED" as const
          : transfer.status;
        paymentStatus = status;
        return { status };
      }

      let receipt: z.output<typeof receiptSchema>;
      try {
        receipt = receiptSchema.parse(
          await callHostedTool(options.mcp, "get_payment_receipt", {
            transactionId: transfer.transactionId,
          }),
        );
      } catch {
        paymentStatus = "RECONCILIATION_REQUIRED";
        return {
          transactionId: transfer.transactionId,
          status: "RECONCILIATION_REQUIRED" as const,
        };
      }
      if (
        receipt.transactionId !== undefined
        && receipt.transactionId !== transfer.transactionId
      ) {
        throw new HostedArcJourneyError("Hosted receipt identity did not match the payment.");
      }
      const status = mapHostedPaymentState(receipt.state);
      paymentStatus = status;
      if (
        receipt.txHash !== undefined
        && transfer.transactionHash !== undefined
        && receipt.txHash.toLowerCase() !== transfer.transactionHash.toLowerCase()
      ) {
        paymentStatus = "RECONCILIATION_REQUIRED";
        return {
          transactionId: transfer.transactionId,
          status: "RECONCILIATION_REQUIRED" as const,
        };
      }
      const observedTransactionHash = receipt.txHash ?? transfer.transactionHash;
      if (status === "COMPLETED" && observedTransactionHash === undefined) {
        paymentStatus = "RECONCILIATION_REQUIRED";
        return {
          transactionId: transfer.transactionId,
          status: "RECONCILIATION_REQUIRED" as const,
        };
      }
      paymentTransactionHash = status === "COMPLETED"
        ? observedTransactionHash?.toLowerCase()
        : undefined;
      return {
        transactionId: transfer.transactionId,
        status,
      };
    },
    async fetchResult(service, transactionId) {
      const offer = offerById.get(service.id);
      if (!offer || !sameObservedOffer(service, offer)) {
        throw new HostedArcJourneyError("Protected result offer binding is invalid.");
      }
      const body = await fetchJson(
        parseHttpsUrl(offer.resultUrl, "protected result URL"),
        fetcher,
        timeoutMs,
        {
          accept: "application/json",
          "x-agentpay-service-id": offer.id,
          "x-agentpay-transaction-id": transactionId,
          "x-agentpay-idempotency-key": journeyId,
        },
      );
      const result = protectedResultSchema.parse(body);
      if (result.serviceId !== offer.id || result.transactionId !== transactionId) {
        throw new HostedArcJourneyError("Protected result binding did not match the payment.");
      }
      return result.content;
    },
  };

  const journey = await runGoldenJourney(objective, dependencies, journeyId);
  let budgetAfter: HostedBudget | undefined;
  if (journey.outcome === "PAID") {
    budgetAfter = await readHostedBudget(options.mcp);
    if (budgetAfter.walletAddress.toLowerCase() !== budgetBefore.walletAddress.toLowerCase()) {
      throw new HostedArcJourneyError("Hosted wallet identity changed during the journey.");
    }
  }

  const completedAt = clock().toISOString();
  const trace: HostedArcJourneyTrace = {
    schemaVersion: "agentpay.arc.hosted-journey/v1",
    journeyId,
    mode: options.mode,
    ...(releaseSha ? { releaseSha } : {}),
    ...(hostedReleaseSha ? { hostedReleaseSha } : {}),
    ...(releaseHealthOrigin ? { releaseHealthOrigin } : {}),
    startedAt,
    completedAt,
    objective,
    offerFeed: {
      sourceOrigin: offersUrl.origin,
      observedAt: feed.observedAt,
      retrievedAt,
      offerCount: offers.length,
      offerIds: offers.map(({ id }) => id),
      quoteDigest: digestJson(offers),
    },
    wallet: {
      address: budgetBefore.walletAddress,
      beforeUsdc: budgetBefore.balanceUsdc,
      ...(budgetAfter ? { afterUsdc: budgetAfter.balanceUsdc } : {}),
    },
    journey,
    outcome: journey.outcome,
    ...(paymentStatus
      ? {
          receipt: {
            status: paymentStatus,
            ...(paymentTransactionId ? { transactionId: paymentTransactionId } : {}),
            ...(paymentTransactionHash
              ? {
                  transactionHash: paymentTransactionHash,
                  explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${paymentTransactionHash}`,
                }
              : {}),
          },
        }
      : {}),
    ...(journey.result !== undefined ? { resultDigest: digestText(journey.result) } : {}),
  };
  return deepFreeze(trace);
}

export async function connectHostedArcMcp(options: {
  readonly mcpUrl: string;
  readonly accessToken: string;
}): Promise<HostedArcJourneyMcpClient & { close(): Promise<void> }> {
  const mcpUrl = parseHttpsUrl(options.mcpUrl, "hosted MCP URL");
  const accessToken = validateAccessToken(options.accessToken);
  const client = new Client({ name: "agentpay-arc-journey", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  });
  try {
    await client.connect(transport);
  } catch {
    throw new HostedArcJourneyError("Hosted MCP connection failed.");
  }
  return {
    async callTool(input) {
      return client.callTool({
        name: input.name,
        arguments: input.arguments,
      });
    },
    async close() {
      await client.close();
    },
  };
}

export function parseHostedArcJourneyEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostedArcJourneyEnv {
  if (env.ARC_JOURNEY_LIVE !== "1") {
    throw new HostedArcJourneyError("Set ARC_JOURNEY_LIVE=1 to opt into a live Arc testnet payment.");
  }
  if (env.ARC_JOURNEY_CONFIRM !== LIVE_CONFIRMATION) {
    throw new HostedArcJourneyError("Explicit live-payment confirmation is required.");
  }

  const mcpUrlObject = parseHttpsUrl(requiredEnv(env, "ARC_JOURNEY_MCP_URL"), "hosted MCP URL");
  const mcpUrl = mcpUrlObject.toString();
  const releaseHealthUrl = new URL("/healthz", mcpUrlObject).toString();
  const offersUrl = parseHttpsUrl(requiredEnv(env, "ARC_JOURNEY_OFFERS_URL"), "offers URL").toString();
  const accessToken = validateAccessToken(requiredEnv(env, "ARC_JOURNEY_ACCESS_TOKEN"));
  const idempotencyKey = parseIdempotencyKey(requiredEnv(env, "ARC_JOURNEY_IDEMPOTENCY_KEY"));
  const releaseSha = releaseShaSchema.parse(requiredEnv(env, "ARC_RELEASE_SHA"));
  const allowedServiceOrigins = env.ARC_JOURNEY_SERVICE_ORIGINS === undefined
    ? undefined
    : env.ARC_JOURNEY_SERVICE_ORIGINS.split(",").map((origin) =>
      parseHttpsUrl(origin.trim(), "service origin").origin,
    );
  const objective = objectiveSchema.parse({
    description: env.ARC_JOURNEY_OBJECTIVE?.trim() || "Summarise one page",
    maxPriceUsdc: env.ARC_JOURNEY_MAX_PRICE_USDC?.trim() || "0.05",
    minimumFeedbackCount: parseIntegerEnv(env.ARC_JOURNEY_MIN_FEEDBACK_COUNT, 2),
    minimumAverageScore: parseNumberEnv(env.ARC_JOURNEY_MIN_AVERAGE_SCORE, 4),
    requireVerifiedEndpoint: env.ARC_JOURNEY_REQUIRE_VERIFIED_ENDPOINT !== "0",
  }) as PurchaseObjective;
  return Object.freeze({
    mode: "LIVE",
    mcpUrl,
    offersUrl,
    accessToken,
    idempotencyKey,
    releaseSha,
    releaseHealthUrl,
    objective,
    ...(allowedServiceOrigins ? { allowedServiceOrigins } : {}),
  });
}

async function callHostedTool(
  client: HostedArcJourneyMcpClient,
  name: "send_usdc" | "get_agent_budget" | "get_payment_receipt",
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  try {
    const response = await client.callTool({ name, arguments: args });
    if (isRecord(response) && response.isError === true) {
      throw new HostedArcJourneyError(`Hosted MCP ${name} call failed.`);
    }
    // The SDK returns structuredContent. Keeping the raw fallback makes the
    // adapter straightforward to test without weakening the production parse.
    return isRecord(response) && "structuredContent" in response
      ? response.structuredContent
      : response;
  } catch (error) {
    if (error instanceof HostedArcJourneyError) throw error;
    throw new HostedArcJourneyError(`Hosted MCP ${name} call failed.`);
  }
}

interface HostedBudget {
  readonly walletAddress: string;
  readonly balanceUsdc: string;
}

async function readHostedBudget(client: HostedArcJourneyMcpClient): Promise<HostedBudget> {
  const output = budgetSchema.parse(await callHostedTool(client, "get_agent_budget", {}));
  const usdc = output.balances.filter(({ symbol }) => symbol.toUpperCase() === "USDC");
  if (usdc.length > 1) {
    throw new HostedArcJourneyError("Hosted budget returned multiple USDC views; refusing to double-count.");
  }
  return Object.freeze({
    walletAddress: output.walletAddress,
    balanceUsdc: usdc[0]?.amount ?? "0",
  });
}

function parseOfferFeed(
  body: unknown,
  allowedOrigins: ReadonlySet<string>,
): z.output<typeof offerFeedSchema> {
  let parsed: z.output<typeof offerFeedSchema>;
  try {
    parsed = offerFeedSchema.parse(body);
  } catch {
    throw new HostedArcJourneyError("Offer feed did not match the bounded Arc offer contract.");
  }
  if (new Set(parsed.offers.map(({ id }) => id)).size !== parsed.offers.length) {
    throw new HostedArcJourneyError("Offer feed contains duplicate service identities.");
  }
  if (parsed.offers.length < MINIMUM_OFFER_COUNT) {
    throw new HostedArcJourneyError("Offer feed must contain at least two offers.");
  }
  for (const offer of parsed.offers) {
    if (!allowedOrigins.has(new URL(offer.resultUrl).origin)) {
      throw new HostedArcJourneyError("Offer result origin is outside the configured service allowlist.");
    }
  }
  return parsed;
}

function sameObservedOffer(service: ObservedService, offer: HostedOffer): boolean {
  return service.id === offer.id
    && service.priceUsdc === offer.priceUsdc
    && service.token === offer.token
    && service.chainId === offer.chainId
    && service.endpointDomainVerified === offer.endpointDomainVerified
    && service.feedbackCount === offer.feedbackCount
    && service.averageScore === offer.averageScore;
}

function mapHostedPaymentState(state: string): ArcPaymentStatus {
  switch (state.trim().toUpperCase()) {
    case "PENDING":
      return "PENDING";
    case "SUBMITTING":
      return "SUBMITTING";
    case "SUBMITTED":
      return "SUBMITTED";
    case "COMPLETE":
    case "COMPLETED":
    case "CONFIRMED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "RECONCILIATION_REQUIRED":
      return "RECONCILIATION_REQUIRED";
    default:
      return "RECONCILIATION_REQUIRED";
  }
}

async function fetchJson(
  url: URL,
  fetcher: typeof fetch,
  timeoutMs: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...headers,
      },
      redirect: "error",
      signal: controller.signal,
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_HTTP_RESPONSE_BYTES)) {
      throw new HostedArcJourneyError("Arc journey HTTP response exceeded the size limit.");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
      throw new HostedArcJourneyError("Arc journey HTTP response must be JSON.");
    }
    if (!response.ok) {
      throw new HostedArcJourneyError(`Arc journey HTTP request returned ${response.status}.`);
    }
    const text = await readBoundedBody(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HostedArcJourneyError("Arc journey HTTP response was not valid JSON.");
    }
  } catch (error) {
    if (error instanceof HostedArcJourneyError) throw error;
    throw new HostedArcJourneyError("Arc journey HTTP request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_HTTP_RESPONSE_BYTES) {
        throw new HostedArcJourneyError("Arc journey HTTP response exceeded the size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseHttpsUrl(value: string | URL, label: string): URL {
  try {
    const parsed = new URL(value.toString());
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.hash !== ""
    ) {
      throw new Error("Credential-free HTTPS required");
    }
    return parsed;
  } catch {
    throw new HostedArcJourneyError(`${label} must be an HTTPS URL.`);
  }
}

function validateAccessToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > 8_192 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new HostedArcJourneyError("Hosted MCP access token is invalid.");
  }
  return token;
}

function parseIdempotencyKey(value: string): string {
  try {
    return uuidV4Schema.parse(value);
  } catch {
    throw new HostedArcJourneyError("A valid UUID-v4 idempotency key is required.");
  }
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new HostedArcJourneyError(`${name} is required.`);
  return value;
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new HostedArcJourneyError("Journey integer configuration is invalid.");
  return Number(value);
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new HostedArcJourneyError("Journey score configuration is invalid.");
  return parsed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HostedArcJourneyError(`${label} must be a positive integer.`);
  }
  return value;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digestJson(value: unknown): string {
  return digestText(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

async function main(): Promise<void> {
  const config = parseHostedArcJourneyEnv();
  const client = await connectHostedArcMcp({
    mcpUrl: config.mcpUrl,
    accessToken: config.accessToken,
  });
  try {
    const trace = await runHostedArcJourney({
      mcp: client,
      offersUrl: config.offersUrl,
      objective: config.objective,
      idempotencyKey: config.idempotencyKey,
      mode: config.mode,
      hostedMcpUrl: config.mcpUrl,
      releaseHealthUrl: config.releaseHealthUrl,
      releaseSha: config.releaseSha,
      allowLivePayments: true,
      ...(config.allowedServiceOrigins
        ? { allowedServiceOrigins: config.allowedServiceOrigins }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Arc journey failed."}\n`);
    process.exitCode = 1;
  });
}
