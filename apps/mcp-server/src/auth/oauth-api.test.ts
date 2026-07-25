import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { describe, it } from "node:test";
import { startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";

import type { SessionEnvironment, SessionScope } from "@agentpay-ai/shared-arc";

import {
  type OAuthAuthorizationRecord,
  type OAuthAuthorizationStore,
  type OAuthClientRecord,
  type OAuthClientStore,
} from "./oauth.ts";
import {
  createConsumerOAuthApi,
  type ConsumerOAuthApiDependencies,
} from "./oauth-api.ts";
import { createSiweChallenge, type SiweChallenge } from "./siwe.ts";
import type {
  AuthChallengeStore,
  ServiceSessionRecord,
  ServiceSessionStore,
} from "./session.ts";
import { authenticateServiceSession } from "./session.ts";

const owner = new Wallet(`0x${"2".repeat(64)}`);
const accountAddress = "0x2222222222222222222222222222222222222222";
const redirectUri = "http://127.0.0.1:4567/callback";
const resource = "https://wallet.agentpay.site/arc/mcp";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc";
const codeChallenge = "dYSqskoTcWrpu8GYY0XpWlzOc0c5rd9YO3uAgh_zmV4";

class ClientStore implements OAuthClientStore {
  public readonly records = new Map<string, OAuthClientRecord>();

  async create(record: OAuthClientRecord): Promise<void> {
    this.records.set(record.clientId, record);
  }

  async get(clientId: string): Promise<OAuthClientRecord | null> {
    return this.records.get(clientId) ?? null;
  }

  async touch(clientId: string, usedAt: string): Promise<void> {
    const record = this.records.get(clientId);
    if (!record) throw new Error("OAuth client unavailable");
    this.records.set(clientId, { ...record, lastUsedAt: usedAt });
  }
}

class AuthorizationStore implements OAuthAuthorizationStore {
  public readonly records = new Map<string, OAuthAuthorizationRecord>();

  public constructor(private readonly sessionStore: SessionStore) {}

  async create(record: OAuthAuthorizationRecord): Promise<void> {
    this.records.set(record.authorizationId, record);
  }

  async get(authorizationId: string): Promise<OAuthAuthorizationRecord | null> {
    return this.records.get(authorizationId) ?? null;
  }

  async bindSiweChallenge(input: { authorizationId: string; challengeId: string; at: string }): Promise<boolean> {
    const record = this.records.get(input.authorizationId);
    if (!record || record.siweChallengeId || Date.parse(record.expiresAt) <= Date.parse(input.at)) return false;
    this.records.set(input.authorizationId, { ...record, siweChallengeId: input.challengeId });
    return true;
  }

  async issueAuthorizationCode(input: {
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
  }): Promise<boolean> {
    const record = this.records.get(input.authorizationId);
    if (
      !record ||
      record.siweChallengeId !== input.challengeId ||
      record.codeDigest ||
      Date.parse(record.expiresAt) <= Date.parse(input.codeIssuedAt)
    ) {
      return false;
    }
    this.records.set(input.authorizationId, {
      ...record,
      tenantId: input.tenantId,
      ownerAddress: input.ownerAddress.toLowerCase(),
      accountAddress: input.accountAddress.toLowerCase(),
      homeChainId: input.homeChainId,
      environment: input.environment,
      authenticationEpoch: input.authenticationEpoch,
      codeDigest: input.codeDigest,
      codeIssuedAt: input.codeIssuedAt,
      codeExpiresAt: input.codeExpiresAt,
    });
    return true;
  }

  async findByCodeDigest(codeDigest: string): Promise<OAuthAuthorizationRecord | null> {
    return [...this.records.values()].find((record) => record.codeDigest === codeDigest) ?? null;
  }

  async consumeAuthorizationCode(input: {
    authorizationId: string;
    codeDigest: string;
    consumedAt: string;
  }): Promise<OAuthAuthorizationRecord | null> {
    const record = this.records.get(input.authorizationId);
    if (
      !record ||
      record.codeDigest !== input.codeDigest ||
      record.consumedAt ||
      !record.codeExpiresAt ||
      Date.parse(record.codeExpiresAt) <= Date.parse(input.consumedAt)
    ) {
      return null;
    }
    const consumed = { ...record, consumedAt: input.consumedAt };
    this.records.set(input.authorizationId, consumed);
    return consumed;
  }

  async exchangeAuthorizationCode(input: {
    authorizationId: string;
    codeDigest: string;
    consumedAt: string;
    session: ServiceSessionRecord;
  }): Promise<OAuthAuthorizationRecord | null> {
    const record = this.records.get(input.authorizationId);
    if (
      !record ||
      record.codeDigest !== input.codeDigest ||
      record.consumedAt ||
      !record.codeExpiresAt ||
      Date.parse(record.codeExpiresAt) <= Date.parse(input.consumedAt)
    ) {
      return null;
    }
    await this.sessionStore.create(input.session);
    const consumed = { ...record, consumedAt: input.consumedAt };
    this.records.set(input.authorizationId, consumed);
    return consumed;
  }
}

class ChallengeStore implements AuthChallengeStore {
  public readonly records = new Map<string, SiweChallenge>();

  async create(record: SiweChallenge): Promise<void> {
    this.records.set(record.challengeId, record);
  }

  async get(challengeId: string): Promise<SiweChallenge | null> {
    return this.records.get(challengeId) ?? null;
  }

  async consume(challengeId: string, consumedAt: string): Promise<boolean> {
    const record = this.records.get(challengeId);
    if (!record || record.consumedAt) return false;
    this.records.set(challengeId, { ...record, consumedAt });
    return true;
  }
}

class SessionStore implements ServiceSessionStore {
  public readonly records = new Map<string, ServiceSessionRecord>();
  public failNextCreate = false;

  async create(record: ServiceSessionRecord): Promise<void> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated session persistence failure");
    }
    this.records.set(record.sessionId, record);
  }

  async findByCredentialDigest(digest: string): Promise<ServiceSessionRecord | null> {
    return [...this.records.values()].find((record) => record.credentialDigest === digest) ?? null;
  }

  async revoke(): Promise<void> {}
  async revokeAll(): Promise<void> {}
  async touch(): Promise<void> {}
}

type OAuthTestDependencies = ConsumerOAuthApiDependencies & {
  sessionStore: SessionStore;
};

function dependencies(overrides: Partial<OAuthTestDependencies> = {}): OAuthTestDependencies {
  const sessionStore = overrides.sessionStore ?? new SessionStore();
  const authorizationStore = overrides.authorizationStore ?? new AuthorizationStore(sessionStore as SessionStore);
  return {
    clientStore: new ClientStore(),
    authorizationStore,
    challengeStore: new ChallengeStore(),
    sessionStore,
    serverSecret: "oauth-consumer-session-secret",
    audience: resource,
    environment: "staging",
    clock: () => new Date("2026-07-12T00:00:00.000Z"),
    resolveOwner: async (ownerAddress, chainId) => ({
      tenantId: "tenant_a",
      ownerAddress,
      accountAddress,
      homeChainId: chainId,
      authenticationEpoch: 0,
      environment: "staging",
    }),
    currentAuthenticationEpoch: async () => 0,
    createClientId: () => "client_123",
    createAuthorizationId: () => "authorization_123",
    createChallengeId: () => "challenge_123",
    createNonce: () => "nonce_1234567890",
    createSessionId: () => "session_123",
    createAuthorizationCodeBytes: () => Buffer.alloc(32, 7),
    createSessionCredentialBytes: () => Buffer.alloc(32, 8),
    createCspNonce: () => "csp_nonce_1234567890",
    ...overrides,
  };
}

function formRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`https://wallet.agentpay.site${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("consumer OAuth authorization API", () => {
  it("keeps Arc OAuth discovery and authorization routes namespaced away from the existing root service", async () => {
    const api = createConsumerOAuthApi(dependencies());

    const rootMetadata = await api.handle(
      new Request("https://wallet.agentpay.site/.well-known/oauth-protected-resource/mcp"),
    );
    const rootRegistration = await api.handle(
      new Request("https://wallet.agentpay.site/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    const protectedResource = await api.handle(
      new Request("https://wallet.agentpay.site/.well-known/oauth-protected-resource/arc/mcp"),
    );
    const authorizationServer = await api.handle(
      new Request("https://wallet.agentpay.site/.well-known/oauth-authorization-server/arc"),
    );
    const registered = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );

    assert.equal(rootMetadata.status, 404);
    assert.equal(rootRegistration.status, 404);
    assert.equal(protectedResource.status, 200);
    assert.deepEqual(await protectedResource.json(), {
      resource,
      authorization_servers: ["https://wallet.agentpay.site/arc"],
      scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
      bearer_methods_supported: ["header"],
    });
    assert.equal(authorizationServer.status, 200);
    assert.deepEqual(await authorizationServer.json(), {
      issuer: "https://wallet.agentpay.site/arc",
      authorization_endpoint: "https://wallet.agentpay.site/arc/oauth/authorize",
      token_endpoint: "https://wallet.agentpay.site/arc/oauth/token",
      registration_endpoint: "https://wallet.agentpay.site/arc/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
    });
    assert.equal(registered.status, 201);
  });

  it("dynamically registers a public client and rejects a non-loopback HTTP callback", async () => {
    const api = createConsumerOAuthApi(dependencies());

    const rejected = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example/callback"] }),
      }),
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "invalid_client_metadata" });

    const registered = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "AgentPay test client",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );

    assert.equal(registered.status, 201);
    assert.deepEqual(await registered.json(), {
      client_id: "client_123",
      client_id_issued_at: 1783814400,
      client_name: "AgentPay test client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(registered.headers.get("cache-control"), "no-store");
  });

  it("fails closed when the durable OAuth admission quota refuses a registration", async () => {
    const admissionCalls: Array<{ keyDigest: string; bucket: string }> = [];
    const deps = dependencies({
      admissionStore: {
        async pruneExpired(): Promise<void> {},
        async consume(input): Promise<boolean> {
          admissionCalls.push({ keyDigest: input.keyDigest, bucket: input.bucket });
          return false;
        },
      },
    });
    const api = createConsumerOAuthApi(deps);
    const response = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentpay-oauth-client": "203.0.113.10",
        },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "3600");
    assert.deepEqual(await response.json(), { error: "temporarily_unavailable" });
    assert.deepEqual(admissionCalls.map((call) => call.bucket), ["registration"]);
    assert.match(admissionCalls[0]!.keyDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(admissionCalls[0]!.keyDigest, "203.0.113.10");
    assert.equal((deps.clientStore as ClientStore).records.size, 0);
  });

  it("grants only wallet read when a client omits an OAuth scope", async () => {
    const deps = dependencies();
    const api = createConsumerOAuthApi(deps);
    await (deps.clientStore as ClientStore).create({
      clientId: "client_123",
      redirectUris: [redirectUri],
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    const response = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent(redirectUri)}&state=state&code_challenge=${codeChallenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
      ),
    );
    assert.equal(response.status, 200);
    const authorization = await (deps.authorizationStore as AuthorizationStore).get("authorization_123");
    assert.deepEqual(authorization?.scopes, ["wallet:read"]);
  });

  it("binds an owner SIWE proof to an S256 PKCE authorization code and prevents replay", async () => {
    const deps = dependencies();
    const api = createConsumerOAuthApi(deps);
    const clients = deps.clientStore as ClientStore;
    await clients.create({
      clientId: "client_123",
      clientName: "AgentPay test client",
      redirectUris: [redirectUri],
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    const authorize = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent(redirectUri)}&state=client-state-123&code_challenge=${codeChallenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&scope=wallet%3Aread%20payment%3Aprepare`,
      ),
    );
    assert.equal(authorize.status, 200);
    const authorizePage = await authorize.text();
    assert.match(authorizePage, /Authorize AgentPay test client/);
    assert.match(authorizePage, /required Arc Testnet/);
    assert.match(authorizePage, /fetch\("\/arc\/oauth\/siwe\/challenge"/);
    assert.match(authorizePage, /fetch\("\/arc\/oauth\/siwe\/verify"/);
    const cookie = authorize.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /^agentpay_arc_oauth_transaction=.*; Path=\/arc\/oauth; HttpOnly; Secure; SameSite=Lax;/);

    const authorization = await (deps.authorizationStore as AuthorizationStore).get("authorization_123");
    assert.ok(authorization);
    assert.equal("state" in authorization, false);
    assert.ok(authorization.stateDigest);
    assert.deepEqual(authorization.scopes, ["payment:prepare", "wallet:read"]);

    const challengeResponse = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ authorizationId: "authorization_123", ownerAddress: owner.address, chainId: 5042002 }),
      }),
    );
    assert.equal(challengeResponse.status, 200);
    const challengeBody = (await challengeResponse.json()) as { challengeId: string; message: string; expiresAt: string };
    assert.equal(challengeBody.challengeId, "challenge_123");
    const challenge = await (deps.challengeStore as ChallengeStore).get(challengeBody.challengeId);
    assert.ok(challenge);

    const verified = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          authorizationId: "authorization_123",
          challengeId: challengeBody.challengeId,
          signature: await owner.signMessage(challenge.message),
        }),
      }),
    );
    assert.equal(verified.status, 200);
    assert.match(
      verified.headers.get("set-cookie") ?? "",
      /^agentpay_arc_oauth_transaction=; Path=\/arc\/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/,
    );
    const verifiedBody = (await verified.json()) as { redirectUri: string };
    const callback = new URL(verifiedBody.redirectUri);
    assert.equal(callback.origin + callback.pathname, "http://127.0.0.1:4567/callback");
    assert.equal(callback.searchParams.get("state"), "client-state-123");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const issued = await (deps.authorizationStore as AuthorizationStore).get("authorization_123");
    assert.ok(issued?.codeDigest);
    assert.equal(JSON.stringify(issued).includes(code), false);
    assert.equal((deps.sessionStore as SessionStore).records.size, 0);

    const invalidVerifier = await api.handle(
      formRequest("/arc/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: "client_123",
        redirect_uri: redirectUri,
        code_verifier: "wrong-verifier",
        resource,
      }),
    );
    assert.equal(invalidVerifier.status, 400);
    assert.deepEqual(await invalidVerifier.json(), { error: "invalid_grant" });

    const token = await api.handle(
      formRequest("/arc/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: "client_123",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    );
    assert.equal(token.status, 200);
    const tokenBody = (await token.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
    assert.equal(tokenBody.access_token.length, 43);
    assert.equal(tokenBody.token_type, "Bearer");
    assert.equal(tokenBody.expires_in, 3600);
    assert.equal(tokenBody.scope, "payment:prepare wallet:read");
    assert.equal((deps.sessionStore as SessionStore).records.size, 1);
    assert.equal(JSON.stringify((deps.sessionStore as SessionStore).records).includes(tokenBody.access_token), false);
    const context = await authenticateServiceSession({
      credential: tokenBody.access_token,
      sessionStore: deps.sessionStore,
      serverSecret: deps.serverSecret,
      audience: resource,
      environment: "staging",
      clock: deps.clock,
      currentAuthenticationEpoch: deps.currentAuthenticationEpoch,
    });
    assert.equal(context.tenantId, "tenant_a");
    assert.deepEqual(context.scopes, ["payment:prepare", "wallet:read"]);

    const replay = await api.handle(
      formRequest("/arc/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: "client_123",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    );
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });
    assert.equal((deps.sessionStore as SessionStore).records.size, 1);
  });

  it("accepts a standard MCP SDK authorization request that omits state", async () => {
    const deps = dependencies();
    const api = createConsumerOAuthApi(deps);
    await (deps.clientStore as ClientStore).create({
      clientId: "client_123",
      redirectUris: [redirectUri],
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    const { authorizationUrl } = await startAuthorization("https://wallet.agentpay.site/arc", {
      metadata: {
        authorization_endpoint: "https://wallet.agentpay.site/arc/oauth/authorize",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      } as never,
      clientInformation: { client_id: "client_123", redirect_uris: [redirectUri] },
      redirectUrl: redirectUri,
      scope: "wallet:read",
      resource: new URL(resource),
    });
    assert.equal(authorizationUrl.searchParams.has("state"), false);

    const authorize = await api.handle(new Request(authorizationUrl));
    assert.equal(authorize.status, 200);
    assert.match(authorize.headers.get("content-security-policy") ?? "", /script-src 'nonce-csp_nonce_1234567890'/);
    const cookie = authorize.headers.get("set-cookie");
    assert.ok(cookie);

    const challengeResponse = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ authorizationId: "authorization_123", ownerAddress: owner.address, chainId: 5042002 }),
      }),
    );
    const challengeBody = (await challengeResponse.json()) as { challengeId: string; message: string };
    const verified = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          authorizationId: "authorization_123",
          challengeId: challengeBody.challengeId,
          signature: await owner.signMessage(challengeBody.message),
        }),
      }),
    );
    assert.equal(verified.status, 200);
    const callback = new URL(((await verified.json()) as { redirectUri: string }).redirectUri);
    assert.equal(callback.searchParams.has("state"), false);
    assert.ok(callback.searchParams.get("code"));
  });

  it("keeps an authorization code usable when durable session persistence fails", async () => {
    const deps = dependencies();
    const api = createConsumerOAuthApi(deps);
    const clients = deps.clientStore as ClientStore;
    const sessions = deps.sessionStore as SessionStore;
    await clients.create({
      clientId: "client_123",
      redirectUris: [redirectUri],
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    const authorize = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent(redirectUri)}&state=client-state-123&code_challenge=${codeChallenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&scope=wallet%3Aread`,
      ),
    );
    const cookie = authorize.headers.get("set-cookie");
    assert.ok(cookie);
    const challengeResponse = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ authorizationId: "authorization_123", ownerAddress: owner.address, chainId: 5042002 }),
      }),
    );
    const challenge = (await challengeResponse.json()) as { challengeId: string; message: string };
    const verified = await api.handle(
      new Request("https://wallet.agentpay.site/arc/oauth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          authorizationId: "authorization_123",
          challengeId: challenge.challengeId,
          signature: await owner.signMessage(challenge.message),
        }),
      }),
    );
    const callback = new URL(((await verified.json()) as { redirectUri: string }).redirectUri);
    const code = callback.searchParams.get("code");
    assert.ok(code);

    sessions.failNextCreate = true;
    const unavailable = await api.handle(
      formRequest("/arc/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: "client_123",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "temporarily_unavailable" });

    const retry = await api.handle(
      formRequest("/arc/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: "client_123",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    );
    assert.equal(retry.status, 200);
    assert.equal(sessions.records.size, 1);
  });

  it("does not create an authorization transaction for a cross-client redirect or non-S256 request", async () => {
    const deps = dependencies();
    const api = createConsumerOAuthApi(deps);
    await (deps.clientStore as ClientStore).create({
      clientId: "client_123",
      redirectUris: [redirectUri],
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    const redirectMismatch = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent("https://evil.example/callback")}&state=state&code_challenge=${codeChallenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
      ),
    );
    assert.equal(redirectMismatch.status, 400);
    assert.deepEqual(await redirectMismatch.json(), { error: "invalid_request" });

    const plainPkce = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent(redirectUri)}&state=state&code_challenge=${codeChallenge}&code_challenge_method=plain&resource=${encodeURIComponent(resource)}`,
      ),
    );
    assert.equal(plainPkce.status, 400);
    assert.deepEqual(await plainPkce.json(), { error: "invalid_request" });

    const oversizedS256 = await api.handle(
      new Request(
        `https://wallet.agentpay.site/arc/oauth/authorize?response_type=code&client_id=client_123&redirect_uri=${encodeURIComponent(redirectUri)}&state=state&code_challenge=${"a".repeat(44)}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
      ),
    );
    assert.equal(oversizedS256.status, 400);
    assert.deepEqual(await oversizedS256.json(), { error: "invalid_request" });
    assert.equal((deps.authorizationStore as AuthorizationStore).records.size, 0);
  });
});
