import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ArcSupabaseUserConfigSchema = z
  .object({
    supabaseUrl: z.string().url().refine((url) => url.startsWith("https://"), {
      message: "ARC_SUPABASE_URL must be a valid HTTPS URL",
    }),
    authIssuer: z.string().url().optional(),
    publishableKey: z.string().trim().min(1, "ARC_SUPABASE_PUBLISHABLE_KEY is required"),
  })
  .refine(
    (cfg) => {
      if (!cfg.authIssuer) return true;
      try {
        const supabaseOrigin = new URL(cfg.supabaseUrl).origin;
        const issuerUrl = new URL(cfg.authIssuer);
        return issuerUrl.protocol === "https:" && issuerUrl.origin === supabaseOrigin;
      } catch {
        return false;
      }
    },
    { message: "ARC_SUPABASE_AUTH_ISSUER must be an HTTPS URL on the same origin as ARC_SUPABASE_URL" },
  );
export type ArcSupabaseUserConfig = z.infer<typeof ArcSupabaseUserConfigSchema>;

export function parseArcSupabaseUserConfig(env: Record<string, string | undefined>): ArcSupabaseUserConfig {
  return ArcSupabaseUserConfigSchema.parse({
    supabaseUrl: env.ARC_SUPABASE_URL,
    authIssuer: env.ARC_SUPABASE_AUTH_ISSUER,
    publishableKey: env.ARC_SUPABASE_PUBLISHABLE_KEY,
  });
}

export interface SupabaseUserVerifier {
  verifyAccessToken(
    token: string,
    options?: { requireOAuthClientId?: boolean },
  ): Promise<{
    readonly authUserId: string;
    readonly oauthClientId?: string;
  }>;
}

export function parseJwtPayloadClaims(token: string): Record<string, unknown> {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT token structure");
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid JWT payload");
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    throw new Error("Failed to decode JWT payload claims");
  }
}

export class SupabaseUserVerifierImpl implements SupabaseUserVerifier {
  private readonly config: ArcSupabaseUserConfig;
  private readonly supabaseClient: SupabaseClient;

  constructor(config: ArcSupabaseUserConfig, customClient?: SupabaseClient) {
    this.config = config;

    const expectedUrl = new URL(config.supabaseUrl);
    const timeoutMs = 10_000;

    const pinnedFetch: typeof fetch = async (url, options) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const parsedUrl = new URL(urlString);

      if (parsedUrl.origin !== expectedUrl.origin) {
        throw new Error(`Fetch destination origin mismatch: expected ${expectedUrl.origin}, received ${parsedUrl.origin}`);
      }

      if (parsedUrl.protocol !== "https:") {
        throw new Error("Fetch destination must use HTTPS protocol");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const customFetch = (options as any)?.fetch ?? fetch;
        const response = await customFetch(urlString, {
          ...options,
          redirect: "error",
          signal: controller.signal,
        });
        return response;
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw new Error(`Supabase network request timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    this.supabaseClient =
      customClient ??
      createClient(config.supabaseUrl, config.publishableKey, {
        global: {
          fetch: pinnedFetch,
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
  }

  async verifyAccessToken(
    token: string,
    options?: { requireOAuthClientId?: boolean },
  ): Promise<{
    readonly authUserId: string;
    readonly oauthClientId?: string;
  }> {
    const cleanToken = token?.trim();
    if (!cleanToken) {
      throw new Error("Missing or empty bearer token");
    }

    try {
      // 1. Verify cryptographic validity with Supabase auth service
      const { data, error } = await this.supabaseClient.auth.getUser(cleanToken);

      if (error || !data?.user) {
        throw new Error("Invalid or expired Supabase authentication token");
      }

      const user = data.user;
      if (!user.id || typeof user.id !== "string") {
        throw new Error("Missing or malformed user ID in verified token");
      }

      if (user.role && user.role !== "authenticated") {
        throw new Error("User role must be authenticated");
      }

      // 2. Decode verified JWT payload claims for mandatory fail-closed claim validation
      const claims = parseJwtPayloadClaims(cleanToken);

      // Require sub claim to be present, string, and match user.id
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub !== user.id) {
        throw new Error("Token sub claim mismatch or missing");
      }

      // Require top-level iss claim to be present string and match expectedIssuer
      const expectedIssuer = this.config.authIssuer ?? `${this.config.supabaseUrl}/auth/v1`;
      if (typeof claims.iss !== "string" || !claims.iss || claims.iss !== expectedIssuer) {
        throw new Error("Token issuer mismatch or missing");
      }

      // Require top-level aud claim to be present string and match expectedAudience
      const expectedAudience = "authenticated";
      if (typeof claims.aud !== "string" || !claims.aud || claims.aud !== expectedAudience) {
        throw new Error("Token audience mismatch or missing");
      }

      // Require top-level role claim to be present string and match 'authenticated'
      if (typeof claims.role !== "string" || !claims.role || claims.role !== "authenticated") {
        throw new Error("Token role claim must be 'authenticated'");
      }

      // Require top-level exp claim to be present numeric and in the future
      if (typeof claims.exp !== "number" || isNaN(claims.exp)) {
        throw new Error("Token missing mandatory numeric exp claim");
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (claims.exp <= nowSec) {
        throw new Error("Token has expired");
      }

      // Read top-level client_id claim ONLY (never from user_metadata/app_metadata, do NOT accept undocumented aliases)
      const topLevelClientId =
        typeof claims.client_id === "string" && claims.client_id.trim().length > 0
          ? claims.client_id.trim()
          : undefined;

      if (options?.requireOAuthClientId && !topLevelClientId) {
        throw new Error("Verified token missing required top-level OAuth client_id claim");
      }

      return {
        authUserId: user.id,
        oauthClientId: topLevelClientId,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Authentication verification failed";
      // Known internal validation failure messages pass through cleanly without raw tokens
      const isKnownValidationError =
        message.includes("Invalid or expired") ||
        message.includes("Token sub claim") ||
        message.includes("Token issuer") ||
        message.includes("Token audience") ||
        message.includes("Token role claim") ||
        message.includes("Token missing mandatory") ||
        message.includes("Token has expired") ||
        message.includes("Verified token missing") ||
        message.includes("Missing or malformed") ||
        message.includes("User role must") ||
        message.startsWith("Fetch destination");

      if (isKnownValidationError) {
        const sanitized = message.replace(cleanToken, "[REDACTED_TOKEN]");
        throw new Error(`Supabase user verification failed: ${sanitized}`);
      }

      // Map raw/upstream errors to a generic fail-closed error message
      throw new Error("Supabase user verification failed: Authentication service error");
    }
  }
}
