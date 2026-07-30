import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  parseArcSupabaseUserConfig,
  SupabaseUserVerifierImpl,
} from "./auth/supabase-user.js";
import {
  createHostedArcMutationCoordinator,
  createSupabaseHostedArcBearerVerifier,
  parseHostedArcHttpConfig,
  startHostedArcHttpServer,
  type HostedArcHttpServer,
} from "./mcp/hosted-arc-http.js";
import { createDefaultHostedArcRuntime } from "./runtime/default-hosted-arc-runtime.js";
import { ArcHostedAccountRepositoryImpl } from "./services/arc-hosted-accounts.js";
import {
  createTenantArcPaymentRepositories,
  type ArcPaymentSupabaseClient,
  type ArcPaymentSupabaseQuery,
} from "./services/arc-payments-supabase.js";
import {
  CircleDeveloperWalletsAdapter,
  validateCircleDeveloperWalletsConfig,
} from "./services/circle-developer-wallets.js";
import { CircleHostedWalletFacade } from "./services/circle-hosted-wallet-facade.js";

const hostedArcSecretConfigSchema = z
  .object({
    ARC_SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  })
  .passthrough();
const unresolvedMutationRowsSchema = z
  .array(
    z
      .object({
        idempotency_key: z.string().uuid(),
      })
      .strict(),
  )
  .max(1);

export async function startHostedArcFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HostedArcHttpServer> {
  const httpConfig = parseHostedArcHttpConfig(env);
  const userConfig = parseArcSupabaseUserConfig({ ...env });
  const secrets = hostedArcSecretConfigSchema.parse(env);
  const circleConfig = validateCircleDeveloperWalletsConfig({
    apiKey: env.ARC_CIRCLE_API_KEY,
    entitySecret: env.ARC_CIRCLE_ENTITY_SECRET,
  });

  const serviceClient = createClient(
    httpConfig.supabaseUrl,
    secrets.ARC_SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const repository = new ArcHostedAccountRepositoryImpl(serviceClient);
  const paymentClient: ArcPaymentSupabaseClient = {
    from(table) {
      return serviceClient
        .from(table) as unknown as ArcPaymentSupabaseQuery;
    },
    rpc(functionName, args) {
      return serviceClient.rpc(
        functionName,
        args,
      ) as unknown as ReturnType<ArcPaymentSupabaseClient["rpc"]>;
    },
  };
  const circleAdapter = new CircleDeveloperWalletsAdapter(circleConfig);
  const facade = new CircleHostedWalletFacade(
    circleAdapter,
    repository,
  );
  const mutationCoordinator = createHostedArcMutationCoordinator({
    facade,
    paymentsForTenant(tenantId) {
      return createTenantArcPaymentRepositories(
        paymentClient,
        tenantId,
      ).payments;
    },
    async hasConflictingUnresolvedMutation(
      authority,
      idempotencyKey,
    ) {
      const { data, error } = await serviceClient
        .from("arc_payment_receipts")
        .select("idempotency_key")
        .eq("tenant_id", authority.tenantId)
        .eq("wallet_address", authority.walletAddress)
        .in("status", [
          "SUBMITTING",
          "RECONCILIATION_REQUIRED",
        ])
        .neq("idempotency_key", idempotencyKey)
        .limit(1);
      if (error) {
        throw new Error(
          "Hosted mutation reconciliation gate failed",
        );
      }
      return unresolvedMutationRowsSchema.parse(data ?? []).length > 0;
    },
  });
  const verifier = createSupabaseHostedArcBearerVerifier(
    new SupabaseUserVerifierImpl(userConfig),
    httpConfig,
  );

  return startHostedArcHttpServer({
    config: httpConfig,
    verifier,
    repository,
    async provisionWallet(authUserId) {
      return circleAdapter.provisionHostedUserWallet({
        authUserId,
        repository,
      });
    },
    createRuntime(authority) {
      return createDefaultHostedArcRuntime(authority, {
        env,
        repository,
        facade,
      });
    },
    mutationCoordinator,
    async readinessProbe() {
      const { error } = await serviceClient
        .from("arc_hosted_accounts")
        .select("auth_user_id")
        .limit(1);
      return error === null;
    },
  });
}

function isMainModule(
  moduleUrl: string,
  entrypoint: string | undefined,
): boolean {
  return (
    entrypoint !== undefined
    && fileURLToPath(moduleUrl) === resolve(entrypoint)
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  startHostedArcFromEnv().catch(() => {
    console.error("Hosted Arc MCP failed to start.");
    process.exitCode = 1;
  });
}
