import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSupabaseClient,
  validateAuthorizationId,
  fetchOAuthAuthorizationDetails,
  approveOAuthAuthorization,
  denyOAuthAuthorization,
} from "./supabase.ts";

const VALID_AUTH_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const TEST_CONFIG = {
  publicOrigin: "https://arc.agentpay.site",
  apiOrigin: "https://mcp.arc.agentpay.site",
  supabaseUrl: "https://example.supabase.co",
  supabasePublishableKey: "public-key-123",
};

test("validateAuthorizationId checks UUID v4 format", () => {
  assert.equal(validateAuthorizationId(VALID_AUTH_ID), VALID_AUTH_ID);
  assert.throws(
    () => validateAuthorizationId("not-a-uuid"),
    (err: Error) => err.message.includes("Must be a valid UUID v4"),
  );
});

test("getSupabaseClient initializes client singleton and accepts customFetch", () => {
  const client1 = getSupabaseClient(TEST_CONFIG);
  const client2 = getSupabaseClient(TEST_CONFIG);
  assert.equal(client1, client2);

  const customClient = getSupabaseClient(TEST_CONFIG, async () => new Response("{}"));
  assert.notEqual(client1, customClient);
});

test("fetchOAuthAuthorizationDetails parses client, redirect_url, and space-separated scope or array scopes", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails(id: string) {
          assert.equal(id, VALID_AUTH_ID);
          return {
            data: {
              client: { name: "Agentic Tool" },
              redirect_url: "https://client.example.com/oauth/callback",
              scope: "openid profile email",
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];

  const details = await fetchOAuthAuthorizationDetails(fakeClient, VALID_AUTH_ID);
  assert.equal(details.clientName, "Agentic Tool");
  assert.equal(details.redirectUri, "https://client.example.com/oauth/callback");
  assert.deepEqual(details.scopes, ["openid", "profile", "email"]);

  const arrayScopesClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails() {
          return {
            data: {
              client_name: "Fallback App",
              redirect_uri: "https://client.example.com/cb",
              scopes: ["openid", "offline_access"],
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];

  const details2 = await fetchOAuthAuthorizationDetails(arrayScopesClient, VALID_AUTH_ID);
  assert.equal(details2.clientName, "Fallback App");
  assert.equal(details2.redirectUri, "https://client.example.com/cb");
  assert.deepEqual(details2.scopes, ["openid", "offline_access"]);

  const emptyDataClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails() {
          return {
            data: {},
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];

  const details3 = await fetchOAuthAuthorizationDetails(emptyDataClient, VALID_AUTH_ID);
  assert.equal(details3.clientName, "Unknown Application");
  assert.equal(details3.redirectUri, "");
  assert.deepEqual(details3.scopes, ["openid"]);
});

test("fetchOAuthAuthorizationDetails fails closed on missing oauth capabilities, thrown error, or API error", async () => {
  const noOauthClient = { auth: {} } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];
  await assert.rejects(
    () => fetchOAuthAuthorizationDetails(noOauthClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Supabase OAuth 2.1 server capabilities are not initialized"),
  );

  const missingMethodClient = { auth: { oauth: {} } } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];
  await assert.rejects(
    () => fetchOAuthAuthorizationDetails(missingMethodClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("getAuthorizationDetails is unavailable"),
  );

  const throwClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails() {
          throw new Error("Network crash");
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];
  await assert.rejects(
    () => fetchOAuthAuthorizationDetails(throwClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Network crash"),
  );

  const errorClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails() {
          return { data: null, error: { message: "Request expired" } };
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];

  await assert.rejects(
    () => fetchOAuthAuthorizationDetails(errorClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Request expired"),
  );
});

test("approveOAuthAuthorization returns redirect_url and fails closed on error or missing url", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async approveAuthorization(id: string, opts?: { skipBrowserRedirect?: boolean }) {
          assert.equal(id, VALID_AUTH_ID);
          assert.equal(opts?.skipBrowserRedirect, true);
          return {
            data: {
              redirect_url: "https://client.example.com/oauth/callback?code=approved_123",
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof approveOAuthAuthorization>[0];

  const redirectUrl = await approveOAuthAuthorization(fakeClient, VALID_AUTH_ID);
  assert.equal(redirectUrl, "https://client.example.com/oauth/callback?code=approved_123");

  const urlFallbackClient = {
    auth: {
      oauth: {
        async approveAuthorization() {
          return { data: { url: "https://client.example.com/oauth/callback?code=url_fallback" }, error: null };
        },
      },
    },
  } as unknown as Parameters<typeof approveOAuthAuthorization>[0];
  const redirectUrl2 = await approveOAuthAuthorization(urlFallbackClient, VALID_AUTH_ID);
  assert.equal(redirectUrl2, "https://client.example.com/oauth/callback?code=url_fallback");

  const missingMethodClient = { auth: { oauth: {} } } as unknown as Parameters<typeof approveOAuthAuthorization>[0];
  await assert.rejects(
    () => approveOAuthAuthorization(missingMethodClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("approveAuthorization is unavailable"),
  );

  const throwClient = {
    auth: {
      oauth: {
        async approveAuthorization() {
          throw new Error("Network timeout");
        },
      },
    },
  } as unknown as Parameters<typeof approveOAuthAuthorization>[0];
  await assert.rejects(
    () => approveOAuthAuthorization(throwClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Network timeout"),
  );

  const failClient = {
    auth: {
      oauth: {
        async approveAuthorization() {
          return { data: null, error: { message: "Approval rejected" } };
        },
      },
    },
  } as unknown as Parameters<typeof approveOAuthAuthorization>[0];

  await assert.rejects(
    () => approveOAuthAuthorization(failClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Approval rejected"),
  );
});

test("denyOAuthAuthorization returns redirect_url and fails closed on error or missing url", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async denyAuthorization(id: string) {
          assert.equal(id, VALID_AUTH_ID);
          return {
            data: {
              redirect_url: "https://client.example.com/oauth/callback?error=access_denied",
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof denyOAuthAuthorization>[0];

  const redirectUrl = await denyOAuthAuthorization(fakeClient, VALID_AUTH_ID);
  assert.equal(redirectUrl, "https://client.example.com/oauth/callback?error=access_denied");

  const missingMethodClient = { auth: { oauth: {} } } as unknown as Parameters<typeof denyOAuthAuthorization>[0];
  await assert.rejects(
    () => denyOAuthAuthorization(missingMethodClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("denyAuthorization is unavailable"),
  );

  const throwClient = {
    auth: {
      oauth: {
        async denyAuthorization() {
          throw new Error("Connection reset");
        },
      },
    },
  } as unknown as Parameters<typeof denyOAuthAuthorization>[0];
  await assert.rejects(
    () => denyOAuthAuthorization(throwClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Connection reset"),
  );

  const failClient = {
    auth: {
      oauth: {
        async denyAuthorization() {
          return { data: null, error: { message: "Denial error" } };
        },
      },
    },
  } as unknown as Parameters<typeof denyOAuthAuthorization>[0];

  await assert.rejects(
    () => denyOAuthAuthorization(failClient, VALID_AUTH_ID),
    (err: Error) => err.message.includes("Denial error"),
  );
});
