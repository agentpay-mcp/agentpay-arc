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

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateAuthorizationId(authorizationId: string): string {
  const trimmed = authorizationId.trim();
  if (!UUID_V4_REGEX.test(trimmed)) {
    throw new Error("Invalid authorization_id format: Must be a valid UUID v4.");
  }
  return trimmed;
}

export interface OAuthAuthorizationDetails {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

interface SupabaseOAuthApi {
  getAuthorizationDetails?: (authorizationId: string | { authorization_id: string; authorizationId?: string }) => Promise<{
    data?: {
      client?: { name?: string; icon_url?: string; uri?: string };
      client_name?: string;
      scope?: string;
      scopes?: string[];
      redirect_url?: string;
      redirect_uri?: string;
    } | null;
    error?: { message?: string } | null;
  }>;
  approveAuthorization?: (
    authorizationId: string | { authorization_id: string; authorizationId?: string },
    options?: { skipBrowserRedirect?: boolean },
  ) => Promise<{
    data?: { redirect_url?: string; url?: string; redirect_uri?: string; redirectTo?: string } | null;
    error?: { message?: string } | null;
  }>;
  denyAuthorization?: (
    authorizationId: string | { authorization_id: string; authorizationId?: string },
    options?: { skipBrowserRedirect?: boolean },
  ) => Promise<{
    data?: { redirect_url?: string; url?: string; redirect_uri?: string; redirectTo?: string } | null;
    error?: { message?: string } | null;
  }>;
}

function getOAuthApi(client: SupabaseClient): SupabaseOAuthApi {
  const authObj = client.auth as unknown as { oauth?: SupabaseOAuthApi };
  if (!authObj.oauth) {
    throw new Error("Supabase OAuth 2.1 server capabilities are not initialized on this client.");
  }
  return authObj.oauth;
}

export async function fetchOAuthAuthorizationDetails(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<OAuthAuthorizationDetails> {
  const authorizationId = validateAuthorizationId(rawAuthorizationId);
  const oauthApi = getOAuthApi(client);

  if (typeof oauthApi.getAuthorizationDetails !== "function") {
    throw new Error("OAuth server error: getAuthorizationDetails is unavailable.");
  }

  let res;
  try {
    res = await oauthApi.getAuthorizationDetails(authorizationId);
  } catch (err: unknown) {
    throw new Error(`OAuth server error: ${(err as Error)?.message || "Failed to fetch authorization details"}`);
  }

  if (res?.error || !res?.data) {
    throw new Error(`OAuth server error: ${res?.error?.message || "Invalid authorization_id or request expired."}`);
  }

  const data = res.data;
  const clientName = data.client?.name || data.client_name || "Unknown Application";
  const redirectUri = data.redirect_url || data.redirect_uri || "";

  let scopes: string[] = ["openid"];
  if (typeof data.scope === "string" && data.scope.trim().length > 0) {
    scopes = data.scope.trim().split(/\s+/);
  } else if (Array.isArray(data.scopes) && data.scopes.length > 0) {
    scopes = data.scopes;
  }

  return {
    clientName,
    redirectUri,
    scopes,
  };
}

export async function approveOAuthAuthorization(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<string> {
  const authorizationId = validateAuthorizationId(rawAuthorizationId);
  const oauthApi = getOAuthApi(client);

  if (typeof oauthApi.approveAuthorization !== "function") {
    throw new Error("OAuth server error: approveAuthorization is unavailable.");
  }

  let res;
  try {
    res = await oauthApi.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
  } catch (err: unknown) {
    throw new Error(`OAuth approval error: ${(err as Error)?.message || "Failed to approve authorization"}`);
  }

  const redirectUrl = res?.data?.redirect_url || res?.data?.url || res?.data?.redirect_uri || res?.data?.redirectTo;
  if (res?.error || !redirectUrl) {
    throw new Error(`OAuth approval failed: ${res?.error?.message || "No redirect URL returned by authorization server."}`);
  }

  return redirectUrl;
}

export async function denyOAuthAuthorization(
  client: SupabaseClient,
  rawAuthorizationId: string,
): Promise<string> {
  const authorizationId = validateAuthorizationId(rawAuthorizationId);
  const oauthApi = getOAuthApi(client);

  if (typeof oauthApi.denyAuthorization !== "function") {
    throw new Error("OAuth server error: denyAuthorization is unavailable.");
  }

  let res;
  try {
    res = await oauthApi.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  } catch (err: unknown) {
    throw new Error(`OAuth denial error: ${(err as Error)?.message || "Failed to deny authorization"}`);
  }

  const redirectUrl = res?.data?.redirect_url || res?.data?.url || res?.data?.redirect_uri || res?.data?.redirectTo;
  if (res?.error || !redirectUrl) {
    throw new Error(`OAuth denial failed: ${res?.error?.message || "No redirect URL returned by authorization server."}`);
  }

  return redirectUrl;
}
