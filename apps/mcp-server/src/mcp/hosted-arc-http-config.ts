import { isIP } from "node:net";

import { z } from "zod";

import {
  parseJwtPayloadClaims,
  type SupabaseUserVerifier,
} from "../auth/supabase-user.js";

export const ARC_HOSTED_ALLOWED_ORIGIN =
  "https://arc.agentpay.site" as const;
export const ARC_HOSTED_MCP_PATH = "/mcp" as const;
export const ARC_HOSTED_OAUTH_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "phone",
] as const);

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (hostname) =>
      isIP(hostname) !== 0
      || hostname === "localhost"
      || /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
        hostname,
      ),
    "ARC_MCP_HOST must be a valid hostname or IP address",
  );

const portSchema = z.coerce
  .number()
  .int("ARC_MCP_PORT must be an integer")
  .min(0, "ARC_MCP_PORT must be at least zero")
  .max(65_535, "ARC_MCP_PORT must be at most 65535");

const clientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface HostedArcHttpConfig {
  readonly resourceUrl: string;
  readonly resourceOrigin: string;
  readonly supabaseUrl: string;
  readonly authIssuer: string;
  readonly allowedOrigin: typeof ARC_HOSTED_ALLOWED_ORIGIN;
  readonly hostname: string;
  readonly port: number;
  readonly protectedResourceMetadataUrl: string;
}

export interface HostedArcVerifiedBearer {
  readonly authUserId: string;
  readonly oauthClientId?: string;
  readonly issuer: string;
  readonly audience: "authenticated";
  readonly role: "authenticated";
  readonly expiresAtEpochSeconds: number;
}

export interface HostedArcBearerVerifier {
  verifyAccessToken(
    token: string,
    options: { readonly requireOAuthClientId: boolean },
  ): Promise<HostedArcVerifiedBearer>;
}

export function parseHostedArcHttpConfig(
  env: Readonly<Record<string, string | undefined>>,
): HostedArcHttpConfig {
  const resourceUrl = parseExactHttpsUrl(
    env.ARC_MCP_RESOURCE_URL,
    "ARC_MCP_RESOURCE_URL",
    ARC_HOSTED_MCP_PATH,
  );
  const supabaseUrl = parseExactHttpsUrl(
    env.ARC_SUPABASE_URL,
    "ARC_SUPABASE_URL",
    "/",
  );
  const authIssuer = parseExactHttpsUrl(
    env.ARC_SUPABASE_AUTH_ISSUER,
    "ARC_SUPABASE_AUTH_ISSUER",
    "/auth/v1",
  );
  if (authIssuer.origin !== supabaseUrl.origin) {
    throw new Error(
      "ARC_SUPABASE_AUTH_ISSUER must use the ARC_SUPABASE_URL origin",
    );
  }
  if (env.ARC_MCP_ALLOWED_ORIGINS?.trim() !== ARC_HOSTED_ALLOWED_ORIGIN) {
    throw new Error(
      `ARC_MCP_ALLOWED_ORIGINS must be exactly ${ARC_HOSTED_ALLOWED_ORIGIN}`,
    );
  }

  const hostname = hostnameSchema.parse(
    env.ARC_MCP_HOST ?? "127.0.0.1",
  );
  const port = portSchema.parse(env.ARC_MCP_PORT ?? "3102");
  const protectedResourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    resourceUrl.origin,
  ).toString();

  return Object.freeze({
    resourceUrl: resourceUrl.toString(),
    resourceOrigin: resourceUrl.origin,
    supabaseUrl: supabaseUrl.origin,
    authIssuer: authIssuer.toString(),
    allowedOrigin: ARC_HOSTED_ALLOWED_ORIGIN,
    hostname,
    port,
    protectedResourceMetadataUrl,
  });
}

export function createSupabaseHostedArcBearerVerifier(
  verifier: SupabaseUserVerifier,
  config: Pick<HostedArcHttpConfig, "authIssuer">,
  clock: () => Date = () => new Date(),
): HostedArcBearerVerifier {
  const hostedVerifier: HostedArcBearerVerifier = {
    async verifyAccessToken(
      token: string,
      options: { readonly requireOAuthClientId: boolean },
    ) {
      const verified = await verifier.verifyAccessToken(token, {
        requireOAuthClientId: options.requireOAuthClientId,
      });
      const claims = parseJwtPayloadClaims(token);
      const nowEpochSeconds = Math.floor(clock().getTime() / 1_000);
      const oauthClientId =
        claims.client_id === undefined
          ? undefined
          : clientIdSchema.parse(claims.client_id);

      if (
        typeof claims.sub !== "string"
        || claims.sub !== verified.authUserId
      ) {
        throw new Error("Verified bearer sub claim mismatch");
      }
      if (claims.iss !== config.authIssuer) {
        throw new Error("Verified bearer issuer claim mismatch");
      }
      if (claims.aud !== "authenticated") {
        throw new Error("Verified bearer audience claim mismatch");
      }
      if (claims.role !== "authenticated") {
        throw new Error("Verified bearer role claim mismatch");
      }
      if (
        typeof claims.exp !== "number"
        || !Number.isSafeInteger(claims.exp)
        || claims.exp <= nowEpochSeconds
      ) {
        throw new Error("Verified bearer expiry claim is invalid");
      }
      if (
        verified.oauthClientId !== oauthClientId
        || (options.requireOAuthClientId && !oauthClientId)
      ) {
        throw new Error("Verified bearer OAuth client claim mismatch");
      }

      return Object.freeze({
        authUserId: verified.authUserId,
        ...(oauthClientId ? { oauthClientId } : {}),
        issuer: config.authIssuer,
        audience: "authenticated" as const,
        role: "authenticated" as const,
        expiresAtEpochSeconds: claims.exp,
      });
    },
  };
  return Object.freeze(hostedVerifier);
}

function parseExactHttpsUrl(
  rawValue: string | undefined,
  fieldName: string,
  expectedPathname: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawValue?.trim() ?? "");
  } catch {
    throw new Error(`${fieldName} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== expectedPathname
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(
      `${fieldName} must be credential-free HTTPS with pathname ${expectedPathname}`,
    );
  }
  return parsed;
}
