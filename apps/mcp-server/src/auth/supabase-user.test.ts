import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArcSupabaseUserConfig, SupabaseUserVerifierImpl } from "./supabase-user.js";

function makeMockJwt(payload: Record<string, unknown>): string {
  const defaultPayload = {
    sub: "a0000000-0000-4000-8000-000000000001",
    role: "authenticated",
    aud: "authenticated",
    iss: "https://arc-project.supabase.co/auth/v1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const merged = { ...defaultPayload, ...payload };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(merged)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

describe("SupabaseUserVerifier", () => {
  const config = {
    supabaseUrl: "https://arc-project.supabase.co",
    authIssuer: "https://arc-project.supabase.co/auth/v1",
    publishableKey: "sb-publishable-key-123",
  };

  const validUserId = "a0000000-0000-4000-8000-000000000001";

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
    const jwt = makeMockJwt({
      sub: validUserId,
      role: "authenticated",
      iss: "https://arc-project.supabase.co/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const fakeClient = {
      auth: {
        async getUser(token: string) {
          if (token === jwt) {
            return {
              data: {
                user: {
                  id: validUserId,
                  role: "authenticated",
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
    const result = await verifier.verifyAccessToken(jwt);

    assert.equal(result.authUserId, validUserId);
  });

  it("verifies OAuth JWT with top-level client_id claim requirement when specified", async () => {
    const jwt = makeMockJwt({
      sub: validUserId,
      role: "authenticated",
      client_id: "mcp-client-xyz",
      iss: "https://arc-project.supabase.co/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const fakeClient = {
      auth: {
        async getUser(token: string) {
          if (token === jwt) {
            return {
              data: {
                user: {
                  id: validUserId,
                  role: "authenticated",
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
    const result = await verifier.verifyAccessToken(jwt, {
      requireOAuthClientId: true,
    });

    assert.equal(result.authUserId, validUserId);
    assert.equal(result.oauthClientId, "mcp-client-xyz");
  });

  it("rejects token with client_id ONLY in user_metadata when top-level claim is missing", async () => {
    const jwt = makeMockJwt({
      sub: validUserId,
      role: "authenticated",
      iss: "https://arc-project.supabase.co/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const fakeClient = {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: validUserId,
                role: "authenticated",
                user_metadata: {
                  client_id: "attacker-controlled-client",
                },
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
        verifier.verifyAccessToken(jwt, {
          requireOAuthClientId: true,
        }),
      /top-level OAuth client_id/i,
    );
  });

  it("rejects token with issuer mismatch", async () => {
    const jwt = makeMockJwt({
      sub: validUserId,
      role: "authenticated",
      iss: "https://untrusted-issuer.com/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const fakeClient = {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: validUserId,
                role: "authenticated",
              },
            },
            error: null,
          };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);
    await assert.rejects(
      () => verifier.verifyAccessToken(jwt),
      /issuer mismatch/i,
    );
  });

  it("rejects token missing mandatory sub, aud, or role claim or sub mismatch", async () => {
    const fakeClient = {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: validUserId,
                role: "authenticated",
              },
            },
            error: null,
          };
        },
      },
    };
    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);

    // Mismatched sub
    const badSubJwt = makeMockJwt({ sub: "different-user-id" });
    await assert.rejects(() => verifier.verifyAccessToken(badSubJwt), /sub claim mismatch/i);

    // Missing aud
    const badAudJwt = makeMockJwt({ aud: undefined });
    await assert.rejects(() => verifier.verifyAccessToken(badAudJwt), /audience mismatch or missing/i);

    // Missing role
    const badRoleJwt = makeMockJwt({ role: undefined });
    await assert.rejects(() => verifier.verifyAccessToken(badRoleJwt), /role claim must be 'authenticated'/i);
  });

  it("redacts raw token from error messages", async () => {
    const secretToken = makeMockJwt({ sub: "secret" });
    const fakeClient = {
      auth: {
        async getUser() {
          return { data: { user: null }, error: new Error("Invalid token format") };
        },
      },
    };

    const verifier = new SupabaseUserVerifierImpl(config, fakeClient as any);

    try {
      await verifier.verifyAccessToken(secretToken);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(!err.message.includes(secretToken));
    }
  });
});
