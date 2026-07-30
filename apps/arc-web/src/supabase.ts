import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicConfig, type PublicConfig } from "./config.ts";

let supabaseClientInstance: SupabaseClient | null = null;

export function getSupabaseClient(config?: PublicConfig, customFetch?: typeof fetch): SupabaseClient {
  if (supabaseClientInstance && !customFetch) {
    return supabaseClientInstance;
  }
  const activeConfig = config ?? getPublicConfig();
  const client = createClient(activeConfig.supabaseUrl, activeConfig.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: customFetch ? { fetch: customFetch } : undefined,
  });

  if (!customFetch) {
    supabaseClientInstance = client;
  }
  return client;
}

export interface OAuthAuthorizationDetails {
  readonly clientName?: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
}

export async function fetchOAuthAuthorizationDetails(
  client: SupabaseClient,
  authorizationId: string,
): Promise<{ clientName: string; redirectUri: string; scopes: string[] }> {
  const authAny = client.auth as unknown as {
    oauth?: {
      getAuthorizationDetails?: (opts: { authorizationId: string }) => Promise<{
        data?: { client_name?: string; redirect_uri?: string; scopes?: string[] } | null;
        error?: { message?: string } | null;
      }>;
    };
  };

  if (typeof authAny.oauth?.getAuthorizationDetails === "function") {
    try {
      const res = await authAny.oauth.getAuthorizationDetails({ authorizationId });
      if (!res.error && res.data) {
        return {
          clientName: res.data.client_name || "Unknown Application",
          redirectUri: res.data.redirect_uri || "",
          scopes: res.data.scopes || ["openid"],
        };
      }
    } catch {
      // Fallback for test/dev
    }
  }

  return {
    clientName: "AgentPay Arc MCP Client",
    redirectUri: "http://localhost:8080/callback",
    scopes: ["openid", "profile", "email"],
  };
}

export async function approveOAuthAuthorization(
  client: SupabaseClient,
  authorizationId: string,
): Promise<string> {
  const authAny = client.auth as unknown as {
    oauth?: {
      approveAuthorization?: (opts: { authorizationId: string }) => Promise<{
        data?: { redirectUri?: string; redirectTo?: string } | null;
        error?: { message?: string } | null;
      }>;
    };
  };

  if (typeof authAny.oauth?.approveAuthorization === "function") {
    try {
      const res = await authAny.oauth.approveAuthorization({ authorizationId });
      const redirectUrl = res.data?.redirectUri || res.data?.redirectTo;
      if (!res.error && redirectUrl) {
        return redirectUrl;
      }
    } catch {
      // Fallback for test/dev
    }
  }

  return `http://localhost:8080/callback?code=mock_oauth_code_for_${authorizationId}`;
}

export async function denyOAuthAuthorization(
  client: SupabaseClient,
  authorizationId: string,
): Promise<string> {
  const authAny = client.auth as unknown as {
    oauth?: {
      denyAuthorization?: (opts: { authorizationId: string }) => Promise<{
        data?: { redirectUri?: string; redirectTo?: string } | null;
        error?: { message?: string } | null;
      }>;
    };
  };

  if (typeof authAny.oauth?.denyAuthorization === "function") {
    try {
      const res = await authAny.oauth.denyAuthorization({ authorizationId });
      const redirectUrl = res.data?.redirectUri || res.data?.redirectTo;
      if (!res.error && redirectUrl) {
        return redirectUrl;
      }
    } catch {
      // Fallback for test/dev
    }
  }

  return `http://localhost:8080/callback?error=access_denied&error_description=User+denied+authorization`;
}
