import { randomBytes } from "node:crypto";

import {
  AgentPayAuthError,
  type SessionEnvironment,
  type SessionScope,
} from "@agentpay-ai/shared-arc";
import { getAddress, isAddress } from "ethers";

import {
  AGENTPAY_OAUTH_ISSUER,
  AGENTPAY_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  AGENTPAY_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  AGENTPAY_OAUTH_RESOURCE,
  AGENTPAY_OAUTH_ROUTE_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_AUTHORIZATION_TTL_SECONDS,
  createBrowserTransactionCookie,
  createInMemoryOAuthAdmissionStore,
  createOAuthSecret,
  digestOAuthSecret,
  isBoundedIdentifier,
  isValidAuthorizationCodeVerifier,
  isValidOAuthRedirectUri,
  isValidS256CodeChallenge,
  normalizeOAuthScopes,
  readBrowserTransactionCookie,
  verifyS256CodeChallenge,
  type OAuthAuthorizationRecord,
  type OAuthAuthorizationStore,
  type OAuthAdmissionBucket,
  type OAuthAdmissionStore,
  type OAuthClientRecord,
  type OAuthClientStore,
} from "./oauth.ts";
import {
  AGENTPAY_CONSUMER_URI,
  AGENTPAY_SIWE_DOMAIN,
  DEFAULT_SESSION_SCOPES,
  OAUTH_SERVICE_SESSION_TTL_SECONDS,
  SIWE_CHALLENGE_TTL_SECONDS,
  createSiweChallenge,
  verifySiweChallengeSignature,
  type SiweChallenge,
} from "./siwe.ts";
import {
  prepareServiceSessionFromVerifiedBinding,
  type AuthChallengeStore,
} from "./session.ts";

const browserTransactionCookieName = "agentpay_celo_oauth_transaction";
const maxBodyBytes = 16_384;
const oauthAdmissionPruneIntervalMs = 5 * 60_000;

export interface OAuthOwnerBinding {
  readonly tenantId: string;
  readonly ownerAddress: string;
  readonly accountAddress: string;
  readonly homeChainId: number;
  readonly authenticationEpoch: number;
  readonly environment: SessionEnvironment;
}

export interface ConsumerOAuthApiDependencies {
  clientStore: OAuthClientStore;
  authorizationStore: OAuthAuthorizationStore;
  challengeStore: AuthChallengeStore;
  admissionStore?: OAuthAdmissionStore;
  serverSecret: string | Uint8Array;
  audience: typeof AGENTPAY_CONSUMER_URI;
  environment: SessionEnvironment;
  clock: () => Date;
  resolveOwner(ownerAddress: string, chainId: number, environment: SessionEnvironment): Promise<OAuthOwnerBinding>;
  currentAuthenticationEpoch(tenantId: string): Promise<number>;
  createClientId?: () => string;
  createAuthorizationId?: () => string;
  createChallengeId?: () => string;
  createNonce?: () => string;
  createSessionId?: () => string;
  createAuthorizationCodeBytes?: () => Uint8Array;
  createSessionCredentialBytes?: () => Uint8Array;
  createCspNonce?: () => string;
  verifySignature?: (challenge: SiweChallenge, signature: string, now: Date) => Promise<string>;
}

export interface ConsumerOAuthApi {
  /** Applies quota before an HTTP adapter buffers an OAuth request body. */
  preflight?(request: Request): Promise<Response | undefined>;
  handle(request: Request, options?: { admitted?: boolean }): Promise<Response>;
}

export function createConsumerOAuthApi(dependencies: ConsumerOAuthApiDependencies): ConsumerOAuthApi {
  const admissionStore = dependencies.admissionStore ?? createInMemoryOAuthAdmissionStore();
  let nextAdmissionPruneAtMs = 0;

  const preflight = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      (request.method === "GET" && url.pathname === AGENTPAY_OAUTH_PROTECTED_RESOURCE_METADATA_PATH) ||
      (request.method === "GET" && url.pathname === AGENTPAY_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH)
    ) {
      return undefined;
    }
    const admission = oauthAdmissionPolicy(url.pathname);
    if (!admission) return undefined;
    const now = dependencies.clock();
    try {
      if (now.getTime() >= nextAdmissionPruneAtMs) {
        await admissionStore.pruneExpired(now);
        nextAdmissionPruneAtMs = now.getTime() + oauthAdmissionPruneIntervalMs;
      }
      const accepted = await admissionStore.consume({
        bucket: admission.bucket,
        keyDigest: digestOAuthSecret(readAdmissionSource(request.headers.get("x-agentpay-oauth-client")), dependencies.serverSecret),
        now,
        windowSeconds: admission.windowSeconds,
        limit: admission.limit,
      });
      if (!accepted) {
        return jsonResponse({ error: "temporarily_unavailable" }, 429, {
          "retry-after": String(admission.windowSeconds),
        });
      }
      return undefined;
    } catch {
      return oauthError("temporarily_unavailable");
    }
  };

  return {
    preflight,
    async handle(request: Request, options: { admitted?: boolean } = {}): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === AGENTPAY_OAUTH_PROTECTED_RESOURCE_METADATA_PATH) {
        return jsonResponse(protectedResourceMetadata(dependencies.audience));
      }
      if (request.method === "GET" && url.pathname === AGENTPAY_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH) {
        return jsonResponse(authorizationServerMetadata());
      }
      if (!options.admitted) {
        const rejected = await preflight(request);
        if (rejected) return rejected;
      }
      if (request.method === "POST" && url.pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/register`) {
        return handleRegister(request, dependencies);
      }
      if (request.method === "GET" && url.pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/authorize`) {
        return handleAuthorize(url, dependencies);
      }
      if (request.method === "POST" && url.pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/challenge`) {
        return handleSiweChallenge(request, dependencies);
      }
      if (request.method === "POST" && url.pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/verify`) {
        return handleSiweVerify(request, dependencies);
      }
      if (request.method === "POST" && url.pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/token`) {
        return handleToken(request, dependencies);
      }
      return jsonResponse({ error: "not_found" }, 404);
    },
  };
}

export function protectedResourceMetadata(audience = AGENTPAY_OAUTH_RESOURCE): Record<string, unknown> {
  return {
    resource: audience,
    authorization_servers: [AGENTPAY_OAUTH_ISSUER],
    scopes_supported: DEFAULT_SESSION_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: AGENTPAY_OAUTH_ISSUER,
    authorization_endpoint: `${AGENTPAY_OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${AGENTPAY_OAUTH_ISSUER}/oauth/token`,
    registration_endpoint: `${AGENTPAY_OAUTH_ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: DEFAULT_SESSION_SCOPES,
  };
}

async function handleRegister(request: Request, dependencies: ConsumerOAuthApiDependencies): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body)) return oauthError("invalid_client_metadata");
    const redirectUris = readRedirectUris(body.redirect_uris);
    const clientName = readOptionalClientName(body.client_name);
    assertOptionalExactArray(body.grant_types, "authorization_code");
    assertOptionalExactArray(body.response_types, "code");
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return oauthError("invalid_client_metadata");
    }

    const clientId = dependencies.createClientId?.() ?? `client_${randomBytes(18).toString("base64url")}`;
    if (!isBoundedIdentifier(clientId)) return oauthError("invalid_client_metadata");
    const createdAt = dependencies.clock().toISOString();
    const record: OAuthClientRecord = Object.freeze({
      clientId,
      ...(clientName ? { clientName } : {}),
      redirectUris: Object.freeze([...redirectUris]),
      createdAt,
      lastUsedAt: createdAt,
    });
    await dependencies.clientStore.create(record);
    return jsonResponse({
      client_id: record.clientId,
      client_id_issued_at: Math.floor(new Date(record.createdAt).getTime() / 1000),
      ...(record.clientName ? { client_name: record.clientName } : {}),
      redirect_uris: record.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  } catch {
    return oauthError("invalid_client_metadata");
  }
}

async function handleAuthorize(url: URL, dependencies: ConsumerOAuthApiDependencies): Promise<Response> {
  try {
    const clientId = requiredIdentifier(url.searchParams.get("client_id"));
    const redirectUri = requiredRedirectUri(url.searchParams.get("redirect_uri"));
    const state = optionalState(url.searchParams.get("state"));
    const resource = requiredResource(url.searchParams.get("resource"), dependencies.audience);
    const codeChallenge = requiredCodeChallenge(url.searchParams.get("code_challenge"));
    if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256") {
      return oauthError("invalid_request");
    }
    const scopes = normalizeOAuthScopes(url.searchParams.get("scope"));
    const client = await dependencies.clientStore.get(clientId);
    if (!client || client.revokedAt || !client.redirectUris.includes(redirectUri)) {
      return oauthError("invalid_request");
    }

    const authorizationId = dependencies.createAuthorizationId?.() ?? `authorization_${randomBytes(18).toString("base64url")}`;
    if (!isBoundedIdentifier(authorizationId)) return oauthError("invalid_request");
    const issuedAt = dependencies.clock();
    try {
      await dependencies.clientStore.touch(clientId, issuedAt.toISOString());
    } catch {
      return oauthError("temporarily_unavailable");
    }
    const record: OAuthAuthorizationRecord = Object.freeze({
      authorizationId,
      clientId,
      redirectUri,
      stateDigest: digestOAuthSecret(state ?? "", dependencies.serverSecret),
      codeChallenge,
      resource,
      scopes,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + OAUTH_AUTHORIZATION_TTL_SECONDS * 1000).toISOString(),
    });
    await dependencies.authorizationStore.create(record);
    const cookie = createBrowserTransactionCookie(
      state === undefined ? { authorizationId } : { authorizationId, state },
      dependencies.serverSecret,
    );
    const cspNonce = dependencies.createCspNonce?.() ?? randomBytes(18).toString("base64url");
    return htmlResponse(
      renderConsentPage({
        authorizationId,
        clientName: client.clientName ?? client.clientId,
        redirectHost: new URL(redirectUri).host,
        scopes,
        expectedChainId: dependencies.environment === "production" ? 42220 : 11142220,
        cspNonce,
      }),
      {
        "content-security-policy": consentContentSecurityPolicy(cspNonce),
        "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        "set-cookie": `${browserTransactionCookieName}=${cookie}; Path=${AGENTPAY_OAUTH_ROUTE_PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_AUTHORIZATION_TTL_SECONDS}`,
      },
    );
  } catch {
    return oauthError("invalid_request");
  }
}

async function handleSiweChallenge(request: Request, dependencies: ConsumerOAuthApiDependencies): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body)) return oauthError("invalid_request");
    const authorizationId = requiredIdentifier(readString(body.authorizationId));
    const ownerAddress = requiredAddress(readString(body.ownerAddress));
    const chainId = requiredChainId(body.chainId);
    const authorization = await requireBrowserAuthorization(request, authorizationId, dependencies);
    if (authorization.siweChallengeId || authorization.codeDigest || Date.parse(authorization.expiresAt) <= dependencies.clock().getTime()) {
      return oauthError("invalid_request");
    }

    const binding = await dependencies.resolveOwner(ownerAddress, chainId, dependencies.environment);
    if (
      binding.environment !== dependencies.environment ||
      binding.homeChainId !== chainId ||
      binding.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase() ||
      !isAddress(binding.accountAddress)
    ) {
      return oauthError("access_denied");
    }

    const now = dependencies.clock();
    const challenge = createSiweChallenge({
      challengeId: dependencies.createChallengeId?.() ?? `challenge_${randomBytes(18).toString("base64url")}`,
      requestId: authorizationId,
      domain: AGENTPAY_SIWE_DOMAIN,
      uri: dependencies.audience,
      ownerAddress,
      accountAddress: binding.accountAddress,
      chainId,
      nonce: dependencies.createNonce?.() ?? randomBytes(16).toString("hex"),
      flow: "oauth_authorization",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SIWE_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      scopes: authorization.scopes,
      sessionLifetimeSeconds: OAUTH_SERVICE_SESSION_TTL_SECONDS,
    });
    await dependencies.challengeStore.create(challenge);
    if (!await dependencies.authorizationStore.bindSiweChallenge({
      authorizationId,
      challengeId: challenge.challengeId,
      at: now.toISOString(),
    })) {
      return oauthError("invalid_request");
    }
    return jsonResponse({
      challengeId: challenge.challengeId,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      scopes: challenge.scopes,
    });
  } catch {
    return oauthError("invalid_request");
  }
}

async function handleSiweVerify(request: Request, dependencies: ConsumerOAuthApiDependencies): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body)) return oauthError("invalid_request");
    const authorizationId = requiredIdentifier(readString(body.authorizationId));
    const challengeId = requiredIdentifier(readString(body.challengeId));
    const signature = readString(body.signature);
    if (signature.length < 2 || signature.length > 300) return oauthError("invalid_request");
    const authorization = await requireBrowserAuthorization(request, authorizationId, dependencies);
    if (
      authorization.siweChallengeId !== challengeId ||
      authorization.codeDigest ||
      Date.parse(authorization.expiresAt) <= dependencies.clock().getTime()
    ) {
      return oauthError("invalid_request");
    }
    const challenge = await dependencies.challengeStore.get(challengeId);
    if (
      !challenge ||
      challenge.requestId !== authorizationId ||
      challenge.uri !== dependencies.audience ||
      challenge.flow !== "oauth_authorization" ||
      !sameScopes(challenge.scopes, authorization.scopes)
    ) {
      return oauthError("invalid_request");
    }

    const now = dependencies.clock();
    const verifySignature = dependencies.verifySignature ?? verifySiweChallengeSignature;
    const recoveredOwner = await verifySignature(challenge, signature, now);
    if (recoveredOwner.toLowerCase() !== challenge.ownerAddress.toLowerCase()) return oauthError("access_denied");
    const binding = await dependencies.resolveOwner(recoveredOwner, challenge.chainId, dependencies.environment);
    if (
      binding.environment !== dependencies.environment ||
      binding.homeChainId !== challenge.chainId ||
      binding.ownerAddress.toLowerCase() !== recoveredOwner.toLowerCase() ||
      binding.accountAddress.toLowerCase() !== challenge.accountAddress.toLowerCase()
    ) {
      return oauthError("access_denied");
    }
    if (!await dependencies.challengeStore.consume(challengeId, now.toISOString())) {
      return oauthError("invalid_request");
    }

    const code = createOAuthSecret(dependencies.createAuthorizationCodeBytes?.() ?? randomBytes(32));
    const codeExpiresAt = new Date(now.getTime() + OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString();
    if (!await dependencies.authorizationStore.issueAuthorizationCode({
      authorizationId,
      challengeId,
      tenantId: binding.tenantId,
      ownerAddress: recoveredOwner,
      accountAddress: binding.accountAddress,
      homeChainId: binding.homeChainId,
      environment: binding.environment,
      authenticationEpoch: binding.authenticationEpoch,
      codeDigest: digestOAuthSecret(code, dependencies.serverSecret),
      codeIssuedAt: now.toISOString(),
      codeExpiresAt,
    })) {
      return oauthError("invalid_request");
    }
    const browserTransaction = readBrowserTransaction(request, dependencies.serverSecret);
    if (!browserTransaction) return oauthError("invalid_request");
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.append("code", code);
    if (browserTransaction.state !== undefined) {
      redirect.searchParams.append("state", browserTransaction.state);
    }
    return jsonResponse(
      { redirectUri: redirect.toString() },
      200,
      { "set-cookie": `${browserTransactionCookieName}=; Path=${AGENTPAY_OAUTH_ROUTE_PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=0` },
    );
  } catch {
    return oauthError("invalid_request");
  }
}

async function handleToken(request: Request, dependencies: ConsumerOAuthApiDependencies): Promise<Response> {
  try {
    const form = await readFormBody(request);
    const code = form.get("code") ?? "";
    const clientId = form.get("client_id") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const resource = form.get("resource") ?? "";
    if (
      form.get("grant_type") !== "authorization_code" ||
      !/^[A-Za-z0-9_-]{43}$/.test(code) ||
      !isBoundedIdentifier(clientId) ||
      !isValidOAuthRedirectUri(redirectUri) ||
      !isValidAuthorizationCodeVerifier(verifier) ||
      resource !== dependencies.audience
    ) {
      return oauthError("invalid_grant");
    }
    const codeDigest = digestOAuthSecret(code, dependencies.serverSecret);
    const authorization = await dependencies.authorizationStore.findByCodeDigest(codeDigest);
    if (
      !authorization ||
      authorization.clientId !== clientId ||
      authorization.redirectUri !== redirectUri ||
      authorization.resource !== resource ||
      !authorization.codeExpiresAt ||
      authorization.consumedAt ||
      Date.parse(authorization.codeExpiresAt) <= dependencies.clock().getTime() ||
      !verifyS256CodeChallenge(verifier, authorization.codeChallenge)
    ) {
      return oauthError("invalid_grant");
    }
    const client = await dependencies.clientStore.get(clientId);
    if (!client || client.revokedAt || !client.redirectUris.includes(redirectUri)) return oauthError("invalid_grant");
    if (
      !authorization.tenantId ||
      !authorization.ownerAddress ||
      !authorization.accountAddress ||
      !authorization.homeChainId ||
      !authorization.environment ||
      authorization.authenticationEpoch === undefined
    ) {
      return oauthError("invalid_grant");
    }
    if ((await dependencies.currentAuthenticationEpoch(authorization.tenantId)) !== authorization.authenticationEpoch) {
      return oauthError("invalid_grant");
    }
    const now = dependencies.clock();
    const {
      tenantId,
      ownerAddress,
      accountAddress,
      homeChainId,
      authenticationEpoch,
      environment,
    } = authorization;
    if (
      !tenantId ||
      !ownerAddress ||
      !accountAddress ||
      !homeChainId ||
      authenticationEpoch === undefined ||
      !environment
    ) {
      return oauthError("invalid_grant");
    }

    const issued = prepareServiceSessionFromVerifiedBinding({
      binding: {
        tenantId,
        ownerAddress,
        accountAddress,
        homeChainId,
        authenticationEpoch,
        environment,
      },
      scopes: authorization.scopes,
      serverSecret: dependencies.serverSecret,
      audience: dependencies.audience,
      environment: dependencies.environment,
      clock: dependencies.clock,
      sessionLifetimeSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      createSessionId: dependencies.createSessionId,
      randomCredentialBytes: dependencies.createSessionCredentialBytes,
    });
    try {
      const consumed = await dependencies.authorizationStore.exchangeAuthorizationCode({
        authorizationId: authorization.authorizationId,
        codeDigest,
        consumedAt: now.toISOString(),
        session: issued.record,
      });
      if (!consumed) return oauthError("invalid_grant");
    } catch {
      return oauthError("temporarily_unavailable");
    }
    return jsonResponse({
      access_token: issued.credential,
      token_type: "Bearer",
      expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      scope: issued.context.scopes.join(" "),
    });
  } catch {
    return oauthError("invalid_grant");
  }
}

async function requireBrowserAuthorization(
  request: Request,
  authorizationId: string,
  dependencies: ConsumerOAuthApiDependencies,
): Promise<OAuthAuthorizationRecord> {
  const authorization = await dependencies.authorizationStore.get(authorizationId);
  const transaction = readBrowserTransaction(request, dependencies.serverSecret);
  if (
    !authorization ||
    !transaction ||
    transaction.authorizationId !== authorizationId ||
    digestOAuthSecret(transaction.state ?? "", dependencies.serverSecret) !== authorization.stateDigest
  ) {
    throw new AgentPayAuthError("OAUTH_TRANSACTION_INVALID", "OAuth browser transaction is invalid.");
  }
  return authorization;
}

function readBrowserTransaction(request: Request, serverSecret: string | Uint8Array): { authorizationId: string; state?: string } | null {
  return readBrowserTransactionCookie(readCookie(request.headers.get("cookie"), browserTransactionCookieName), serverSecret);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header || header.length > 4_096) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function requiredIdentifier(value: string | null): string {
  if (!value || !isBoundedIdentifier(value)) throw new AgentPayAuthError("OAUTH_REQUEST_INVALID", "OAuth identifier is invalid.");
  return value;
}

function optionalState(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!value || value.length > 512 || /[\r\n]/.test(value)) {
    throw new AgentPayAuthError("OAUTH_STATE_INVALID", "OAuth state is invalid.");
  }
  return value;
}

function requiredRedirectUri(value: string | null): string {
  if (!value || !isValidOAuthRedirectUri(value)) {
    throw new AgentPayAuthError("OAUTH_REDIRECT_INVALID", "OAuth redirect URI is invalid.");
  }
  return value;
}

function requiredResource(value: string | null, audience: string): string {
  if (value !== audience) throw new AgentPayAuthError("OAUTH_RESOURCE_INVALID", "OAuth resource is invalid.");
  return value;
}

function requiredCodeChallenge(value: string | null): string {
  if (!value || !isValidS256CodeChallenge(value)) {
    throw new AgentPayAuthError("OAUTH_PKCE_INVALID", "OAuth PKCE code challenge is invalid.");
  }
  return value;
}

function requiredAddress(value: string): string {
  if (!isAddress(value)) throw new AgentPayAuthError("SIWE_ADDRESS_INVALID", "Owner address is invalid.");
  return getAddress(value);
}

function requiredChainId(value: unknown): 42220 | 11142220 {
  if (value === 42220 || value === 11142220) return value;
  throw new AgentPayAuthError("SIWE_CHAIN_INVALID", "Celo mainnet or Celo Sepolia is required.");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRedirectUris(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((uri) => typeof uri !== "string" || !isValidOAuthRedirectUri(uri))) {
    throw new AgentPayAuthError("OAUTH_REDIRECT_INVALID", "OAuth redirect URI is invalid.");
  }
  return Object.freeze([...new Set(value)].sort());
}

function readOptionalClientName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AgentPayAuthError("OAUTH_CLIENT_INVALID", "OAuth client name is invalid.");
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new AgentPayAuthError("OAUTH_CLIENT_INVALID", "OAuth client name is invalid.");
  }
  return name;
}

function assertOptionalExactArray(value: unknown, expected: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) {
    throw new AgentPayAuthError("OAUTH_CLIENT_INVALID", "OAuth client metadata is invalid.");
  }
}

function sameScopes(left: readonly SessionScope[], right: readonly SessionScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AgentPayAuthError("OAUTH_REQUEST_INVALID", "OAuth JSON request content type is invalid.");
  }
  return JSON.parse(await readBodyText(request)) as unknown;
}

async function readFormBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new AgentPayAuthError("OAUTH_REQUEST_INVALID", "OAuth token request content type is invalid.");
  }
  return new URLSearchParams(await readBodyText(request));
}

async function readBodyText(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new AgentPayAuthError("REQUEST_BODY_TOO_LARGE", "OAuth request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new AgentPayAuthError("REQUEST_BODY_TOO_LARGE", "OAuth request body is too large.");
  }
  return text;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function htmlResponse(html: string, headers: Record<string, string>): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

function oauthError(error: "invalid_client_metadata" | "invalid_request" | "invalid_grant" | "access_denied" | "temporarily_unavailable"): Response {
  return jsonResponse({ error }, error === "temporarily_unavailable" ? 503 : 400);
}

function oauthAdmissionPolicy(pathname: string): { bucket: OAuthAdmissionBucket; windowSeconds: number; limit: number } | null {
  if (pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/register`) {
    return { bucket: "registration", windowSeconds: 60 * 60, limit: 20 };
  }
  if (pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/authorize`) {
    return { bucket: "authorization", windowSeconds: 60, limit: 20 };
  }
  if (
    pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/challenge` ||
    pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/verify`
  ) {
    return { bucket: "siwe", windowSeconds: 60, limit: 20 };
  }
  if (pathname === `${AGENTPAY_OAUTH_ROUTE_PREFIX}/token`) {
    return { bucket: "token", windowSeconds: 60, limit: 30 };
  }
  return null;
}

function readAdmissionSource(value: string | null): string {
  const source = value?.trim();
  if (!source || source.length > 256 || /[\r\n]/.test(source)) return "global";
  return source;
}

function renderConsentPage(input: {
  authorizationId: string;
  clientName: string;
  redirectHost: string;
  scopes: readonly SessionScope[];
  expectedChainId: number;
  cspNonce: string;
}): string {
  const safeConfig = JSON.stringify({ authorizationId: input.authorizationId, expectedChainId: input.expectedChainId }).replace(/</g, "\\u003c");
  const csp = consentContentSecurityPolicy(input.cspNonce);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
    <title>Authorize AgentPay</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f8fafc; }
      main { width: min(34rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #475569; border-radius: 1rem; background: #172033; }
      h1 { margin-top: 0; font-size: 1.55rem; } p, li { line-height: 1.5; color: #cbd5e1; }
      code { overflow-wrap: anywhere; } button { width: 100%; margin-top: 1rem; padding: .8rem 1rem; border: 0; border-radius: .6rem; font: inherit; font-weight: 700; color: #0f172a; background: #67e8f9; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .65; } #status { min-height: 1.5rem; color: #fca5a5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize ${escapeHtml(input.clientName)}</h1>
      <p><strong>${escapeHtml(input.clientName)}</strong> requests access to your AgentPay MCP account and will return to <code>${escapeHtml(input.redirectHost)}</code>.</p>
      <p>Requested access:</p>
      <ul>${input.scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>
      <p>Signing proves wallet ownership for this MCP session. It does not approve a payment, transfer, or contract call.</p>
      <button id="authorize" type="button">Connect wallet and authorize</button>
      <p id="status" role="status"></p>
    </main>
    <script nonce="${escapeHtml(input.cspNonce)}">
      const config = ${safeConfig};
      const button = document.getElementById("authorize");
      const status = document.getElementById("status");
      const setStatus = (message) => { status.textContent = message; };
      button.addEventListener("click", async () => {
        try {
          if (!window.ethereum || typeof window.ethereum.request !== "function") throw new Error("An EIP-1193 wallet is required.");
          button.disabled = true;
          setStatus("Connecting wallet…");
          const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
          const ownerAddress = Array.isArray(accounts) ? accounts[0] : undefined;
          if (!ownerAddress) throw new Error("No wallet account was selected.");
          const chain = await window.ethereum.request({ method: "eth_chainId" });
          const chainId = Number.parseInt(chain, 16);
          if (chainId !== config.expectedChainId) throw new Error("Switch your wallet to the required Celo network and try again.");
          setStatus("Preparing ownership proof…");
          const challengeResponse = await fetch("${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/challenge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ authorizationId: config.authorizationId, ownerAddress, chainId }),
          });
          if (!challengeResponse.ok) throw new Error("Unable to prepare the ownership proof.");
          const challenge = await challengeResponse.json();
          setStatus("Waiting for wallet signature…");
          const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, ownerAddress] });
          const verifyResponse = await fetch("${AGENTPAY_OAUTH_ROUTE_PREFIX}/siwe/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ authorizationId: config.authorizationId, challengeId: challenge.challengeId, signature }),
          });
          if (!verifyResponse.ok) throw new Error("Wallet ownership proof was not accepted.");
          const completed = await verifyResponse.json();
          window.location.assign(completed.redirectUri);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Authorization failed.");
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

function consentContentSecurityPolicy(cspNonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
