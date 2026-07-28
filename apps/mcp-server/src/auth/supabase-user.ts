import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ArcSupabaseUserConfigSchema = z.object({
  supabaseUrl: z.string().url().refine((url) => url.startsWith("https://"), {
    message: "ARC_SUPABASE_URL must be a valid HTTPS URL",
  }),
  authIssuer: z.string().url().optional(),
  publishableKey: z.string().trim().min(1, "ARC_SUPABASE_PUBLISHABLE_KEY is required"),
});
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
    this.supabaseClient =
      customClient ??
      createClient(config.supabaseUrl, config.publishableKey, {
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
      if (user.role && user.role !== "authenticated") {
        throw new Error("User role must be authenticated");
      }

      if (!user.id || typeof user.id !== "string") {
        throw new Error("Missing or malformed user ID in verified token");
      }

      // 2. Decode verified JWT payload claims for top-level security claim validation
      const claims = parseJwtPayloadClaims(cleanToken);

      // Validate top-level issuer if configured
      const expectedIssuer = this.config.authIssuer ?? `${this.config.supabaseUrl}/auth/v1`;
      if (claims.iss && typeof claims.iss === "string" && claims.iss !== expectedIssuer) {
        throw new Error(`Token issuer mismatch: expected ${expectedIssuer}, received ${claims.iss}`);
      }

      // Validate token expiration if present in claims
      if (typeof claims.exp === "number") {
        const nowSec = Math.floor(Date.now() / 1000);
        if (claims.exp <= nowSec) {
          throw new Error("Token has expired");
        }
      }

      // Read top-level client_id claim ONLY (never from user_metadata or app_metadata)
      const topLevelClientId =
        typeof claims.client_id === "string" && claims.client_id.trim().length > 0
          ? claims.client_id.trim()
          : typeof claims.oauth_client_id === "string" && claims.oauth_client_id.trim().length > 0
          ? claims.oauth_client_id.trim()
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
      // Ensure raw token is never leaked in error message
      const sanitized = message.replace(cleanToken, "[REDACTED_TOKEN]");
      throw new Error(`Supabase user verification failed: ${sanitized}`);
    }
  }
}
