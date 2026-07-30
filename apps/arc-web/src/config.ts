import { z } from "zod";

const PublicConfigSchema = z.object({
  publicOrigin: z.string().trim().url(),
  apiOrigin: z.string().trim().url(),
  supabaseUrl: z.string().trim().url(),
  supabasePublishableKey: z.string().trim().min(1),
});

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export function getPublicConfig(env?: Record<string, string | undefined>): PublicConfig {
  const metaEnv = (typeof import.meta !== "undefined" && (import.meta as unknown as { env?: Record<string, string | undefined> }).env)
    ? (import.meta as unknown as { env: Record<string, string | undefined> }).env
    : {};
  const activeEnv = env ?? metaEnv;
  const publicOrigin = activeEnv.VITE_ARC_PUBLIC_ORIGIN || (typeof window !== "undefined" ? window.location.origin : "https://arc.agentpay.site");
  const apiOrigin = activeEnv.VITE_ARC_API_ORIGIN || "https://mcp.arc.agentpay.site";
  const supabaseUrl = activeEnv.VITE_ARC_SUPABASE_URL || "https://fake-project.supabase.co";
  const supabasePublishableKey = activeEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY || "fake-publishable-key-for-tests";

  // Security enforcement: Ensure no secret keys exist in client env
  const sensitiveKeys = ["ARC_CIRCLE_API_KEY", "ARC_SUPABASE_SERVICE_ROLE_KEY", "ARC_CIRCLE_ENTITY_SECRET"];
  for (const key of sensitiveKeys) {
    if (activeEnv[key] !== undefined) {
      throw new Error(`Security Violation: ${key} must never be exposed to the browser client.`);
    }
  }

  return PublicConfigSchema.parse({
    publicOrigin,
    apiOrigin,
    supabaseUrl,
    supabasePublishableKey,
  });
}
