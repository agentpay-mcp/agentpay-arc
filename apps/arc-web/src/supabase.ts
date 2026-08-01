import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
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

const AuthorizationIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

const SafeRedirectUrlSchema = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  if (url.username || url.password) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
});

const OAuthConsentDetailsSchema = z.object({
  authorization_id: AuthorizationIdSchema,
  redirect_uri: SafeRedirectUrlSchema,
  client: z.object({
    name: z.string().trim().min(1).max(200),
    // Optional because the authorization-details payload is the authorization
    // server's shape, not ours. When absent the consent screen cannot look up
    // this client's grant and falls back to reporting no payment access, which
    // is the same thing an absent grant means.
    client_id: z.string().trim().min(1).max(256).optional(),
  }),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email().optional(),
  }),
  scope: z.string().trim().min(1).max(512),
});

const OAuthRedirectSchema = z.object({
  redirect_url: SafeRedirectUrlSchema,
});

export function validateAuthorizationId(authorizationId: string): string {
  const result = AuthorizationIdSchema.safeParse(authorizationId);
  if (!result.success) {
    throw new Error("Invalid authorization_id format.");
  }
  return result.data;
}

export type OAuthAuthorizationState =
  | {
      readonly kind: "consent";
      readonly clientName: string;
      readonly clientId?: string;
      readonly redirectUri: string;
      readonly scopes: readonly string[];
    }
  | {
      readonly kind: "redirect";
      readonly redirectUrl: string;
    };

export async function fetchOAuthAuthorizationDetails(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<OAuthAuthorizationState> {
  const authorizationId = validateAuthorizationId(rawAuthorizationId);

  try {
    const { data, error } = await client.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !data) {
      throw new Error("authorization details unavailable");
    }

    const redirect = OAuthRedirectSchema.safeParse(data);
    if (redirect.success) {
      return {
        kind: "redirect",
        redirectUrl: redirect.data.redirect_url,
      };
    }

    const details = OAuthConsentDetailsSchema.parse(data);
    return {
      kind: "consent",
      clientName: details.client.name,
      ...(details.client.client_id ? { clientId: details.client.client_id } : {}),
      redirectUri: details.redirect_uri,
      scopes: details.scope.split(/\s+/),
    };
  } catch {
    throw new Error("Unable to load this authorization request. It may be invalid or expired.");
  }
}

async function submitOAuthDecision(
  client: SupabaseClient,
  rawAuthorizationId: string,
  decision: "approve" | "deny",
): Promise<string> {
  const authorizationId = validateAuthorizationId(rawAuthorizationId);

  try {
    const response = decision === "approve"
      ? await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (response.error || !response.data) {
      throw new Error("authorization decision failed");
    }
    return OAuthRedirectSchema.parse(response.data).redirect_url;
  } catch {
    throw new Error(`Unable to ${decision} this authorization request. Please try again.`);
  }
}

export function approveOAuthAuthorization(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<string> {
  return submitOAuthDecision(client, rawAuthorizationId, "approve");
}

export function denyOAuthAuthorization(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<string> {
  return submitOAuthDecision(client, rawAuthorizationId, "deny");
}
