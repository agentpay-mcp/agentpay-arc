import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArcSupabaseUserConfig, SupabaseUserVerifierImpl } from "./supabase-user.js";

describe("SupabaseUserVerifier", () => {
  const config = {
    supabaseUrl: "https://arc-project.supabase.co",
    authIssuer: "https://arc-project.supabase.co/auth/v1",
    publishableKey: "sb-publishable-key-123",
  };

  it("parses valid Arc Supabase user auth config", () => {
    const parsed = parseArcSupabaseUserConfig({
      ARC_SUPABASE_URL: "https://arc-project.supabase.co",
      ARC_SUPABASE_AUTH_ISSUER: "https://arc-project.supabase.co/auth/v1",
      ARC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-key-123",
    });

    assert.equal(parsed.supabaseUrl, "https://arc-project.supabase.co");
    assert.equal(parsed.authIssuer, "https://arc-project.supabase.co/auth/v1");
    assert.equal(parsed.publishableKey, "sb-publishable-key-123");
  });

  it("rejects insecure or invalid Arc Supabase URL", () => {
    assert.throws(
      () =>
        parseArcSupabaseUserConfig({
          ARC_SUPABASE_URL: "http://insecure-supabase.com",
          ARC_SUPABASE_PUBLISHABLE_KEY: "sb-key",
        }),
      /ARC_SUPABASE_URL/i,
    );
  });

  it("verifies a valid Supabase JWT and extracts authUserId", async () => {
    const fakeClient = {
      auth: {
        async getUser(token: string) {
          if (token === "valid-user-jwt") {
            return {
              data: {
                user: {
                  id: "a0000000-0000-4000-8000-000000000001",
                  role: "authenticated",
                  app_metadata: {
                    provider: "email",
                  },
                },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error("Invalid JWT token") };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    const result = await verifier.verifyAccessToken("valid-user-jwt");

    assert.equal(result.authUserId, "a0000000-0000-4000-8000-000000000001");
  });

  it("verifies OAuth JWT with client_id requirement when specified", async () => {
    const fakeClient = {
      auth: {
        async getUser(token: string) {
          if (token === "valid-oauth-jwt") {
            return {
              data: {
                user: {
                  id: "a0000000-0000-4000-8000-000000000001",
                  role: "authenticated",
                  app_metadata: {
                    client_id: "mcp-client-xyz",
                  },
                },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error("Invalid JWT token") };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    const result = await verifier.verifyAccessToken("valid-oauth-jwt", {
      requireOAuthClientId: true,
    });

    assert.equal(result.authUserId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(result.oauthClientId, "mcp-client-xyz");
  });

  it("rejects token missing OAuth client_id when required", async () => {
    const fakeClient = {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: "a0000000-0000-4000-8000-000000000001",
                role: "authenticated",
                app_metadata: {},
              },
            },
            error: null,
          };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    await assert.rejects(
      () =>
        verifier.verifyAccessToken("jwt-without-client-id", {
          requireOAuthClientId: true,
        }),
      /oauth client_id/i,
    );
  });

  it("rejects token with unauthenticated role or invalid user id", async () => {
    const fakeClient = {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: "a0000000-0000-4000-8000-000000000001",
                role: "anon",
              },
            },
            error: null,
          };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    await assert.rejects(
      () => verifier.verifyAccessToken("anon-token"),
      /authenticated/i,
    );
  });

  it("redacts raw token from error messages", async () => {
    const fakeClient = {
      auth: {
        async getUser() {
          return { data: { user: null }, error: new Error("Invalid token format") };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    const secretToken = "super-secret-bearer-token-12345";

    try {
      await verifier.verifyAccessToken(secretToken);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(!err.message.includes(secretToken));
    }
  });
});
