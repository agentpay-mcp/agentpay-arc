import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  AgentPayAuthError,
  sessionScopeSchema,
  type SessionEnvironment,
  type SessionScope,
} from "@agentpay-ai/shared-arc";

import { DEFAULT_SESSION_SCOPES } from "./siwe.ts";
import type { ServiceSessionRecord } from "./session.ts";

export const AGENTPAY_OAUTH_ISSUER = "https://wallet.agentpay.site/celo";
export const AGENTPAY_OAUTH_RESOURCE = "https://wallet.agentpay.site/celo/mcp";
export const AGENTPAY_OAUTH_ROUTE_PREFIX = "/celo/oauth";
export const AGENTPAY_OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/celo/mcp";
export const AGENTPAY_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server/celo";
export const OAUTH_AUTHORIZATION_TTL_SECONDS = 5 * 60;
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const maxInMemoryOAuthAdmissionKeys = 4_096;

export type OAuthAdmissionBucket = "registration" | "authorization" | "siwe" | "token";

export interface OAuthAdmissionStore {
  consume(input: {
    bucket: OAuthAdmissionBucket;
    keyDigest: string;
    now: Date;
    windowSeconds: number;
    limit: number;
  }): Promise<boolean>;
  pruneExpired(now: Date): Promise<void>;
}

export interface OAuthClientRecord {
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface OAuthAuthorizationRecord {
  readonly authorizationId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly stateDigest: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly SessionScope[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly siweChallengeId?: string;
  readonly tenantId?: string;
  readonly ownerAddress?: string;
  readonly accountAddress?: string;
  readonly homeChainId?: number;
  readonly environment?: SessionEnvironment;
  readonly authenticationEpoch?: number;
  readonly codeDigest?: string;
  readonly codeIssuedAt?: string;
  readonly codeExpiresAt?: string;
  readonly consumedAt?: string;
}

export interface OAuthClientStore {
  create(record: OAuthClientRecord): Promise<void>;
  get(clientId: string): Promise<OAuthClientRecord | null>;
  touch(clientId: string, usedAt: string): Promise<void>;
}

export interface OAuthAuthorizationStore {
  create(record: OAuthAuthorizationRecord): Promise<void>;
  get(authorizationId: string): Promise<OAuthAuthorizationRecord | null>;
  bindSiweChallenge(input: { authorizationId: string; challengeId: string; at: string }): Promise<boolean>;
  issueAuthorizationCode(input: {
    authorizationId: string;
    challengeId: string;
    tenantId: string;
    ownerAddress: string;
    accountAddress: string;
    homeChainId: number;
    environment: SessionEnvironment;
    authenticationEpoch: number;
    codeDigest: string;
    codeIssuedAt: string;
    codeExpiresAt: string;
  }): Promise<boolean>;
  findByCodeDigest(codeDigest: string): Promise<OAuthAuthorizationRecord | null>;
  consumeAuthorizationCode(input: {
    authorizationId: string;
    codeDigest: string;
    consumedAt: string;
  }): Promise<OAuthAuthorizationRecord | null>;
  /**
   * Atomically records one-time code consumption and persists the resulting
   * bearer-session record. Implementations must roll both changes back when
   * either write fails.
   */
  exchangeAuthorizationCode(input: {
    authorizationId: string;
    codeDigest: string;
    consumedAt: string;
    session: ServiceSessionRecord;
  }): Promise<OAuthAuthorizationRecord | null>;
}

export function createOAuthSecret(bytes: Uint8Array = randomBytes(32)): string {
  if (bytes.byteLength !== 32) {
    throw new AgentPayAuthError("OAUTH_SECRET_INVALID", "OAuth secret generator must return 32 bytes.");
  }
  return Buffer.from(bytes).toString("base64url");
}

export function createInMemoryOAuthAdmissionStore(): OAuthAdmissionStore {
  const entries = new Map<string, { count: number; resetAtMs: number }>();

  return {
    async consume(input): Promise<boolean> {
      const nowMs = input.now.getTime();
      if (
        !Number.isFinite(nowMs) ||
        !/^[0-9a-f]{64}$/.test(input.keyDigest) ||
        !Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86_400 ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
      ) {
        return false;
      }
      pruneInMemoryAdmissionEntries(entries, nowMs);
      const key = `${input.bucket}:${input.keyDigest}`;
      const existing = entries.get(key);
      if (!existing && entries.size >= maxInMemoryOAuthAdmissionKeys) return false;
      if (!existing || nowMs >= existing.resetAtMs) {
        entries.set(key, { count: 1, resetAtMs: nowMs + input.windowSeconds * 1_000 });
        return true;
      }
      if (existing.count >= input.limit) return false;
      entries.set(key, { count: existing.count + 1, resetAtMs: existing.resetAtMs });
      return true;
    },
    async pruneExpired(now): Promise<void> {
      pruneInMemoryAdmissionEntries(entries, now.getTime());
    },
  };
}

export function digestOAuthSecret(value: string, serverSecret: string | Uint8Array): string {
  const key = typeof serverSecret === "string" ? Buffer.from(serverSecret, "utf8") : Buffer.from(serverSecret);
  if (key.byteLength < 16) {
    throw new AgentPayAuthError("AUTH_SECRET_INVALID", "Session hash secret is too short.");
  }
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function normalizeOAuthScopes(value: string | null | undefined): readonly SessionScope[] {
  if (value === null || value === undefined || value.trim() === "") {
    return Object.freeze(["wallet:read"]);
  }
  const scopes = [...new Set(value.trim().split(/\s+/))].sort();
  if (scopes.length === 0 || scopes.length > DEFAULT_SESSION_SCOPES.length) {
    throw new AgentPayAuthError("OAUTH_SCOPE_INVALID", "OAuth scope is invalid.");
  }
  for (const scope of scopes) {
    sessionScopeSchema.parse(scope);
    if (!DEFAULT_SESSION_SCOPES.includes(scope as SessionScope)) {
      throw new AgentPayAuthError("OAUTH_SCOPE_INVALID", "OAuth scope is unsupported.");
    }
  }
  return Object.freeze(scopes as SessionScope[]);
}

export function isValidOAuthRedirectUri(value: string): boolean {
  if (value.length < 1 || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

export function isValidAuthorizationCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function isValidS256CodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function createS256CodeChallenge(verifier: string): string {
  if (!isValidAuthorizationCodeVerifier(verifier)) {
    throw new AgentPayAuthError("OAUTH_PKCE_INVALID", "OAuth PKCE verifier is invalid.");
  }
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyS256CodeChallenge(verifier: string, challenge: string): boolean {
  if (!isValidAuthorizationCodeVerifier(verifier) || !isValidS256CodeChallenge(challenge)) return false;
  return constantTimeEqual(createS256CodeChallenge(verifier), challenge);
}

export function createBrowserTransactionCookie(
  input: { authorizationId: string; state?: string },
  serverSecret: string | Uint8Array,
): string {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  return `${payload}.${digestOAuthSecret(payload, serverSecret)}`;
}

export function readBrowserTransactionCookie(
  cookie: string | null | undefined,
  serverSecret: string | Uint8Array,
): { authorizationId: string; state?: string } | null {
  if (!cookie || cookie.length > 2_048) return null;
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = cookie.slice(0, separator);
  const digest = cookie.slice(separator + 1);
  if (!/^[0-9a-f]{64}$/.test(digest) || !constantTimeEqual(digestOAuthSecret(payload, serverSecret), digest)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const authorizationId = typeof decoded.authorizationId === "string" ? decoded.authorizationId : "";
    const state = decoded.state;
    if (
      !isBoundedIdentifier(authorizationId) ||
      (state !== undefined && (typeof state !== "string" || state.length < 1 || state.length > 512 || /[\r\n]/.test(state)))
    ) return null;
    return state === undefined ? { authorizationId } : { authorizationId, state };
  } catch {
    return null;
  }
}

export function isBoundedIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function pruneInMemoryAdmissionEntries(entries: Map<string, { count: number; resetAtMs: number }>, nowMs: number): void {
  for (const [key, entry] of entries) {
    if (nowMs >= entry.resetAtMs) entries.delete(key);
  }
}
