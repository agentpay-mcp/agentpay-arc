import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ARC_AUTONOMY_CONSENT_VERSION,
  type ArcHostedAccount,
  type ArcHostedAuthority,
  type ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";

import type { SupabaseUserVerifier } from "../auth/supabase-user.ts";
import type { HostedArcWalletRuntime } from "../runtime/hosted-arc-wallet-runtime.ts";
import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.ts";
import type { HostedArcWalletFacade } from "../runtime/hosted-arc-wallet-runtime.ts";
import type { ArcPaymentRepository } from "../tools/arc-payments.ts";
import { ALL_ARC_MCP_TOOL_NAMES } from "../services/circle-hosted-wallet-facade.ts";
import {
  ARC_HOSTED_MCP_PATH,
  createHostedArcMutationCoordinator,
  createSupabaseHostedArcBearerVerifier,
  parseHostedArcHttpConfig,
  startHostedArcHttpServer,
  type HostedArcBearerVerifier,
  type HostedArcHttpServer,
  type HostedArcMutationCoordinator,
  type HostedArcVerifiedBearer,
  type StartHostedArcHttpServerOptions,
} from "./hosted-arc-http.ts";

const AUTH_USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUTH_USER_ID =
  "99999999-9999-4999-8999-999999999999";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID =
  "88888888-8888-4888-8888-888888888888";
const WALLET_ADDRESS =
  "0x1111111111111111111111111111111111111111";
const OTHER_WALLET_ADDRESS =
  "0x2222222222222222222222222222222222222222";
const RECIPIENT_ADDRESS =
  "0x3333333333333333333333333333333333333333";
const IDEMPOTENCY_KEY =
  "44444444-4444-4444-8444-444444444444";
const SECOND_IDEMPOTENCY_KEY =
  "55555555-5555-4555-8555-555555555555";
const MCP_TOKEN = "verified-mcp-token";
const BROWSER_TOKEN = "verified-browser-token";

const baseAuthority: ArcHostedAuthority = {
  authUserId: AUTH_USER_ID,
  tenantId: TENANT_ID,
  walletAddress: WALLET_ADDRESS,
  accountStatus: "ACTIVE",
  authEpoch: 7,
  oauthClientId: "codex-client",
};

const baseAccount: ArcHostedAccount = {
  authUserId: AUTH_USER_ID,
  tenantId: TENANT_ID,
  accountStatus: "ACTIVE",
  consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
  consentTimestamp: "2026-07-30T00:00:00.000Z",
  walletAddress: WALLET_ADDRESS,
  walletStatus: "LIVE",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function hostedEnv(): Record<string, string> {
  return {
    ARC_MCP_RESOURCE_URL: "https://127.0.0.1/mcp",
    ARC_SUPABASE_URL: "https://arc-project.supabase.co",
    ARC_SUPABASE_AUTH_ISSUER:
      "https://arc-project.supabase.co/auth/v1",
    ARC_MCP_ALLOWED_ORIGINS: "https://arc.agentpay.site",
    ARC_MCP_HOST: "127.0.0.1",
    ARC_MCP_PORT: "0",
  };
}

interface HttpTestContext {
  readonly calls: {
    readonly verifier: Array<{
      token: string;
      requireOAuthClientId: boolean;
    }>;
    readonly authority: Array<{
      authUserId: string;
      oauthClientId?: string;
    }>;
    readonly runtime: ArcHostedAuthority[];
    readonly dispatch: Array<{ name: string; input: unknown }>;
    readonly mutations: Array<{
      authority: ArcHostedAuthority;
      input: unknown;
    }>;
    readonly claims: unknown[];
    readonly statuses: unknown[];
    readonly provisions: string[];
  };
  readonly options: StartHostedArcHttpServerOptions;
  setAccount(account: ArcHostedAccount | null): void;
  setAuthority(authority: ArcHostedAuthority | null): void;
  setVerifierResult(
    token: string,
    result: HostedArcVerifiedBearer | Error,
  ): void;
}

function createHttpTestContext(): HttpTestContext {
  let account: ArcHostedAccount | null = { ...baseAccount };
  let authority: ArcHostedAuthority | null = { ...baseAuthority };
  const verifierResults = new Map<
    string,
    HostedArcVerifiedBearer | Error
  >([
    [
      MCP_TOKEN,
      {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      },
    ],
    [
      BROWSER_TOKEN,
      {
        authUserId: AUTH_USER_ID,
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      },
    ],
  ]);
  const calls: HttpTestContext["calls"] = {
    verifier: [],
    authority: [],
    runtime: [],
    dispatch: [],
    mutations: [],
    claims: [],
    statuses: [],
    provisions: [],
  };
  const repository: ArcHostedAccountRepository = {
    async claimHostedAccount(input) {
      calls.claims.push({ ...input });
      account = {
        ...baseAccount,
        authUserId: input.authUserId,
        walletAddress: undefined,
        walletStatus: "PENDING",
      };
      return { ...account };
    },
    async getHostedAccount() {
      return account ? { ...account } : null;
    },
    async resolveHostedAuthority(input) {
      calls.authority.push({ ...input });
      return authority ? { ...authority } : null;
    },
    async claimProvisioningJob() {
      return null;
    },
    async completeProvisioning() {},
    async failProvisioning() {},
    async setAccountStatus(input) {
      calls.statuses.push({ ...input });
      if (account) {
        account = {
          ...account,
          accountStatus: input.status,
        };
      }
      if (authority) {
        authority =
          input.status === "ACTIVE"
            ? {
                ...authority,
                accountStatus: "ACTIVE",
                authEpoch: authority.authEpoch + 1,
              }
            : null;
      }
    },
    async getPrivateWalletBinding() {
      return null;
    },
  };
  const verifier: HostedArcBearerVerifier = {
    async verifyAccessToken(token, options) {
      calls.verifier.push({
        token,
        requireOAuthClientId: options.requireOAuthClientId,
      });
      const result = verifierResults.get(token);
      if (!result || result instanceof Error) {
        throw result ?? new Error("invalid token");
      }
      return { ...result };
    },
  };
  const createRuntime = (
    runtimeAuthority: ArcHostedAuthority,
  ): HostedArcWalletRuntime => {
    calls.runtime.push({ ...runtimeAuthority });
    return {
      toolNames: Object.freeze([
        "setup_agent_wallet",
        "get_agent_budget",
        "send_usdc",
        "get_payment_receipt",
        "get_unified_balance",
      ]),
      async dispatch(name: string, input: unknown) {
        calls.dispatch.push({ name, input });
        if (name === "setup_agent_wallet") {
          return {
            walletAddress: runtimeAuthority.walletAddress,
            chain: "ARC-TESTNET",
            accountType: "SCA",
            custodyType: "DEVELOPER",
            status: "LIVE",
          };
        }
        if (name === "get_agent_budget") {
          return {
            walletAddress: runtimeAuthority.walletAddress,
            chain: "ARC-TESTNET",
            balances: [],
          };
        }
        if (name === "get_payment_receipt") {
          return {
            transactionId: "circle-tx-1",
            state: "COMPLETE",
          };
        }
        if (name === "get_unified_balance") {
          return {
            token: "USDC",
            confirmed: "10",
            pending: null,
            pendingAvailable: true,
            breakdown: [],
          };
        }
        throw new Error("send_usdc must use mutation coordinator");
      },
    };
  };
  const mutationCoordinator: HostedArcMutationCoordinator = {
    async sendUsdc(mutationAuthority, input) {
      calls.mutations.push({
        authority: { ...mutationAuthority },
        input: { ...input },
      });
      return {
        status: "SUBMITTED",
        transactionId: "circle-tx-1",
        reconciliationRequired: false,
      };
    },
  };

  return {
    calls,
    options: {
      env: hostedEnv(),
      verifier,
      repository,
      async provisionWallet(authUserId) {
        calls.provisions.push(authUserId);
        return {
          walletAddress: WALLET_ADDRESS,
          status: "LIVE",
        };
      },
      createRuntime,
      mutationCoordinator,
      async readinessProbe() {
        return true;
      },
    },
    setAccount(nextAccount) {
      account = nextAccount ? { ...nextAccount } : null;
    },
    setAuthority(nextAuthority) {
      authority = nextAuthority ? { ...nextAuthority } : null;
    },
    setVerifierResult(token, result) {
      verifierResults.set(token, result);
    },
  };
}

function authHeaders(
  token: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function postJson(
  server: HostedArcHttpServer,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function startTestServer(
  context: HttpTestContext = createHttpTestContext(),
  overrides: Partial<StartHostedArcHttpServerOptions> = {},
): Promise<{
  readonly context: HttpTestContext;
  readonly server: HostedArcHttpServer;
}> {
  const server = await startHostedArcHttpServer({
    ...context.options,
    ...overrides,
  });
  return { context, server };
}

function mockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${header}.${body}.signature`;
}

async function absoluteFormRequest(
  server: HostedArcHttpServer,
  path: string,
  hostHeader?: string,
): Promise<number> {
  const serverUrl = new URL(server.url);
  return new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(
      {
        hostname: serverUrl.hostname,
        port: Number(serverUrl.port),
        method: "GET",
        path,
        headers: {
          host: hostHeader ?? serverUrl.host,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolveStatus(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

interface PaymentRepositoryFake {
  readonly repository: ArcPaymentRepository;
  readonly calls: {
    readonly claims: ArcPaymentReceiptRecord[];
    readonly transitions: ArcPaymentReceiptRecord[];
    readonly audit: string[];
  };
  readonly receipts: Map<string, ArcPaymentReceiptRecord>;
}

function createPaymentRepositoryFake(options: {
  readonly beforeTransition?: (
    receipt: ArcPaymentReceiptRecord,
  ) => Promise<void>;
} = {}): PaymentRepositoryFake {
  const receipts = new Map<string, ArcPaymentReceiptRecord>();
  const calls: PaymentRepositoryFake["calls"] = {
    claims: [],
    transitions: [],
    audit: [],
  };
  const repository: ArcPaymentRepository = {
    async getReceiptByIdempotencyKey(idempotencyKey) {
      const receipt = receipts.get(idempotencyKey);
      return receipt ? { ...receipt } : null;
    },
    async claimReceipt(receipt) {
      calls.claims.push({ ...receipt });
      const existing = receipts.get(receipt.idempotencyKey);
      if (existing) {
        if (
          existing.walletAddress !== receipt.walletAddress
          || existing.recipient !== receipt.recipient
          || existing.amount !== receipt.amount
          || existing.purpose !== receipt.purpose
        ) {
          throw new Error(
            "Arc payment receipt replay conflicts with persisted input",
          );
        }
        return {
          claimed: false,
          receipt: { ...existing },
        };
      }
      receipts.set(receipt.idempotencyKey, { ...receipt });
      calls.audit.push("PAYMENT_CLAIMED");
      return {
        claimed: true,
        receipt: { ...receipt },
      };
    },
    async transitionReceipt(receipt, expectedStatus) {
      const existing = receipts.get(receipt.idempotencyKey);
      if (!existing || existing.status !== expectedStatus) {
        throw new Error("transition conflict");
      }
      await options.beforeTransition?.(receipt);
      receipts.set(receipt.idempotencyKey, { ...receipt });
      calls.transitions.push({ ...receipt });
      calls.audit.push("PAYMENT_TRANSITIONED");
      return { ...receipt };
    },
    async appendActivity() {},
    async getBatch() {
      return null;
    },
    async getBatchByIdempotencyKey() {
      return null;
    },
    async createBatch(batch) {
      return batch;
    },
    async claimBatchItem() {
      return null;
    },
    async saveBatchItem(item) {
      return item;
    },
    async saveBatch(batch) {
      return batch;
    },
  };
  return { repository, calls, receipts };
}

function createMutationFacade(options: {
  readonly balance?: string;
  readonly beforeBalancesReturn?: (
    call: number,
  ) => Promise<void>;
  readonly transfer?: (
    call: number,
  ) => Promise<{ transactionId: string; state: string }>;
} = {}): {
  readonly facade: HostedArcWalletFacade;
  readonly balanceCalls: () => number;
  readonly transferCalls: () => number;
} {
  let balanceCalls = 0;
  let transferCalls = 0;
  const facade: HostedArcWalletFacade = {
    async getWallet(authority) {
      return {
        walletAddress: authority.walletAddress,
        chain: "ARC-TESTNET",
        accountType: "SCA",
        custodyType: "DEVELOPER",
        status: "LIVE",
      };
    },
    async getBalances() {
      balanceCalls += 1;
      await options.beforeBalancesReturn?.(balanceCalls);
      return [
        {
          symbol: "USDC",
          amount: options.balance ?? "100",
          address:
            "0x3600000000000000000000000000000000000000",
        },
      ];
    },
    async transferTokens() {
      transferCalls += 1;
      return (
        options.transfer?.(transferCalls)
        ?? Promise.resolve({
          transactionId: `circle-tx-${transferCalls}`,
          state: "INITIATED",
        })
      );
    },
    async getTransactionStatus(_authority, transactionId) {
      return { transactionId, state: "INITIATED" };
    },
    async createAppKitAdapter() {
      throw new Error("not used");
    },
  };
  return {
    facade,
    balanceCalls: () => balanceCalls,
    transferCalls: () => transferCalls,
  };
}

async function hasConflictingUnresolvedMutation(
  payment: PaymentRepositoryFake,
  authority: ArcHostedAuthority,
  idempotencyKey: string,
): Promise<boolean> {
  return [...payment.receipts.values()].some(
    (receipt) =>
      receipt.walletAddress.toLowerCase()
        === authority.walletAddress.toLowerCase()
      && receipt.idempotencyKey !== idempotencyKey
      && (
        receipt.status === "SUBMITTING"
        || receipt.status === "RECONCILIATION_REQUIRED"
      ),
  );
}

async function resolveUnchangedAuthority(
  trustedAuthority: ArcHostedAuthority,
): Promise<ArcHostedAuthority> {
  return { ...trustedAuthority };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, 1));
  }
}

describe("hosted Arc HTTP configuration and OAuth metadata", () => {
  it("fails closed on an invalid resource, issuer, origin, host, or port", () => {
    assert.throws(
      () =>
        parseHostedArcHttpConfig({
          ...hostedEnv(),
          ARC_MCP_RESOURCE_URL: "http://arc.agentpay.site/mcp",
        }),
      /ARC_MCP_RESOURCE_URL/,
    );
    assert.throws(
      () =>
        parseHostedArcHttpConfig({
          ...hostedEnv(),
          ARC_SUPABASE_AUTH_ISSUER:
            "https://other-project.supabase.co/auth/v1",
        }),
      /ARC_SUPABASE_AUTH_ISSUER/,
    );
    assert.throws(
      () =>
        parseHostedArcHttpConfig({
          ...hostedEnv(),
          ARC_MCP_ALLOWED_ORIGINS:
            "https://arc.agentpay.site,https://evil.example",
        }),
      /ARC_MCP_ALLOWED_ORIGINS/,
    );
    assert.throws(
      () =>
        parseHostedArcHttpConfig({
          ...hostedEnv(),
          ARC_MCP_HOST: "bad host",
        }),
      /ARC_MCP_HOST/,
    );
    assert.throws(
      () =>
        parseHostedArcHttpConfig({
          ...hostedEnv(),
          ARC_MCP_PORT: "65536",
        }),
      /ARC_MCP_PORT/,
    );
  });

  it("serves exact RFC 9728 metadata and challenge without creating a runtime", async () => {
    let runtimeCreations = 0;
    const server = await startHostedArcHttpServer({
      env: hostedEnv(),
      verifier: {
        async verifyAccessToken() {
          return {
            authUserId: AUTH_USER_ID,
            issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
            audience: "authenticated",
            role: "authenticated",
            expiresAtEpochSeconds:
              Math.floor(Date.now() / 1_000) + 3_600,
          };
        },
      },
      repository: {
        async claimHostedAccount() {
          throw new Error("not used");
        },
        async getHostedAccount() {
          return null;
        },
        async resolveHostedAuthority() {
          return null;
        },
        async claimProvisioningJob() {
          return null;
        },
        async completeProvisioning() {},
        async failProvisioning() {},
        async setAccountStatus() {},
        async getPrivateWalletBinding() {
          return null;
        },
      },
      async provisionWallet() {
        throw new Error("not used");
      },
      createRuntime() {
        runtimeCreations += 1;
        throw new Error("not used");
      },
      mutationCoordinator: {
        async sendUsdc() {
          throw new Error("not used");
        },
      },
      async readinessProbe() {
        return true;
      },
    });

    try {
      const metadata = await fetch(
        new URL(
          "/.well-known/oauth-protected-resource/mcp",
          server.url,
        ),
      );
      assert.equal(metadata.status, 200);
      assert.deepEqual(await metadata.json(), {
        resource: "https://127.0.0.1/mcp",
        authorization_servers: [
          "https://arc-project.supabase.co/auth/v1",
        ],
        scopes_supported: ["openid", "email", "profile", "phone"],
      });

      const unauthenticated = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal(
        unauthenticated.headers.get("www-authenticate"),
        'Bearer resource_metadata="https://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
      );
      const unauthenticatedApi = await fetch(
        new URL("/api/account", server.url),
      );
      assert.equal(unauthenticatedApi.status, 401);
      assert.equal(
        unauthenticatedApi.headers.get("www-authenticate"),
        'Bearer resource_metadata="https://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
      );
      assert.equal(runtimeCreations, 0);
    } finally {
      await server.close();
    }
  });
});

describe("hosted Arc bearer and stateless authority boundary", () => {
  it("does not create a transport/runtime before verifier and authority succeed", async () => {
    const context = createHttpTestContext();
    context.setVerifierResult(MCP_TOKEN, new Error("bad signature"));
    const { server } = await startTestServer(context);

    try {
      const rejected = await fetch(server.mcpUrl, {
        method: "POST",
        headers: authHeaders(MCP_TOKEN),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      });
      assert.equal(rejected.status, 401);
      assert.equal(context.calls.verifier.length, 1);
      assert.equal(context.calls.authority.length, 0);
      assert.equal(context.calls.runtime.length, 0);

      context.setVerifierResult(MCP_TOKEN, {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      });
      context.setAuthority(null);
      const noAuthority = await fetch(server.mcpUrl, {
        method: "POST",
        headers: authHeaders(MCP_TOKEN),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {},
        }),
      });
      assert.equal(noAuthority.status, 403);
      assert.equal(context.calls.authority.length, 1);
      assert.equal(context.calls.runtime.length, 0);
    } finally {
      await server.close();
    }
  });

  it("requires top-level client identity for MCP but permits browser API tokens without it", async () => {
    const context = createHttpTestContext();
    context.setVerifierResult(MCP_TOKEN, {
      authUserId: AUTH_USER_ID,
      issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
      audience: "authenticated",
      role: "authenticated",
      expiresAtEpochSeconds:
        Math.floor(Date.now() / 1_000) + 3_600,
    });
    const { server } = await startTestServer(context);

    try {
      const mcp = await fetch(server.mcpUrl, {
        method: "POST",
        headers: authHeaders(MCP_TOKEN),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      });
      assert.equal(mcp.status, 401);
      assert.equal(context.calls.runtime.length, 0);

      const api = await fetch(
        new URL("/api/account", server.url),
        {
          headers: {
            authorization: `Bearer ${BROWSER_TOKEN}`,
          },
        },
      );
      assert.equal(api.status, 200);
      assert.equal(
        context.calls.verifier.at(-1)?.requireOAuthClientId,
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("rejects issuer, audience, role, expiry, user, client, tenant, and epoch drift", async () => {
    const invalidClaims: HostedArcVerifiedBearer[] = [
      {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: "https://wrong.example/auth/v1",
        audience: "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      },
      {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "wrong" as "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      },
      {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "authenticated",
        role: "anon" as "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) + 3_600,
      },
      {
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
        issuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        audience: "authenticated",
        role: "authenticated",
        expiresAtEpochSeconds:
          Math.floor(Date.now() / 1_000) - 1,
      },
    ];

    for (const invalid of invalidClaims) {
      const context = createHttpTestContext();
      context.setVerifierResult(MCP_TOKEN, invalid);
      const { server } = await startTestServer(context);
      try {
        const response = await fetch(server.mcpUrl, {
          method: "POST",
          headers: authHeaders(MCP_TOKEN),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        });
        assert.equal(response.status, 401);
        assert.equal(context.calls.runtime.length, 0);
      } finally {
        await server.close();
      }
    }

    for (const driftedAuthority of [
      { ...baseAuthority, authUserId: OTHER_AUTH_USER_ID },
      { ...baseAuthority, oauthClientId: "other-client" },
      { ...baseAuthority, tenantId: OTHER_TENANT_ID },
      { ...baseAuthority, walletAddress: OTHER_WALLET_ADDRESS },
    ]) {
      const context = createHttpTestContext();
      context.setAuthority(driftedAuthority);
      const { server } = await startTestServer(context);
      try {
        const response = await fetch(server.mcpUrl, {
          method: "POST",
          headers: authHeaders(MCP_TOKEN),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        });
        assert.equal(response.status, 403);
        assert.equal(context.calls.runtime.length, 0);
      } finally {
        await server.close();
      }
    }
  });

  it("rejects every client-controlled session id in stateless mode before authentication", async () => {
    const { context, server } = await startTestServer();

    try {
      for (const { sessionId, token } of [
        { sessionId: "unknown-session", token: MCP_TOKEN },
        {
          sessionId: "session-a, session-b",
          token: BROWSER_TOKEN,
        },
        {
          sessionId: "x".repeat(1_024),
          token: `replayed-${OTHER_AUTH_USER_ID}`,
        },
      ]) {
        const response = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            ...authHeaders(token),
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        });
        assert.equal(response.status, 400);
      }
      assert.equal(context.calls.verifier.length, 0);
      assert.equal(context.calls.runtime.length, 0);
    } finally {
      await server.close();
    }
  });

  it("decodes and validates Supabase claims only after cryptographic verification", async () => {
    let verificationCompleted = false;
    const userVerifier: SupabaseUserVerifier = {
      async verifyAccessToken() {
        verificationCompleted = true;
        return {
          authUserId: AUTH_USER_ID,
          oauthClientId: "codex-client",
        };
      },
    };
    const verifier = createSupabaseHostedArcBearerVerifier(
      userVerifier,
      {
        authIssuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
      },
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    const token = mockJwt({
      sub: AUTH_USER_ID,
      client_id: "codex-client",
      iss: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(
        new Date("2026-07-30T01:00:00.000Z").getTime() / 1_000,
      ),
    });

    const verified = await verifier.verifyAccessToken(token, {
      requireOAuthClientId: true,
    });
    assert.equal(verificationCompleted, true);
    assert.equal(verified.authUserId, AUTH_USER_ID);
    assert.equal(verified.oauthClientId, "codex-client");

    verificationCompleted = false;
    const rejectingVerifier =
      createSupabaseHostedArcBearerVerifier(
        {
          async verifyAccessToken() {
            throw new Error("cryptographic verification failed");
          },
        },
        {
          authIssuer: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
        },
      );
    await assert.rejects(
      rejectingVerifier.verifyAccessToken("not-a-jwt", {
        requireOAuthClientId: true,
      }),
      /cryptographic verification failed/,
    );
    assert.equal(verificationCompleted, false);

    for (const claimOverride of [
      { sub: OTHER_AUTH_USER_ID },
      { client_id: undefined },
      { iss: "https://wrong.example/auth/v1" },
      { aud: "other" },
      { role: "anon" },
      { exp: 1 },
    ]) {
      await assert.rejects(
        verifier.verifyAccessToken(
          mockJwt({
            sub: AUTH_USER_ID,
            client_id: "codex-client",
            iss: hostedEnv().ARC_SUPABASE_AUTH_ISSUER,
            aud: "authenticated",
            role: "authenticated",
            exp: Math.floor(
              new Date("2026-07-30T01:00:00.000Z").getTime()
                / 1_000,
            ),
            ...claimOverride,
          }),
          { requireOAuthClientId: true },
        ),
      );
    }
  });
});

describe("hosted Arc Streamable MCP surface", () => {
  it("advertises and executes exactly all five hosted tools over the SDK wire transport", async () => {
    const { context, server } = await startTestServer();
    const client = new Client({
      name: "hosted-arc-wire-test",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.mcpUrl),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${MCP_TOKEN}`,
          },
        },
      },
    );

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map(({ name }) => name),
        [
          "setup_agent_wallet",
          "get_agent_budget",
          "send_usdc",
          "get_payment_receipt",
          "get_unified_balance",
        ],
      );

      const calls = [
        ["setup_agent_wallet", {}],
        ["get_agent_budget", {}],
        [
          "send_usdc",
          {
            recipient: RECIPIENT_ADDRESS,
            amount: "1.25",
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        ],
        [
          "get_payment_receipt",
          { transactionId: "circle-tx-1" },
        ],
        ["get_unified_balance", { includePending: true }],
      ] as const;
      for (const [name, args] of calls) {
        const result = await client.callTool({
          name,
          arguments: args,
        });
        assert.notEqual(result.isError, true, name);
      }
      const unsupported = await client.callTool({
        name: "batch_payout",
        arguments: {},
      });
      assert.equal(unsupported.isError, true);

      assert.equal(context.calls.mutations.length, 1);
      assert.deepEqual(context.calls.mutations[0].input, {
        destination: RECIPIENT_ADDRESS,
        amount: "1.25",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: "Hosted MCP send_usdc",
      });
      assert.ok(context.calls.verifier.length >= 7);
      assert.equal(
        context.calls.authority.length,
        context.calls.runtime.length,
      );
      assert.ok(
        context.calls.runtime.every(
          (authority) =>
            authority.authUserId === AUTH_USER_ID
            && authority.tenantId === TENANT_ID
            && authority.oauthClientId === "codex-client"
            && authority.authEpoch === 7,
        ),
      );
      assert.equal(transport.sessionId, undefined);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects caller-selected wallets and keeps the local 31-tool registry unchanged", async () => {
    const { context, server } = await startTestServer();
    const client = new Client({
      name: "hosted-arc-wallet-boundary",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.mcpUrl),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${MCP_TOKEN}`,
          },
        },
      },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "send_usdc",
        arguments: {
          walletAddress: OTHER_WALLET_ADDRESS,
          recipient: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      });
      assert.equal(result.isError, true);
      assert.equal(context.calls.mutations.length, 0);
      assert.equal(ALL_ARC_MCP_TOOL_NAMES.length, 31);
      assert.ok(ALL_ARC_MCP_TOOL_NAMES.includes("batch_payout"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("shares queued authority revalidation between MCP sends and API withdrawals", async () => {
    let releaseMcpTransfer = () => {};
    const mcpTransferGate = new Promise<void>((resolveGate) => {
      releaseMcpTransfer = resolveGate;
    });
    let releaseApiBalance = () => {};
    const apiBalanceGate = new Promise<void>((resolveGate) => {
      releaseApiBalance = resolveGate;
    });
    let authorityRevoked = false;
    const payment = createPaymentRepositoryFake();
    const wallet = createMutationFacade({
      async beforeBalancesReturn(call) {
        if (call === 2) {
          await apiBalanceGate;
        }
      },
      async transfer(call) {
        if (call === 1) {
          await mcpTransferGate;
        }
        return {
          transactionId: `circle-tx-${call}`,
          state: "INITIATED",
        };
      },
    });
    const mutationCoordinator =
      createHostedArcMutationCoordinator({
        facade: wallet.facade,
        resolveFreshAuthority: async (trustedAuthority) =>
          authorityRevoked ? null : { ...trustedAuthority },
        paymentsForTenant: () => payment.repository,
        hasConflictingUnresolvedMutation: (
          authority,
          idempotencyKey,
        ) =>
          hasConflictingUnresolvedMutation(
            payment,
            authority,
            idempotencyKey,
          ),
      });
    const context = createHttpTestContext();
    const { server } = await startTestServer(context, {
      mutationCoordinator,
    });
    const client = new Client({
      name: "hosted-arc-shared-mutation-queue",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.mcpUrl),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${MCP_TOKEN}`,
          },
        },
      },
    );

    try {
      await client.connect(transport);
      const mcpSend = client.callTool({
        name: "send_usdc",
        arguments: {
          recipient: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      });
      await waitFor(() => wallet.transferCalls() === 1);
      context.setAuthority({
        ...baseAuthority,
        oauthClientId: undefined,
      });
      const authorityCallsBeforeApi = context.calls.authority.length;
      const apiWithdrawal = postJson(
        server,
        "/api/account/withdraw",
        BROWSER_TOKEN,
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: SECOND_IDEMPOTENCY_KEY,
          confirmed: true,
        },
      );
      await waitFor(
        () =>
          context.calls.authority.length > authorityCallsBeforeApi,
      );
      await new Promise<void>((resolveImmediate) =>
        setImmediate(resolveImmediate));
      releaseMcpTransfer();
      await waitFor(
        () =>
          payment.calls.claims.length === 2
          && wallet.balanceCalls() === 2,
      );
      authorityRevoked = true;
      releaseApiBalance();

      const [mcpResult, apiResult] = await Promise.all([
        mcpSend,
        apiWithdrawal,
      ]);
      assert.notEqual(mcpResult.isError, true);
      assert.equal(apiResult.status, 500);
      assert.deepEqual(await apiResult.json(), {
        success: false,
        error: "Hosted Arc request failed",
      });
      assert.equal(wallet.transferCalls(), 1);
      assert.equal(payment.calls.claims.length, 2);
      assert.equal(
        payment.receipts.get(SECOND_IDEMPOTENCY_KEY)?.status,
        "FAILED",
      );
    } finally {
      releaseMcpTransfer();
      releaseApiBalance();
      await client.close();
      await server.close();
    }
  });
});

describe("hosted Arc authenticated JSON account API", () => {
  it("claims and reads only the bearer-derived account with exact consent", async () => {
    const { context, server } = await startTestServer();
    try {
      const wrongConsent = await postJson(
        server,
        "/api/account/claim",
        BROWSER_TOKEN,
        { consentVersion: "old-version" },
      );
      assert.equal(wrongConsent.status, 400);
      const injectedOwner = await postJson(
        server,
        "/api/account/claim",
        BROWSER_TOKEN,
        {
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          authUserId: OTHER_AUTH_USER_ID,
        },
      );
      assert.equal(injectedOwner.status, 400);
      assert.equal(context.calls.claims.length, 0);

      const claimed = await postJson(
        server,
        "/api/account/claim",
        BROWSER_TOKEN,
        { consentVersion: ARC_AUTONOMY_CONSENT_VERSION },
      );
      assert.equal(claimed.status, 200);
      const claimedBody = await claimed.json();
      assert.deepEqual(claimedBody, {
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          wallet: { status: "PENDING" },
        },
      });
      assert.deepEqual(context.calls.claims, [
        {
          authUserId: AUTH_USER_ID,
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        },
      ]);

      const read = await fetch(
        new URL("/api/account", server.url),
        {
          headers: {
            authorization: `Bearer ${BROWSER_TOKEN}`,
          },
        },
      );
      assert.equal(read.status, 200);
      const serialized = JSON.stringify(await read.json());
      assert.equal(serialized.includes(TENANT_ID), false);
      assert.equal(serialized.includes(AUTH_USER_ID), false);
      assert.equal(serialized.includes("circleWallet"), false);
    } finally {
      await server.close();
    }
  });

  it("provisions through the fenced adapter seam without accepting Circle identifiers", async () => {
    const { context, server } = await startTestServer();
    try {
      const rejected = await postJson(
        server,
        "/api/wallet/provision",
        BROWSER_TOKEN,
        { circleWalletId: "caller-circle-wallet" },
      );
      assert.equal(rejected.status, 400);
      assert.equal(context.calls.provisions.length, 0);

      const provisioned = await postJson(
        server,
        "/api/wallet/provision",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(provisioned.status, 200);
      assert.deepEqual(await provisioned.json(), {
        success: true,
        wallet: {
          address: WALLET_ADDRESS,
          status: "LIVE",
        },
      });
      assert.deepEqual(context.calls.provisions, [AUTH_USER_ID]);
    } finally {
      await server.close();
    }
  });

  it("pauses and resumes with epoch-invalidating repository status transitions, but never resumes closed", async () => {
    const context = createHttpTestContext();
    const { server } = await startTestServer(context);
    try {
      const paused = await postJson(
        server,
        "/api/account/pause",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(paused.status, 200);
      assert.deepEqual(context.calls.statuses, [
        {
          authUserId: AUTH_USER_ID,
          status: "PAUSED",
        },
      ]);

      const resumed = await postJson(
        server,
        "/api/account/resume",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(resumed.status, 200);
      assert.deepEqual(context.calls.statuses.at(-1), {
        authUserId: AUTH_USER_ID,
        status: "ACTIVE",
      });

      context.setAccount({
        ...baseAccount,
        accountStatus: "CLOSED",
        walletStatus: "CLOSED",
      });
      const closed = await postJson(
        server,
        "/api/account/resume",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(closed.status, 409);
      assert.equal(context.calls.statuses.length, 2);
    } finally {
      await server.close();
    }
  });

  it("requires strict confirmed withdrawal input and active tenant-bound authority", async () => {
    const context = createHttpTestContext();
    context.setAuthority({
      ...baseAuthority,
      oauthClientId: undefined,
    });
    const { server } = await startTestServer(context);
    try {
      for (const invalidBody of [
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: false,
        },
        {
          destination: RECIPIENT_ADDRESS,
          amount: "0",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: true,
        },
        {
          destination: "not-an-address",
          amount: "1.0000001",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: true,
        },
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: true,
          tenantId: OTHER_TENANT_ID,
        },
      ]) {
        const rejected = await postJson(
          server,
          "/api/account/withdraw",
          BROWSER_TOKEN,
          invalidBody,
        );
        assert.equal(rejected.status, 400);
      }
      assert.equal(context.calls.mutations.length, 0);

      const withdrawn = await postJson(
        server,
        "/api/account/withdraw",
        BROWSER_TOKEN,
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1.25",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: true,
        },
      );
      assert.equal(withdrawn.status, 200);
      assert.deepEqual(context.calls.mutations[0], {
        authority: {
          ...baseAuthority,
          oauthClientId: undefined,
        },
        input: {
          destination: RECIPIENT_ADDRESS,
          amount: "1.25",
          idempotencyKey: IDEMPOTENCY_KEY,
          purpose: "Hosted account withdrawal",
        },
      });

      context.setAuthority(null);
      const revoked = await postJson(
        server,
        "/api/account/withdraw",
        BROWSER_TOKEN,
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: SECOND_IDEMPOTENCY_KEY,
          confirmed: true,
        },
      );
      assert.equal(revoked.status, 403);
      assert.equal(context.calls.mutations.length, 1);
    } finally {
      await server.close();
    }
  });

  it("fails closed for missing/inactive accounts and returns 202 for durable reconciliation", async () => {
    const missingContext = createHttpTestContext();
    missingContext.setAccount(null);
    const missingServer = await startTestServer(missingContext);
    try {
      const read = await fetch(
        new URL("/api/account", missingServer.server.url),
        {
          headers: {
            authorization: `Bearer ${BROWSER_TOKEN}`,
          },
        },
      );
      assert.equal(read.status, 404);
      const provision = await postJson(
        missingServer.server,
        "/api/wallet/provision",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(provision.status, 404);
    } finally {
      await missingServer.server.close();
    }

    const inactiveContext = createHttpTestContext();
    inactiveContext.setAccount({
      ...baseAccount,
      accountStatus: "PAUSED",
    });
    const inactiveServer = await startTestServer(inactiveContext);
    try {
      const provision = await postJson(
        inactiveServer.server,
        "/api/wallet/provision",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(provision.status, 409);
      inactiveContext.setAccount({
        ...baseAccount,
        accountStatus: "CLOSED",
        walletStatus: "CLOSED",
      });
      const pause = await postJson(
        inactiveServer.server,
        "/api/account/pause",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(pause.status, 409);
    } finally {
      await inactiveServer.server.close();
    }

    const reconciliationContext = createHttpTestContext();
    reconciliationContext.setAuthority({
      ...baseAuthority,
      oauthClientId: undefined,
    });
    const reconciliationServer = await startTestServer(
      reconciliationContext,
      {
        mutationCoordinator: {
          async sendUsdc() {
            return {
              status: "RECONCILIATION_REQUIRED",
              transactionId: "circle-tx-ambiguous",
              transactionHash: `0x${"b".repeat(64)}`,
              reconciliationRequired: true,
            };
          },
        },
      },
    );
    try {
      const response = await postJson(
        reconciliationServer.server,
        "/api/account/withdraw",
        BROWSER_TOKEN,
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
          confirmed: true,
        },
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        success: true,
        withdrawal: {
          status: "RECONCILIATION_REQUIRED",
          transactionId: "circle-tx-ambiguous",
          transactionHash: `0x${"b".repeat(64)}`,
          reconciliationRequired: true,
        },
      });
    } finally {
      await reconciliationServer.server.close();
    }
  });

  it("never exposes raw repository, Circle, token, or secret-bearing errors", async () => {
    const { server } = await startTestServer(
      createHttpTestContext(),
      {
        async provisionWallet() {
          throw new Error(
            "upstream failed with api-key-super-secret",
          );
        },
      },
    );
    try {
      const response = await postJson(
        server,
        "/api/wallet/provision",
        BROWSER_TOKEN,
        {},
      );
      assert.equal(response.status, 500);
      const serialized = JSON.stringify(await response.json());
      assert.equal(serialized.includes("api-key-super-secret"), false);
      assert.equal(serialized.includes(BROWSER_TOKEN), false);
      assert.deepEqual(JSON.parse(serialized), {
        success: false,
        error: "Hosted Arc request failed",
      });
    } finally {
      await server.close();
    }
  });
});

describe("hosted Arc HTTP protocol hardening", () => {
  it("rejects foreign host/origin and emits CORS only for the exact allowed origin", async () => {
    const { server } = await startTestServer();
    try {
      const foreignHost = await absoluteFormRequest(
        server,
        "/healthz",
        "evil.example",
      );
      assert.equal(foreignHost, 421);

      const foreignOrigin = await fetch(server.healthUrl, {
        headers: { origin: "https://evil.example" },
      });
      assert.equal(foreignOrigin.status, 403);
      assert.equal(
        foreignOrigin.headers.get("access-control-allow-origin"),
        null,
      );

      const preflight = await fetch(server.mcpUrl, {
        method: "OPTIONS",
        headers: {
          origin: "https://arc.agentpay.site",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-origin"),
        "https://arc.agentpay.site",
      );
      assert.equal(
        preflight.headers.get("access-control-allow-credentials"),
        null,
      );

      const noOrigin = await fetch(server.healthUrl);
      assert.equal(
        noOrigin.headers.get("access-control-allow-origin"),
        null,
      );
    } finally {
      await server.close();
    }
  });

  it("rejects methods, media types, malformed/oversized JSON, query tokens, and URL credentials", async () => {
    const { server } = await startTestServer();
    try {
      const method = await fetch(server.mcpUrl);
      assert.equal(method.status, 405);
      const contentType = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${MCP_TOKEN}`,
          "content-type": "text/plain",
        },
        body: "{}",
      });
      assert.equal(contentType.status, 415);
      const malformed = await fetch(server.mcpUrl, {
        method: "POST",
        headers: authHeaders(MCP_TOKEN),
        body: "{",
      });
      assert.equal(malformed.status, 400);
      const oversized = await fetch(server.mcpUrl, {
        method: "POST",
        headers: authHeaders(MCP_TOKEN),
        body: JSON.stringify({ padding: "x".repeat(70_000) }),
      });
      assert.equal(oversized.status, 413);
      const queryToken = await fetch(
        `${server.mcpUrl}?access_token=${MCP_TOKEN}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      assert.equal(queryToken.status, 400);

      const credentialStatus = await absoluteFormRequest(
        server,
        `http://user:password@127.0.0.1${ARC_HOSTED_MCP_PATH}`,
      );
      assert.equal(credentialStatus, 400);
      const foreignAbsoluteAuthority = await absoluteFormRequest(
        server,
        "https://evil.example/healthz",
      );
      assert.equal(foreignAbsoluteAuthority, 421);
      const foreignProtocolRelativeAuthority =
        await absoluteFormRequest(
          server,
          "//evil.example/healthz",
        );
      assert.equal(foreignProtocolRelativeAuthority, 421);
      const foreignBackslashAuthority =
        await absoluteFormRequest(
          server,
          String.raw`\\evil.example\healthz`,
        );
      assert.equal(foreignBackslashAuthority, 400);
      const foreignSlashBackslashAuthority =
        await absoluteFormRequest(
          server,
          String.raw`/\evil.example/healthz`,
        );
      assert.equal(foreignSlashBackslashAuthority, 421);
    } finally {
      await server.close();
    }
  });

  it("returns only safe health/readiness state with bounded injected probing and secure headers", async () => {
    let probes = 0;
    const { server } = await startTestServer(
      createHttpTestContext(),
      {
        readinessTimeoutMs: 5,
        async readinessProbe() {
          probes += 1;
          return new Promise<boolean>(() => {});
        },
      },
    );
    try {
      const health = await fetch(server.healthUrl);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        ok: true,
        version: "0.1.11",
      });
      assert.equal(probes, 0);
      assert.equal(
        health.headers.get("x-content-type-options"),
        "nosniff",
      );
      assert.equal(health.headers.get("x-frame-options"), "DENY");
      assert.match(
        health.headers.get("content-security-policy") ?? "",
        /default-src 'none'/,
      );
      assert.match(
        health.headers.get("strict-transport-security") ?? "",
        /max-age=/,
      );

      const readiness = await fetch(server.readinessUrl);
      assert.equal(readiness.status, 503);
      assert.deepEqual(await readiness.json(), {
        ready: false,
        version: "0.1.11",
      });
      assert.equal(probes, 1);
    } finally {
      await server.close();
    }
  });

  it("rate limits every route with a bounded local admission policy", async () => {
    const { server } = await startTestServer(
      createHttpTestContext(),
      { rateLimitMaxRequests: 2 },
    );
    try {
      assert.equal((await fetch(server.healthUrl)).status, 200);
      assert.equal((await fetch(server.healthUrl)).status, 200);
      const limited = await fetch(server.healthUrl);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      assert.deepEqual(await limited.json(), {
        success: false,
        error: "Too many requests",
      });
    } finally {
      await server.close();
    }
  });

  it("gives independent rate-limit buckets to distinct forwarded clients from loopback", async () => {
    const { server } = await startTestServer(
      createHttpTestContext(),
      { rateLimitMaxRequests: 2 },
    );
    try {
      const options = (ip: string) => ({
        headers: { "x-forwarded-for": ip },
      });

      assert.equal(
        (await fetch(server.healthUrl, options("198.51.100.10"))).status,
        200,
      );
      assert.equal(
        (await fetch(server.healthUrl, options("198.51.100.10"))).status,
        200,
      );
      assert.equal(
        (await fetch(server.healthUrl, options("198.51.100.10"))).status,
        429,
      );

      assert.equal(
        (await fetch(server.healthUrl, options("203.0.113.20"))).status,
        200,
      );
      assert.equal(
        (await fetch(server.healthUrl, options("203.0.113.20"))).status,
        200,
      );
      assert.equal(
        (await fetch(server.healthUrl, options("203.0.113.20"))).status,
        429,
      );

      assert.equal(
        (await fetch(server.healthUrl)).status,
        200,
        "a request without X-Forwarded-For uses socket address and gets a fresh bucket",
      );
      assert.equal(
        (await fetch(server.healthUrl)).status,
        200,
      );
      assert.equal(
        (await fetch(server.healthUrl)).status,
        429,
      );
    } finally {
      await server.close();
    }
  });
});

describe("hosted Arc durable mutation coordinator", () => {
  it("uses canonical balance preflight plus atomic idempotency/payload binding and durable audit transitions", async () => {
    const payment = createPaymentRepositoryFake();
    const wallet = createMutationFacade();
    const coordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant(tenantId) {
        assert.equal(tenantId, TENANT_ID);
        return payment.repository;
      },
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          payment,
          authority,
          idempotencyKey,
        ),
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
    });
    const input = {
      destination: RECIPIENT_ADDRESS,
      amount: "1.25",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "Hosted MCP send_usdc",
    };

    const submitted = await coordinator.sendUsdc(
      baseAuthority,
      input,
    );
    assert.deepEqual(submitted, {
      status: "SUBMITTED",
      transactionId: "circle-tx-1",
      reconciliationRequired: false,
    });
    const replay = await coordinator.sendUsdc(
      baseAuthority,
      input,
    );
    assert.deepEqual(replay, submitted);
    assert.equal(wallet.transferCalls(), 1);
    assert.deepEqual(
      payment.calls.transitions.map(({ status }) => status),
      ["SUBMITTED"],
    );
    assert.deepEqual(payment.calls.audit, [
      "PAYMENT_CLAIMED",
      "PAYMENT_TRANSITIONED",
    ]);

    await assert.rejects(
      coordinator.sendUsdc(baseAuthority, {
        ...input,
        amount: "2",
      }),
      /conflicts with persisted input/,
    );
    assert.equal(wallet.transferCalls(), 1);
  });

  it("fails before transfer when canonical USDC balance is absent or insufficient", async () => {
    for (const balance of ["0.5", "0"]) {
      const payment = createPaymentRepositoryFake();
      const wallet = createMutationFacade({ balance });
      const coordinator = createHostedArcMutationCoordinator({
        facade: wallet.facade,
        resolveFreshAuthority: resolveUnchangedAuthority,
        paymentsForTenant: () => payment.repository,
        hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
          hasConflictingUnresolvedMutation(
            payment,
            authority,
            idempotencyKey,
          ),
      });

      await assert.rejects(
        coordinator.sendUsdc(baseAuthority, {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey: IDEMPOTENCY_KEY,
          purpose: "Hosted account withdrawal",
        }),
        /balance preflight failed/,
      );
      assert.equal(wallet.transferCalls(), 0);
      assert.equal(
        payment.receipts.get(IDEMPOTENCY_KEY)?.status,
        "FAILED",
      );
      assert.deepEqual(
        payment.calls.transitions.map(({ status }) => status),
        ["FAILED"],
      );
    }
  });

  it("serializes different mutations for the same user but permits a different user independently", async () => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const payment = createPaymentRepositoryFake();
    const wallet = createMutationFacade({
      async transfer(call) {
        if (call === 1) {
          await firstGate;
        }
        return {
          transactionId: `circle-tx-${call}`,
          state: "INITIATED",
        };
      },
    });
    const coordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant: () => payment.repository,
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          payment,
          authority,
          idempotencyKey,
        ),
    });

    const first = coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "first",
    });
    await waitFor(() => wallet.transferCalls() === 1);
    const second = coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: SECOND_IDEMPOTENCY_KEY,
      purpose: "second",
    });
    const otherUser = coordinator.sendUsdc(
      {
        ...baseAuthority,
        authUserId: OTHER_AUTH_USER_ID,
        tenantId: OTHER_TENANT_ID,
        walletAddress: OTHER_WALLET_ADDRESS,
      },
      {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey:
          "66666666-6666-4666-8666-666666666666",
        purpose: "other-user",
      },
    );
    await otherUser;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, 5));
    assert.equal(wallet.transferCalls(), 2);

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(wallet.transferCalls(), 3);
  });

  it("revalidates queued authority and rejects every inactive or identity-drifted mutation before transfer", async () => {
    const staleAuthorities: ReadonlyArray<
      readonly [string, ArcHostedAuthority | null]
    > = [
      [
        "paused",
        { ...baseAuthority, accountStatus: "PAUSED" },
      ],
      [
        "closed",
        { ...baseAuthority, accountStatus: "CLOSED" },
      ],
      ["missing", null],
      [
        "auth user drift",
        { ...baseAuthority, authUserId: OTHER_AUTH_USER_ID },
      ],
      [
        "tenant drift",
        { ...baseAuthority, tenantId: OTHER_TENANT_ID },
      ],
      [
        "wallet drift",
        { ...baseAuthority, walletAddress: OTHER_WALLET_ADDRESS },
      ],
      [
        "OAuth client drift",
        { ...baseAuthority, oauthClientId: "other-client" },
      ],
      [
        "auth epoch drift",
        { ...baseAuthority, authEpoch: baseAuthority.authEpoch + 1 },
      ],
    ];

    for (const [name, staleAuthority] of staleAuthorities) {
      let releaseFirst = () => {};
      const firstGate = new Promise<void>((resolveGate) => {
        releaseFirst = resolveGate;
      });
      let freshAuthority: ArcHostedAuthority | null = {
        ...baseAuthority,
      };
      const payment = createPaymentRepositoryFake();
      const wallet = createMutationFacade({
        async transfer(call) {
          if (call === 1) {
            await firstGate;
          }
          return {
            transactionId: `circle-tx-${call}`,
            state: "INITIATED",
          };
        },
      });
      const coordinator = createHostedArcMutationCoordinator({
        facade: wallet.facade,
        paymentsForTenant: () => payment.repository,
        resolveFreshAuthority: async () =>
          freshAuthority ? { ...freshAuthority } : null,
        hasConflictingUnresolvedMutation: (
          authority,
          idempotencyKey,
        ) =>
          hasConflictingUnresolvedMutation(
            payment,
            authority,
            idempotencyKey,
          ),
      });

      const first = coordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: `${name}-first`,
      });
      await waitFor(() => wallet.transferCalls() === 1);
      const queued = coordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: SECOND_IDEMPOTENCY_KEY,
        purpose: `${name}-queued`,
      });
      freshAuthority = staleAuthority;
      releaseFirst();

      await first;
      await assert.rejects(
        queued,
        /authority is stale, inactive, or unavailable/,
        name,
      );
      assert.equal(wallet.transferCalls(), 1, name);
      assert.equal(payment.calls.claims.length, 1, name);
    }
  });

  it("revalidates after balance preflight and fails the claimed receipt before any transfer on authority drift", async () => {
    const staleAuthorities: ReadonlyArray<
      readonly [string, ArcHostedAuthority | null]
    > = [
      [
        "paused",
        { ...baseAuthority, accountStatus: "PAUSED" },
      ],
      [
        "closed",
        { ...baseAuthority, accountStatus: "CLOSED" },
      ],
      ["missing", null],
      [
        "auth epoch drift",
        { ...baseAuthority, authEpoch: baseAuthority.authEpoch + 1 },
      ],
    ];

    for (const [name, staleAuthority] of staleAuthorities) {
      let releaseBalance = () => {};
      const balanceGate = new Promise<void>((resolveGate) => {
        releaseBalance = resolveGate;
      });
      let freshAuthority: ArcHostedAuthority | null = {
        ...baseAuthority,
      };
      const payment = createPaymentRepositoryFake();
      const wallet = createMutationFacade({
        async beforeBalancesReturn() {
          await balanceGate;
        },
      });
      const coordinator = createHostedArcMutationCoordinator({
        facade: wallet.facade,
        resolveFreshAuthority: async () =>
          freshAuthority ? { ...freshAuthority } : null,
        paymentsForTenant: () => payment.repository,
        hasConflictingUnresolvedMutation: (
          authority,
          idempotencyKey,
        ) =>
          hasConflictingUnresolvedMutation(
            payment,
            authority,
            idempotencyKey,
          ),
      });

      const mutation = coordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: `${name}-post-balance-check`,
      });
      await waitFor(
        () =>
          payment.calls.claims.length === 1
          && wallet.balanceCalls() === 1,
      );
      freshAuthority = staleAuthority;
      releaseBalance();

      await assert.rejects(
        mutation,
        /authority is stale, inactive, or unavailable/,
        name,
      );
      assert.equal(wallet.transferCalls(), 0, name);
      assert.equal(
        payment.receipts.get(IDEMPOTENCY_KEY)?.status,
        "FAILED",
        name,
      );
      assert.deepEqual(
        payment.calls.transitions.map(({ status }) => status),
        ["FAILED"],
        name,
      );
    }
  });

  it("returns reconciliation without transfer when stale-authority failure cannot be recorded durably", async () => {
    let authorityChecks = 0;
    const payment = createPaymentRepositoryFake({
      async beforeTransition(receipt) {
        if (receipt.status === "FAILED") {
          throw new Error("durable transition unavailable");
        }
      },
    });
    const wallet = createMutationFacade();
    const coordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      async resolveFreshAuthority(trustedAuthority) {
        authorityChecks += 1;
        return authorityChecks === 1
          ? { ...trustedAuthority }
          : null;
      },
      paymentsForTenant: () => payment.repository,
      hasConflictingUnresolvedMutation: (
        authority,
        idempotencyKey,
      ) =>
        hasConflictingUnresolvedMutation(
          payment,
          authority,
          idempotencyKey,
        ),
    });

    const result = await coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "stale authority with undurable failure",
    });

    assert.deepEqual(result, {
      status: "RECONCILIATION_REQUIRED",
      reconciliationRequired: true,
    });
    assert.equal(authorityChecks, 2);
    assert.equal(wallet.transferCalls(), 0);
    assert.equal(
      payment.receipts.get(IDEMPOTENCY_KEY)?.status,
      "SUBMITTING",
    );
  });

  it("records timeout ambiguity before releasing the user queue and never retries a replay", async () => {
    let releaseTransition = () => {};
    let transitionStarted = false;
    const transitionGate = new Promise<void>((resolveGate) => {
      releaseTransition = resolveGate;
    });
    const payment = createPaymentRepositoryFake({
      async beforeTransition(receipt) {
        if (receipt.status === "RECONCILIATION_REQUIRED") {
          transitionStarted = true;
          await transitionGate;
        }
      },
    });
    const wallet = createMutationFacade({
      async transfer(call) {
        if (call === 1) {
          return new Promise(() => {});
        }
        return {
          transactionId: `circle-tx-${call}`,
          state: "INITIATED",
        };
      },
    });
    const coordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant: () => payment.repository,
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          payment,
          authority,
          idempotencyKey,
        ),
      transferTimeoutMs: 5,
    });

    const first = coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "first",
    });
    await waitFor(() => transitionStarted);
    const second = coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: SECOND_IDEMPOTENCY_KEY,
      purpose: "second",
    });
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, 5));
    assert.equal(wallet.transferCalls(), 1);

    releaseTransition();
    const ambiguous = await first;
    assert.deepEqual(ambiguous, {
      status: "RECONCILIATION_REQUIRED",
      reconciliationRequired: true,
    });
    await assert.rejects(
      second,
      /blocked pending durable reconciliation/,
    );
    assert.equal(wallet.transferCalls(), 1);

    const replay = await coordinator.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "first",
    });
    assert.equal(replay.status, "RECONCILIATION_REQUIRED");
    assert.equal(replay.reconciliationRequired, true);
    assert.equal(wallet.transferCalls(), 1);
    assert.equal(
      payment.receipts.get(IDEMPOTENCY_KEY)?.status,
      "RECONCILIATION_REQUIRED",
    );

    const restartedCoordinator =
      createHostedArcMutationCoordinator({
        facade: wallet.facade,
        resolveFreshAuthority: resolveUnchangedAuthority,
        paymentsForTenant: () => payment.repository,
        hasConflictingUnresolvedMutation: (
          authority,
          idempotencyKey,
        ) =>
          hasConflictingUnresolvedMutation(
            payment,
            authority,
            idempotencyKey,
          ),
      });
    const restartedReplay = await restartedCoordinator.sendUsdc(
      baseAuthority,
      {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: "first",
      },
    );
    assert.equal(restartedReplay.status, "RECONCILIATION_REQUIRED");
    await assert.rejects(
      restartedCoordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey:
          "66666666-6666-4666-8666-666666666666",
        purpose: "must remain blocked after restart",
      }),
      /blocked pending durable reconciliation/,
    );
    assert.equal(wallet.transferCalls(), 1);
  });

  it("fails closed on invalid queue limits and bounds active users plus per-user waiters", async () => {
    const payment = createPaymentRepositoryFake();
    const wallet = createMutationFacade();
    for (const invalidOptions of [
      { transferTimeoutMs: 0 },
      { maxActiveUsers: 0 },
      { maxQueuedPerUser: 0 },
    ]) {
      assert.throws(() =>
        createHostedArcMutationCoordinator({
          facade: wallet.facade,
          resolveFreshAuthority: resolveUnchangedAuthority,
          paymentsForTenant: () => payment.repository,
          hasConflictingUnresolvedMutation: (
            authority,
            idempotencyKey,
          ) =>
            hasConflictingUnresolvedMutation(
              payment,
              authority,
              idempotencyKey,
            ),
          ...invalidOptions,
        }));
    }
    const unavailableGate =
      createHostedArcMutationCoordinator({
        facade: wallet.facade,
        resolveFreshAuthority: resolveUnchangedAuthority,
        paymentsForTenant: () => payment.repository,
        async hasConflictingUnresolvedMutation() {
          throw new Error("raw durable query failure");
        },
      });
    await assert.rejects(
      unavailableGate.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: "gate-unavailable",
      }),
      /reconciliation gate is unavailable/,
    );
    assert.equal(wallet.transferCalls(), 0);

    let releaseFirst = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const boundedWallet = createMutationFacade({
      async transfer(call) {
        if (call === 1) {
          await gate;
        }
        return {
          transactionId: `circle-tx-${call}`,
          state: "INITIATED",
        };
      },
    });
    const bounded = createHostedArcMutationCoordinator({
      facade: boundedWallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant: () => payment.repository,
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          payment,
          authority,
          idempotencyKey,
        ),
      maxActiveUsers: 1,
      maxQueuedPerUser: 2,
    });
    const first = bounded.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: IDEMPOTENCY_KEY,
      purpose: "first",
    });
    await waitFor(() => boundedWallet.transferCalls() === 1);
    const queued = bounded.sendUsdc(baseAuthority, {
      destination: RECIPIENT_ADDRESS,
      amount: "1",
      idempotencyKey: SECOND_IDEMPOTENCY_KEY,
      purpose: "queued",
    });
    await assert.rejects(
      bounded.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey:
          "66666666-6666-4666-8666-666666666666",
        purpose: "queue-full",
      }),
      /queue is full/,
    );
    await assert.rejects(
      bounded.sendUsdc(
        {
          ...baseAuthority,
          authUserId: OTHER_AUTH_USER_ID,
          tenantId: OTHER_TENANT_ID,
        },
        {
          destination: RECIPIENT_ADDRESS,
          amount: "1",
          idempotencyKey:
            "77777777-7777-4777-8777-777777777777",
          purpose: "capacity",
        },
      ),
      /capacity is unavailable/,
    );
    releaseFirst();
    await Promise.all([first, queued]);
  });

  it("returns reconciliation when durable transitions fail and preserves safe replay transaction fields", async () => {
    const transitionFailure =
      createPaymentRepositoryFake({
        async beforeTransition() {
          throw new Error("durable transition unavailable");
        },
      });
    const wallet = createMutationFacade();
    const coordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant: () => transitionFailure.repository,
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          transitionFailure,
          authority,
          idempotencyKey,
        ),
    });
    await assert.rejects(
      coordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: "transition failure",
      }),
      /could not be recorded durably/,
    );
    await assert.rejects(
      coordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: SECOND_IDEMPOTENCY_KEY,
        purpose: "must remain blocked",
      }),
      /blocked pending durable reconciliation/,
    );
    assert.equal(wallet.transferCalls(), 1);

    const replayRepository = createPaymentRepositoryFake();
    replayRepository.receipts.set(IDEMPOTENCY_KEY, {
      id: IDEMPOTENCY_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
      walletAddress: WALLET_ADDRESS,
      recipient: RECIPIENT_ADDRESS,
      amount: "1",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "completed replay",
      status: "COMPLETED",
      transactionId: "circle-tx-complete",
      transactionHash: `0x${"a".repeat(64)}`,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
    });
    const replayCoordinator = createHostedArcMutationCoordinator({
      facade: wallet.facade,
      resolveFreshAuthority: resolveUnchangedAuthority,
      paymentsForTenant: () => replayRepository.repository,
      hasConflictingUnresolvedMutation: (authority, idempotencyKey) =>
        hasConflictingUnresolvedMutation(
          replayRepository,
          authority,
          idempotencyKey,
        ),
    });
    assert.deepEqual(
      await replayCoordinator.sendUsdc(baseAuthority, {
        destination: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
        purpose: "completed replay",
      }),
      {
        status: "COMPLETED",
        transactionId: "circle-tx-complete",
        transactionHash: `0x${"a".repeat(64)}`,
        reconciliationRequired: false,
      },
    );
  });
});

describe("hosted Arc entrypoint and package surface", () => {
  it("does not start or make a request merely by importing the executable module", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected import-time request");
    };
    try {
      const module = await import("../hosted-arc-start.ts");
      assert.equal(
        typeof module.startHostedArcFromEnv,
        "function",
      );
      await assert.rejects(
        module.startHostedArcFromEnv({}),
        /ARC_MCP_RESOURCE_URL/,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes the hosted start, HTTP helpers, and both reviewed runtime modules without dependency drift", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../../package.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly name: string;
      readonly version: string;
      readonly scripts: Readonly<Record<string, string>>;
      readonly exports: Readonly<Record<string, string>>;
      readonly files: readonly string[];
    };
    assert.equal(packageJson.name, "@agentpay-ai/mcp-server-arc");
    assert.equal(packageJson.version, "0.1.11");
    assert.equal(
      packageJson.scripts["start:hosted-arc"],
      "tsx src/hosted-arc-start.ts",
    );
    assert.deepEqual(
      {
        http: packageJson.exports["./hosted-arc-http"],
        runtime: packageJson.exports["./hosted-arc-runtime"],
        defaultRuntime:
          packageJson.exports["./default-hosted-arc-runtime"],
        start: packageJson.exports["./hosted-arc-start"],
      },
      {
        http: "./src/mcp/hosted-arc-http.ts",
        runtime: "./src/runtime/hosted-arc-wallet-runtime.ts",
        defaultRuntime:
          "./src/runtime/default-hosted-arc-runtime.ts",
        start: "./src/hosted-arc-start.ts",
      },
    );
    for (const file of [
      "src/hosted-arc-start.ts",
      "src/mcp/hosted-arc-http.ts",
      "src/mcp/hosted-arc-http-api.ts",
      "src/mcp/hosted-arc-http-config.ts",
      "src/mcp/hosted-arc-mutation.ts",
      "src/runtime/hosted-arc-wallet-runtime.ts",
      "src/runtime/default-hosted-arc-runtime.ts",
    ]) {
      assert.ok(packageJson.files.includes(file), file);
    }
  });
});
