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

      // Check for OAuth client_id if required
      const appMetadata = (user.app_metadata as Record<string, unknown> | undefined) ?? {};
      const userMetadata = (user.user_metadata as Record<string, unknown> | undefined) ?? {};

      const oauthClientId =
        (typeof appMetadata.client_id === "string" ? appMetadata.client_id : undefined) ??
        (typeof appMetadata.oauth_client_id === "string" ? appMetadata.oauth_client_id : undefined) ??
        (typeof userMetadata.client_id === "string" ? userMetadata.client_id : undefined);

      if (options?.requireOAuthClientId && !oauthClientId) {
        throw new Error("Verified token missing required OAuth client_id");
      }

      return {
        authUserId: user.id,
        oauthClientId,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Authentication verification failed";
      // Ensure raw token is never leaked in error message
      const sanitized = message.replace(cleanToken, "[REDACTED_TOKEN]");
      throw new Error(`Supabase user verification failed: ${sanitized}`);
    }
  }
}
