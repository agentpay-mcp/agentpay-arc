import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

import {
  ArcHostedAccountRepositoryImpl,
  type ArcHostedAccountRepository,
} from "../services/arc-hosted-accounts.js";
import {
  CircleDeveloperWalletsAdapter,
  validateCircleDeveloperWalletsConfig,
  type CircleDeveloperWalletsConfig,
} from "../services/circle-developer-wallets.js";
import { CircleHostedWalletFacade } from "../services/circle-hosted-wallet-facade.js";
import {
  createHostedArcWalletRuntime,
  type HostedArcWalletFacade,
  type HostedArcWalletRuntime,
} from "./hosted-arc-wallet-runtime.js";

const defaultHostedArcRepositoryEnvSchema = z
  .object({
    ARC_SUPABASE_URL: z
      .string()
      .trim()
      .url("ARC_SUPABASE_URL must be a valid URL")
      .refine((url) => url.startsWith("https://"), {
        message: "ARC_SUPABASE_URL must use HTTPS",
      }),
    ARC_SUPABASE_SERVICE_ROLE_KEY: z
      .string()
      .trim()
      .min(1, "ARC_SUPABASE_SERVICE_ROLE_KEY is required"),
  })
  .passthrough();

export interface DefaultHostedArcRepositoryConfig {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
}

export interface DefaultHostedArcRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repository?: ArcHostedAccountRepository;
  readonly facade?: HostedArcWalletFacade;
  readonly repositoryFactory?: (
    config: DefaultHostedArcRepositoryConfig,
  ) => ArcHostedAccountRepository;
  readonly facadeFactory?: (
    config: CircleDeveloperWalletsConfig,
    repository: ArcHostedAccountRepository,
  ) => HostedArcWalletFacade;
}

export function createDefaultHostedArcRuntime(
  authority: ArcHostedAuthority,
  options: DefaultHostedArcRuntimeOptions = {},
): HostedArcWalletRuntime {
  const env = options.env ?? process.env;
  const repository =
    options.repository
    ?? (options.repositoryFactory ?? createDefaultRepository)(
      parseRepositoryConfig(env),
    );
  const facade =
    options.facade
    ?? (options.facadeFactory ?? createDefaultFacade)(
      validateCircleDeveloperWalletsConfig({
        apiKey: env.ARC_CIRCLE_API_KEY,
        entitySecret: env.ARC_CIRCLE_ENTITY_SECRET,
      }),
      repository,
    );

  return createHostedArcWalletRuntime({
    authority,
    repository,
    facade,
  });
}

function parseRepositoryConfig(
  env: Readonly<Record<string, string | undefined>>,
): DefaultHostedArcRepositoryConfig {
  const parsed = defaultHostedArcRepositoryEnvSchema.parse(env);
  return Object.freeze({
    supabaseUrl: parsed.ARC_SUPABASE_URL,
    serviceRoleKey: parsed.ARC_SUPABASE_SERVICE_ROLE_KEY,
  });
}

function createDefaultRepository(
  config: DefaultHostedArcRepositoryConfig,
): ArcHostedAccountRepository {
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return new ArcHostedAccountRepositoryImpl(client);
}

function createDefaultFacade(
  config: CircleDeveloperWalletsConfig,
  repository: ArcHostedAccountRepository,
): HostedArcWalletFacade {
  const adapter = new CircleDeveloperWalletsAdapter(config);
  return new CircleHostedWalletFacade(adapter, repository);
}
