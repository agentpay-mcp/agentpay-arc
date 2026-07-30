import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSupabaseClient,
  fetchOAuthAuthorizationDetails,
  approveOAuthAuthorization,
  denyOAuthAuthorization,
} from "./supabase.ts";
import { uuidV4Schema } from "@agentpay-ai/shared-arc";

const VALID_AUTH_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

test("validate uuidV4 for authorization_id", () => {
  assert.equal(uuidV4Schema.safeParse(VALID_AUTH_ID).success, true);
  assert.equal(uuidV4Schema.safeParse("invalid-id").success, false);
});

test("getSupabaseClient initializes client singleton", () => {
  const client1 = getSupabaseClient();
  const client2 = getSupabaseClient();
  assert.equal(client1, client2);
});

test("fetchOAuthAuthorizationDetails returns details from mocked client", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async getAuthorizationDetails({ authorizationId }: { authorizationId: string }) {
          assert.equal(authorizationId, VALID_AUTH_ID);
          return {
            data: {
              client_name: "Test OAuth Client",
              redirect_uri: "https://client.example.com/oauth/callback",
              scopes: ["openid", "email"],
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof fetchOAuthAuthorizationDetails>[0];

  const details = await fetchOAuthAuthorizationDetails(fakeClient, VALID_AUTH_ID);
  assert.equal(details.clientName, "Test OAuth Client");
  assert.equal(details.redirectUri, "https://client.example.com/oauth/callback");
  assert.deepEqual(details.scopes, ["openid", "email"]);
});

test("approveOAuthAuthorization returns redirect URL", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async approveAuthorization({ authorizationId }: { authorizationId: string }) {
          assert.equal(authorizationId, VALID_AUTH_ID);
          return {
            data: {
              redirectUri: "https://client.example.com/oauth/callback?code=approved_code_123",
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof approveOAuthAuthorization>[0];

  const redirectUrl = await approveOAuthAuthorization(fakeClient, VALID_AUTH_ID);
  assert.equal(redirectUrl, "https://client.example.com/oauth/callback?code=approved_code_123");
});

test("denyOAuthAuthorization returns denial redirect URL", async () => {
  const fakeClient = {
    auth: {
      oauth: {
        async denyAuthorization({ authorizationId }: { authorizationId: string }) {
          assert.equal(authorizationId, VALID_AUTH_ID);
          return {
            data: {
              redirectUri: "https://client.example.com/oauth/callback?error=access_denied",
            },
            error: null,
          };
        },
      },
    },
  } as unknown as Parameters<typeof denyOAuthAuthorization>[0];

  const redirectUrl = await denyOAuthAuthorization(fakeClient, VALID_AUTH_ID);
  assert.equal(redirectUrl, "https://client.example.com/oauth/callback?error=access_denied");
});

test("fallback functions return standard testing defaults on standard client", async () => {
  const standardClient = getSupabaseClient();
  const details = await fetchOAuthAuthorizationDetails(standardClient, VALID_AUTH_ID);
  assert.equal(details.clientName, "AgentPay Arc MCP Client");

  const approveUrl = await approveOAuthAuthorization(standardClient, VALID_AUTH_ID);
  assert.ok(approveUrl.includes("mock_oauth_code"));

  const denyUrl = await denyOAuthAuthorization(standardClient, VALID_AUTH_ID);
  assert.ok(denyUrl.includes("error=access_denied"));
});
