import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Socket } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ArcEvmAddressSchema,
  ArcHostedAuthoritySchema,
  uuidV4Schema,
  arcUsdcAmountSchema,
  type ArcHostedAccount,
  type ArcHostedAuthority,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.js";
import {
  HOSTED_ARC_TOOL_NAMES,
  HOSTED_ARC_TOOL_REGISTRY,
  type HostedArcWalletRuntime,
} from "../runtime/hosted-arc-wallet-runtime.js";
import {
  ARC_HOSTED_MCP_PATH,
  ARC_HOSTED_OAUTH_SCOPES,
  parseHostedArcHttpConfig,
  type HostedArcBearerVerifier,
  type HostedArcHttpConfig,
  type HostedArcVerifiedBearer,
} from "./hosted-arc-http-config.js";
import type {
  HostedArcMutationCoordinator,
  HostedArcMutationOutput,
} from "./hosted-arc-mutation.js";
import {
  executeHostedArcApi,
  HostedArcApiError,
} from "./hosted-arc-http-api.js";

export {
  ARC_HOSTED_ALLOWED_ORIGIN,
  ARC_HOSTED_MCP_PATH,
  ARC_HOSTED_OAUTH_SCOPES,
  createSupabaseHostedArcBearerVerifier,
  parseHostedArcHttpConfig,
  type HostedArcBearerVerifier,
  type HostedArcHttpConfig,
  type HostedArcVerifiedBearer,
} from "./hosted-arc-http-config.js";
export {
  createHostedArcMutationCoordinator,
  type HostedArcMutationCoordinator,
  type HostedArcMutationInput,
  type HostedArcMutationOutput,
} from "./hosted-arc-mutation.js";

const SERVICE_VERSION = "0.1.11";
const MAX_BODY_BYTES = 64 * 1_024;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_CLIENTS = 1_024;
const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const API_PATHS = new Set([
  "/api/account/claim",
  "/api/account",
  "/api/wallet/provision",
  "/api/account/pause",
  "/api/account/resume",
  "/api/account/withdraw",
]);

export interface HostedArcHttpServer {
  readonly url: string;
  readonly mcpUrl: string;
  readonly healthUrl: string;
  readonly readinessUrl: string;
  close(): Promise<void>;
}
export interface StartHostedArcHttpServerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: HostedArcHttpConfig;
  readonly verifier: HostedArcBearerVerifier;
  readonly repository: ArcHostedAccountRepository;
  readonly provisionWallet: (
    authUserId: string,
  ) => Promise<{ readonly walletAddress: string; readonly status: "LIVE" }>;
  readonly createRuntime: (
    authority: ArcHostedAuthority,
  ) => HostedArcWalletRuntime;
  readonly mutationCoordinator: HostedArcMutationCoordinator;
  readonly readinessProbe: () => Promise<boolean>;
  readonly readinessTimeoutMs?: number;
  readonly rateLimitMaxRequests?: number;
  readonly clock?: () => Date;
}
export async function startHostedArcHttpServer(
  options: StartHostedArcHttpServerOptions,
): Promise<HostedArcHttpServer> {
  const config =
    options.config
    ?? parseHostedArcHttpConfig(options.env ?? process.env);
  const clock = options.clock ?? (() => new Date());
  const readinessTimeoutMs = parsePositiveInteger(
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    "readinessTimeoutMs",
  );
  const rateLimiter = createRateLimiter(
    parsePositiveInteger(
      options.rateLimitMaxRequests
        ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      "rateLimitMaxRequests",
    ),
    clock,
  );
  const server = createServer((request, response) => {
    applySecurityHeaders(response);
    void handleRequest({
      request,
      response,
      config,
      options,
      clock,
      readinessTimeoutMs,
      rateLimiter,
    }).catch((error: unknown) => {
      if (!response.headersSent) {
        const requestError =
          error instanceof HttpRequestError
            ? error
            : error instanceof HostedArcApiError
              ? new HttpRequestError(error.status, error.message)
            : error instanceof z.ZodError
              ? new HttpRequestError(400, "Invalid request")
              : new HttpRequestError(500, "Hosted Arc request failed");
        writeJson(response, requestError.status, {
          success: false,
          error: requestError.message,
        }, requestError.headers);
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  server.listen(config.port, config.hostname);
  await waitForListening(server);
  const address = server.address();
  const resolvedPort =
    typeof address === "object" && address ? address.port : config.port;
  const displayHost =
    config.hostname.includes(":")
      ? `[${config.hostname}]`
      : config.hostname;
  const url = `http://${displayHost}:${resolvedPort}`;

  return Object.freeze({
    url,
    mcpUrl: `${url}${ARC_HOSTED_MCP_PATH}`,
    healthUrl: `${url}/healthz`,
    readinessUrl: `${url}/readyz`,
    async close() {
      if (!server.listening) {
        return;
      }
      server.close();
      await once(server, "close");
    },
  });
}
interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: HostedArcHttpConfig;
  readonly options: StartHostedArcHttpServerOptions;
  readonly clock: () => Date;
  readonly readinessTimeoutMs: number;
  readonly rateLimiter: RateLimiter;
}
function extractClientIp(
  socket: Socket,
  forwardedFor: string | string[] | undefined,
): string {
  const remoteAddress = socket.remoteAddress ?? "unknown";
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1") {
    if (typeof forwardedFor === "string") {
      const firstIp = forwardedFor.split(",")[0].trim();
      if (isIP(firstIp) !== 0) {
        return firstIp;
      }
    }
  }
  return remoteAddress;
}

async function handleRequest(context: RequestContext): Promise<void> {
  const { request, response, config } = context;
  const url = parseAndValidateRequestUrl(request, config);
  const origin = validateOrigin(request, config);
  if (origin) {
    applyCorsHeaders(response, origin);
  }
  context.rateLimiter.assertAllowed(
    extractClientIp(request.socket, request.headers["x-forwarded-for"]),
  );
  if (request.method === "OPTIONS") {
    handlePreflight(request, response, origin);
    return;
  }

  if (url.search !== "") {
    throw new HttpRequestError(400, "Query parameters are not accepted");
  }
  if (METADATA_PATHS.has(url.pathname)) {
    requireMethod(request, "GET");
    writeJson(response, 200, {
      resource: config.resourceUrl,
      authorization_servers: [config.authIssuer],
      scopes_supported: ARC_HOSTED_OAUTH_SCOPES,
    });
    return;
  }
  if (url.pathname === "/healthz") {
    requireMethod(request, "GET");
    writeJson(response, 200, {
      ok: true,
      version: SERVICE_VERSION,
    });
    return;
  }
  if (url.pathname === "/readyz") {
    requireMethod(request, "GET");
    const ready = await boundedReadiness(
      context.options.readinessProbe,
      context.readinessTimeoutMs,
    );
    writeJson(response, ready ? 200 : 503, {
      ready,
      version: SERVICE_VERSION,
    });
    return;
  }
  if (url.pathname === ARC_HOSTED_MCP_PATH) {
    await handleMcpRequest(context);
    return;
  }
  if (API_PATHS.has(url.pathname)) {
    await handleApiRequest(context, url.pathname);
    return;
  }
  throw new HttpRequestError(404, "Route not found");
}
async function handleMcpRequest(context: RequestContext): Promise<void> {
  const { request, response, options } = context;
  requireMethod(request, "POST");
  rejectClientSessionId(request);
  requireJsonContentType(request);
  const body = await readJsonBody(request);
  const identity = await authenticate(context, true);
  const authority = await resolveAuthority(
    options.repository,
    identity,
  );
  const runtime = options.createRuntime(authority);
  assertExactRuntime(runtime);

  const mcpServer = createRequestMcpServer(
    runtime,
    authority,
    options.mutationCoordinator,
  );
  // Supabase issues `aud=authenticated`, not an RFC 8707 resource audience.
  // This stateless endpoint pins the resource through validated config plus
  // exact Host/path checks on every freshly verified request, and rejects all
  // client-controlled MCP session IDs instead of claiming session binding.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);
  try {
    await transport.handleRequest(request, response, body);
  } finally {
    await mcpServer.close();
  }
}
async function handleApiRequest(
  context: RequestContext,
  pathname: string,
): Promise<void> {
  const { request, response, options } = context;
  requireMethod(
    request,
    pathname === "/api/account" ? "GET" : "POST",
  );
  const identity = await authenticate(context, false);
  const body =
    pathname === "/api/account"
      ? undefined
      : await readApiBody(request);
  const result = await executeHostedArcApi({
    pathname,
    authUserId: identity.authUserId,
    body,
    repository: options.repository,
    provisionWallet: options.provisionWallet,
    resolveAuthority: () =>
      resolveAuthority(options.repository, identity),
    mutationCoordinator: options.mutationCoordinator,
  });
  writeJson(response, result.status, result.body);
}

function createRequestMcpServer(
  runtime: HostedArcWalletRuntime,
  authority: ArcHostedAuthority,
  mutationCoordinator: HostedArcMutationCoordinator,
): McpServer {
  const server = new McpServer({
    name: "agentpay-hosted-arc",
    version: SERVICE_VERSION,
  });
  for (const name of HOSTED_ARC_TOOL_NAMES) {
    const descriptor = HOSTED_ARC_TOOL_REGISTRY[name];
    server.registerTool(
      name,
      {
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      },
      async (rawInput: unknown) => {
        try {
          const input = descriptor.inputSchema.parse(rawInput);
          const output =
            name === "send_usdc"
              ? await dispatchHostedMutation(
                  authority,
                  input,
                  mutationCoordinator,
                )
              : await runtime.dispatch(name, input);
          return {
            structuredContent: toStructuredContent(output),
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(output),
              },
            ],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Hosted Arc tool request failed.",
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

async function dispatchHostedMutation(
  authority: ArcHostedAuthority,
  rawInput: unknown,
  coordinator: HostedArcMutationCoordinator,
): Promise<HostedArcMutationOutput> {
  const input = z
    .object({
      walletAddress: ArcEvmAddressSchema.optional(),
      recipient: ArcEvmAddressSchema,
      amount: arcUsdcAmountSchema,
      idempotencyKey: uuidV4Schema,
    })
    .strict()
    .parse(rawInput);
  if (
    input.walletAddress
    && input.walletAddress !== authority.walletAddress
  ) {
    throw new Error("Hosted wallet binding mismatch");
  }
  return coordinator.sendUsdc(authority, {
    destination: input.recipient,
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
    purpose: "Hosted MCP send_usdc",
  });
}

async function authenticate(
  context: RequestContext,
  requireOAuthClientId: boolean,
): Promise<HostedArcVerifiedBearer> {
  let token: string;
  try {
    token = parseBearer(context.request);
  } catch {
    throw unauthorized(context.config);
  }
  let verified: HostedArcVerifiedBearer;
  try {
    verified = await context.options.verifier.verifyAccessToken(token, {
      requireOAuthClientId,
    });
  } catch {
    throw unauthorized(context.config);
  }
  const nowEpochSeconds = Math.floor(
    context.clock().getTime() / 1_000,
  );
  if (
    verified.issuer !== context.config.authIssuer
    || verified.audience !== "authenticated"
    || verified.role !== "authenticated"
    || !Number.isSafeInteger(verified.expiresAtEpochSeconds)
    || verified.expiresAtEpochSeconds <= nowEpochSeconds
    || (requireOAuthClientId && !verified.oauthClientId)
  ) {
    throw unauthorized(context.config);
  }
  return Object.freeze({ ...verified });
}

async function resolveAuthority(
  repository: ArcHostedAccountRepository,
  identity: HostedArcVerifiedBearer,
): Promise<ArcHostedAuthority> {
  let authority: ArcHostedAuthority | null;
  let account: ArcHostedAccount | null;
  try {
    [authority, account] = await Promise.all([
      repository.resolveHostedAuthority({
        authUserId: identity.authUserId,
        ...(identity.oauthClientId
          ? { oauthClientId: identity.oauthClientId }
          : {}),
      }),
      repository.getHostedAccount(identity.authUserId),
    ]);
  } catch {
    throw new HttpRequestError(403, "Hosted authority is unavailable");
  }
  if (!authority) {
    throw new HttpRequestError(403, "Hosted authority is unavailable");
  }
  const parsed = ArcHostedAuthoritySchema.parse(authority);
  if (
    parsed.authUserId !== identity.authUserId
    || parsed.oauthClientId !== identity.oauthClientId
    || parsed.accountStatus !== "ACTIVE"
    || !account
    || account.authUserId !== identity.authUserId
    || account.tenantId !== parsed.tenantId
    || account.accountStatus !== "ACTIVE"
    || account.walletStatus !== "LIVE"
    || account.walletAddress !== parsed.walletAddress
  ) {
    throw new HttpRequestError(403, "Hosted authority is unavailable");
  }
  return Object.freeze({ ...parsed });
}

function parseBearer(request: IncomingMessage): string {
  const raw = request.headers.authorization;
  if (
    typeof raw !== "string"
    || raw.length > 8_192
    || raw.includes(",")
  ) {
    throw new HttpRequestError(401, "Bearer authentication required");
  }
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(raw);
  if (!match) {
    throw new HttpRequestError(401, "Bearer authentication required");
  }
  return match[1];
}
function parseAndValidateRequestUrl(
  request: IncomingMessage,
  config: HostedArcHttpConfig,
): URL {
  const host = request.headers.host;
  if (typeof host !== "string" || host.includes("@")) {
    throw new HttpRequestError(400, "Invalid Host header");
  }
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new HttpRequestError(400, "Invalid Host header");
  }
  if (hostUrl.hostname !== new URL(config.resourceUrl).hostname) {
    throw new HttpRequestError(421, "Misdirected request");
  }

  const rawUrl = request.url ?? "/";
  const isAbsoluteForm = /^https?:\/\//i.test(rawUrl);
  const isNetworkPath = rawUrl.startsWith("//")
    || rawUrl.startsWith("\\\\")
    || rawUrl.startsWith("/\\");
  let parsed: URL;
  try {
    parsed = isAbsoluteForm
      ? new URL(rawUrl)
      : new URL(rawUrl, `http://${host}`);
  } catch {
    throw new HttpRequestError(400, "Malformed request URL");
  }
  if (parsed.username || parsed.password) {
    throw new HttpRequestError(400, "URL credentials are not accepted");
  }
  if (
    isNetworkPath
    || (
      isAbsoluteForm
      && parsed.origin !== new URL(config.resourceUrl).origin
    )
  ) {
    throw new HttpRequestError(421, "Misdirected request");
  }
  return parsed;
}
function validateOrigin(
  request: IncomingMessage,
  config: HostedArcHttpConfig,
): string | undefined {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return undefined;
  }
  if (typeof origin !== "string" || origin !== config.allowedOrigin) {
    throw new HttpRequestError(403, "Origin is not allowed");
  }
  return origin;
}

function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): void {
  if (!origin) {
    throw new HttpRequestError(400, "CORS Origin is required");
  }
  const requestedMethod =
    request.headers["access-control-request-method"];
  if (
    typeof requestedMethod !== "string"
    || !["GET", "POST"].includes(requestedMethod)
  ) {
    throw new HttpRequestError(405, "CORS method is not allowed");
  }
  response.statusCode = 204;
  response.end();
}

function rejectClientSessionId(request: IncomingMessage): void {
  if (request.headers["mcp-session-id"] !== undefined) {
    throw new HttpRequestError(
      400,
      "This stateless MCP endpoint does not accept session IDs",
    );
  }
}

function requireMethod(
  request: IncomingMessage,
  expectedMethod: "GET" | "POST",
): void {
  if (request.method !== expectedMethod) {
    throw new HttpRequestError(405, "Method not allowed", {
      Allow: expectedMethod,
    });
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string"
    || contentType.split(";", 1)[0].trim().toLowerCase()
      !== "application/json"
  ) {
    throw new HttpRequestError(415, "application/json is required");
  }
}

async function readApiBody(request: IncomingMessage): Promise<unknown> {
  requireJsonContentType(request);
  return readJsonBody(request);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string"
    && (
      !/^\d+$/.test(declaredLength)
      || Number(declaredLength) > MAX_BODY_BYTES
    )
  ) {
    throw new HttpRequestError(413, "Request body is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer =
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpRequestError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new HttpRequestError(400, "JSON body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Malformed JSON body");
  }
}

function assertExactRuntime(runtime: HostedArcWalletRuntime): void {
  if (
    runtime.toolNames.length !== HOSTED_ARC_TOOL_NAMES.length
    || runtime.toolNames.some(
      (name, index) => name !== HOSTED_ARC_TOOL_NAMES[index],
    )
  ) {
    throw new Error("Hosted runtime tool surface mismatch");
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  response.setHeader("Cache-Control", "no-store");
}

function applyCorsHeaders(
  response: ServerResponse,
  origin: string,
): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, MCP-Protocol-Version",
  );
  response.setHeader("Access-Control-Max-Age", "600");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify(body));
}

function toStructuredContent(
  output: unknown,
): Record<string, unknown> {
  if (typeof output === "object" && output !== null) {
    return output as Record<string, unknown>;
  }
  return { value: output };
}

async function boundedReadiness(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe().catch(() => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForListening(server: Server): Promise<void> {
  await Promise.race([
    once(server, "listening").then(() => undefined),
    once(server, "error").then(([error]) => {
      throw error;
    }),
  ]);
}

function unauthorized(config: HostedArcHttpConfig): HttpRequestError {
  return new HttpRequestError(401, "Bearer authentication required", {
    "WWW-Authenticate":
      `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"`,
  });
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

interface RateLimiter {
  assertAllowed(clientKey: string): void;
}

function createRateLimiter(
  maxRequests: number,
  clock: () => Date,
): RateLimiter {
  const clients = new Map<
    string,
    { readonly count: number; readonly resetAt: number }
  >();
  return {
    assertAllowed(clientKey) {
      const now = clock().getTime();
      const current = clients.get(clientKey);
      if (!current || current.resetAt <= now) {
        if (!current && clients.size >= MAX_RATE_LIMIT_CLIENTS) {
          for (const [key, value] of clients) {
            if (value.resetAt <= now) {
              clients.delete(key);
            }
          }
        }
        if (!current && clients.size >= MAX_RATE_LIMIT_CLIENTS) {
          throw new HttpRequestError(
            503,
            "Request admission is unavailable",
          );
        }
        clients.set(clientKey, {
          count: 1,
          resetAt: now + RATE_LIMIT_WINDOW_MS,
        });
        return;
      }
      if (current.count >= maxRequests) {
        throw new HttpRequestError(
          429,
          "Too many requests",
          { "Retry-After": "60" },
        );
      }
      clients.set(clientKey, {
        ...current,
        count: current.count + 1,
      });
    },
  };
}

class HttpRequestError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
