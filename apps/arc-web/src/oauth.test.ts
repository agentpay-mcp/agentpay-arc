import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSupabaseClient,
  validateAuthorizationId,
  fetchOAuthAuthorizationDetails,
  approveOAuthAuthorization,
  denyOAuthAuthorization,
} from "./supabase.ts";

const VALID_AUTH_ID = "xdjoahdagwfu365xo2c3mwpy3wiaaowg";
const TEST_CONFIG = {
  publicOrigin: "https://arc.agentpay.site",
  apiOrigin: "https://mcp.arc.agentpay.site",
  supabaseUrl: "https://example.supabase.co",
  supabasePublishableKey: "public-key-123",
};

type OAuthClient = Parameters<typeof fetchOAuthAuthorizationDetails>[0];

function fakeOAuthClient(oauth: Record<string, unknown>): OAuthClient {
  return { auth: { oauth } } as unknown as OAuthClient;
}

test("validateAuthorizationId treats Supabase authorization IDs as bounded opaque tokens", () => {
  assert.equal(validateAuthorizationId(`  ${VALID_AUTH_ID}  `), VALID_AUTH_ID);
  assert.equal(validateAuthorizationId("opaque_ID-token-123"), "opaque_ID-token-123");
  assert.throws(
    () => validateAuthorizationId("invalid/id"),
    (err: Error) => err.message === "Invalid authorization_id format.",
  );
  assert.throws(
    () => validateAuthorizationId(" "),
    (err: Error) => err.message === "Invalid authorization_id format.",
  );
  assert.throws(
    () => validateAuthorizationId("x".repeat(161)),
    (err: Error) => err.message === "Invalid authorization_id format.",
  );
});

test("getSupabaseClient initializes a singleton and permits an isolated test transport", () => {
  const client1 = getSupabaseClient(TEST_CONFIG);
  const client2 = getSupabaseClient(TEST_CONFIG);
  assert.equal(client1, client2);

  const customClient = getSupabaseClient(TEST_CONFIG, async () => new Response("{}"));
  assert.notEqual(client1, customClient);
});

test("fetchOAuthAuthorizationDetails accepts a wallet-only Supabase user without exposing identity fields", async () => {
  const client = fakeOAuthClient({
    async getAuthorizationDetails(id: string) {
      assert.equal(id, VALID_AUTH_ID);
      return {
        data: {
          authorization_id: VALID_AUTH_ID,
          redirect_uri: "https://client.example.com/oauth/callback",
          client: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Agentic Tool",
            uri: "https://client.example.com",
            logo_uri: "https://client.example.com/logo.png",
          },
          user: {
            id: "33333333-3333-4333-8333-333333333333",
          },
          scope: "openid profile email",
        },
        error: null,
      };
    },
  });

  assert.deepEqual(await fetchOAuthAuthorizationDetails(client, VALID_AUTH_ID), {
    kind: "consent",
    // Read from `client.id`, which is the field @supabase/auth-js 2.110.0
    // actually returns. This fixture always carried it; the parser was reading
    // `client_id` and therefore dropping it, which left the consent screen
    // unable to resolve a grant for any real client.
    clientId: "22222222-2222-4222-8222-222222222222",
    clientName: "Agentic Tool",
    redirectUri: "https://client.example.com/oauth/callback",
    scopes: ["openid", "profile", "email"],
  });
});

test("fetchOAuthAuthorizationDetails follows an exact Supabase already-consented redirect", async () => {
  const client = fakeOAuthClient({
    async getAuthorizationDetails() {
      return {
        data: { redirect_url: "https://client.example.com/oauth/callback?code=approved&state=abc" },
        error: null,
      };
    },
  });

  assert.deepEqual(await fetchOAuthAuthorizationDetails(client, VALID_AUTH_ID), {
    kind: "redirect",
    redirectUrl: "https://client.example.com/oauth/callback?code=approved&state=abc",
  });
});

test("OAuth detail failures are generic and reject legacy or unsafe response shapes", async () => {
  const rawError = "authorization row leaked for tenant secret";
  const failingClients = [
    fakeOAuthClient({
      async getAuthorizationDetails() {
        throw new Error(rawError);
      },
    }),
    fakeOAuthClient({
      async getAuthorizationDetails() {
        return { data: null, error: { message: rawError } };
      },
    }),
    fakeOAuthClient({
      async getAuthorizationDetails() {
        return {
          data: {
            client: { name: "Legacy Shape" },
            redirect_uri: "https://client.example.com/callback",
            scopes: ["openid"],
          },
          error: null,
        };
      },
    }),
    fakeOAuthClient({
      async getAuthorizationDetails() {
        return { data: { redirect_url: "javascript:alert(document.domain)" }, error: null };
      },
    }),
    fakeOAuthClient({
      async getAuthorizationDetails() {
        return {
          data: { redirect_url: "https://user:password@client.example.com/oauth/callback" },
          error: null,
        };
      },
    }),
    fakeOAuthClient({
      async getAuthorizationDetails() {
        return {
          data: { redirect_url: "http://user:password@localhost:7777/oauth/callback" },
          error: null,
        };
      },
    }),
  ];

  for (const client of failingClients) {
    await assert.rejects(
      () => fetchOAuthAuthorizationDetails(client, VALID_AUTH_ID),
      (err: Error) => {
        assert.equal(err.message, "Unable to load this authorization request. It may be invalid or expired.");
        assert.equal(err.message.includes(rawError), false);
        return true;
      },
    );
  }
});

test("approve and deny use exact SDK arguments and only Supabase redirect_url", async () => {
  const calls: string[] = [];
  const client = fakeOAuthClient({
    async approveAuthorization(id: string, options: { skipBrowserRedirect?: boolean }) {
      calls.push(`approve:${id}:${String(options.skipBrowserRedirect)}`);
      return {
        data: { redirect_url: "https://client.example.com/oauth/callback?code=approved" },
        error: null,
      };
    },
    async denyAuthorization(id: string, options: { skipBrowserRedirect?: boolean }) {
      calls.push(`deny:${id}:${String(options.skipBrowserRedirect)}`);
      return {
        data: { redirect_url: "https://client.example.com/oauth/callback?error=access_denied" },
        error: null,
      };
    },
  });

  assert.equal(
    await approveOAuthAuthorization(client, VALID_AUTH_ID),
    "https://client.example.com/oauth/callback?code=approved",
  );
  assert.equal(
    await denyOAuthAuthorization(client, VALID_AUTH_ID),
    "https://client.example.com/oauth/callback?error=access_denied",
  );
  assert.deepEqual(calls, [
    `approve:${VALID_AUTH_ID}:true`,
    `deny:${VALID_AUTH_ID}:true`,
  ]);
});

test("approve and deny never expose upstream failures or accept fallback URL fields", async () => {
  const rawError = "database token and code verifier leaked";
  const operations = [
    () => approveOAuthAuthorization(fakeOAuthClient({
      async approveAuthorization() {
        throw new Error(rawError);
      },
    }), VALID_AUTH_ID),
    () => approveOAuthAuthorization(fakeOAuthClient({
      async approveAuthorization() {
        return { data: { url: "https://client.example.com/legacy" }, error: null };
      },
    }), VALID_AUTH_ID),
    () => denyOAuthAuthorization(fakeOAuthClient({
      async denyAuthorization() {
        return { data: null, error: { message: rawError } };
      },
    }), VALID_AUTH_ID),
    () => denyOAuthAuthorization(fakeOAuthClient({
      async denyAuthorization() {
        return { data: { redirect_url: "data:text/html,unsafe" }, error: null };
      },
    }), VALID_AUTH_ID),
  ];

  for (const operation of operations) {
    await assert.rejects(
      operation,
      (err: Error) => {
        assert.match(err.message, /^Unable to (approve|deny) this authorization request\. Please try again\.$/);
        assert.equal(err.message.includes(rawError), false);
        return true;
      },
    );
  }
});
