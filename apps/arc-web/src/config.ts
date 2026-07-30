import { z } from "zod";

const SafeHttpsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((val) => {
    const url = new URL(val);
    return (
      (
        url.protocol === "https:"
        || (
          url.protocol === "http:"
          && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        )
      )
      && !url.username
      && !url.password
    );
  }, { message: "Must be a valid HTTPS URL without embedded user credentials" })
  .refine((val) => {
    const url = new URL(val);
    return val === url.origin || val === `${url.origin}/`;
  }, { message: "Must be an HTTPS origin without path, query, or fragment" })
  .transform((val) => new URL(val).origin);

const PublicConfigSchema = z.object({
  publicOrigin: SafeHttpsUrlSchema,
  apiOrigin: SafeHttpsUrlSchema,
  supabaseUrl: SafeHttpsUrlSchema,
  supabasePublishableKey: z.string().trim().min(1),
});

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export function getPublicConfig(env?: Record<string, string | undefined>): PublicConfig {
  const metaEnv = (typeof import.meta !== "undefined" && (import.meta as unknown as { env?: Record<string, string | undefined> }).env)
    ? (import.meta as unknown as { env: Record<string, string | undefined> }).env
    : {};
  const activeEnv = env ?? metaEnv;

  const sensitiveKeys = ["ARC_CIRCLE_API_KEY", "ARC_SUPABASE_SERVICE_ROLE_KEY", "ARC_CIRCLE_ENTITY_SECRET"];
  for (const key of sensitiveKeys) {
    if (activeEnv[key] !== undefined) {
      throw new Error(`Security Violation: ${key} must never be exposed to the browser client.`);
    }
  }

  const allowedViteKeys = new Set([
    "VITE_ARC_PUBLIC_ORIGIN",
    "VITE_ARC_API_ORIGIN",
    "VITE_ARC_SUPABASE_URL",
    "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
  ]);

  for (const key of Object.keys(activeEnv)) {
    if (key.startsWith("VITE_ARC_") && !allowedViteKeys.has(key)) {
      throw new Error(`Security Violation: Unapproved environment variable ${key} detected in client environment.`);
    }
  }

  const publicOrigin = activeEnv.VITE_ARC_PUBLIC_ORIGIN;
  const apiOrigin = activeEnv.VITE_ARC_API_ORIGIN;
  const supabaseUrl = activeEnv.VITE_ARC_SUPABASE_URL;
  const supabasePublishableKey = activeEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY;

  if (!publicOrigin || !apiOrigin || !supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing required public environment variables: VITE_ARC_PUBLIC_ORIGIN, VITE_ARC_API_ORIGIN, VITE_ARC_SUPABASE_URL, and VITE_ARC_SUPABASE_PUBLISHABLE_KEY must all be defined."
    );
  }

  return PublicConfigSchema.parse({
    publicOrigin,
    apiOrigin,
    supabaseUrl,
    supabasePublishableKey,
  });
}
