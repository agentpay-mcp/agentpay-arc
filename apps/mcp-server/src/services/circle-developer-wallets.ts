import { z } from "zod";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcEvmAddressSchema,
} from "@agentpay-ai/shared-arc";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";
import { createHash } from "node:crypto";

export interface CircleDeveloperWalletsConfig {
  apiKey: string;
  entitySecret: string;
}

export const CircleDeveloperWalletsConfigSchema = z.object({
  apiKey: z.string().trim().min(1, "Circle API key is required"),
  entitySecret: z
    .string()
    .trim()
    .min(1, "Circle entity secret is required")
    .regex(/^[0-9a-fA-F]{64}$/, "Circle entity secret must be a 64-character hex string"),
});

export function validateCircleDeveloperWalletsConfig(
  config?: Partial<CircleDeveloperWalletsConfig>,
): CircleDeveloperWalletsConfig {
  const apiKey = config?.apiKey ?? process.env.ARC_CIRCLE_API_KEY;
  const entitySecret = config?.entitySecret ?? process.env.ARC_CIRCLE_ENTITY_SECRET;

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("Invalid or missing Circle Developer-Controlled API key configuration");
  }

  if (!entitySecret || typeof entitySecret !== "string" || !/^[0-9a-fA-F]{64}$/.test(entitySecret.trim())) {
    throw new Error("Invalid or missing Circle Developer-Controlled entity secret configuration");
  }

  return {
    apiKey: apiKey.trim(),
    entitySecret: entitySecret.trim(),
  };
}

export function redactSecretsAndFormatError(
  err: unknown,
  config?: Partial<CircleDeveloperWalletsConfig>,
): Error {
  let message = err instanceof Error ? err.message : String(err);

  const secretsToRedact: string[] = [];
  if (config?.apiKey) secretsToRedact.push(config.apiKey);
  if (config?.entitySecret) secretsToRedact.push(config.entitySecret);
  if (process.env.ARC_CIRCLE_API_KEY) secretsToRedact.push(process.env.ARC_CIRCLE_API_KEY);
  if (process.env.ARC_CIRCLE_ENTITY_SECRET) secretsToRedact.push(process.env.ARC_CIRCLE_ENTITY_SECRET);

  for (const s of secretsToRedact) {
    if (s && s.length > 0) {
      message = message.split(s).join("[REDACTED]");
    }
  }

  // Redact Bearer / API key patterns
  message = message.replace(/(?:Bearer|api_key|entity_secret|x-api-key)[\s=:]+([^\s"';,]+)/gi, "[REDACTED]");

  return new Error(`Circle Developer SDK operation failed: ${message}`);
}

export const SdkWalletSetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE).or(z.string()),
});
export type SdkWalletSet = z.infer<typeof SdkWalletSetSchema>;

export const SdkWalletSchema = z.object({
  id: z.string().trim().min(1),
  walletSetId: z.string().trim().min(1),
  address: ArcEvmAddressSchema,
  blockchain: z.literal(ARC_HOSTED_CHAIN).or(z.string()),
  accountType: z.literal(ARC_HOSTED_ACCOUNT_TYPE).or(z.string()),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE).or(z.string()),
  refId: z.string().optional().nullable(),
});
export type SdkWallet = z.infer<typeof SdkWalletSchema>;

export const SdkTokenBalanceSchema = z.object({
  token: z.object({
    id: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    address: z.string().optional(),
  }),
  amount: z.string(),
});

export const SdkBalancesResponseSchema = z.object({
  tokenBalances: z.array(SdkTokenBalanceSchema).default([]),
});

export const SdkTransactionSchema = z.object({
  id: z.string().trim().min(1),
  state: z.string().trim().min(1),
  txHash: z.string().optional().nullable(),
});
export type SdkTransaction = z.infer<typeof SdkTransactionSchema>;

export interface CircleDeveloperSdkClient {
  createWalletSet(input: { name: string; idempotencyKey?: string }): Promise<{ data?: { walletSet?: unknown } }>;
  listWalletSets(input?: { name?: string }): Promise<{ data?: { walletSets?: unknown[] } }>;
  createWallets(input: {
    blockchains: string[];
    count: number;
    walletSetId: string;
    accountType: string;
    refId?: string;
    idempotencyKey?: string;
  }): Promise<{ data?: { wallets?: unknown[] } }>;
  listWallets(input: { walletSetId: string; refId?: string }): Promise<{ data?: { wallets?: unknown[] } }>;
  getWalletTokenBalance(input: { walletId: string }): Promise<{ data?: { tokenBalances?: unknown[] } }>;
  createTransaction?(input: unknown): Promise<{ data?: { id?: string; state?: string; txHash?: string } }>;
  getTransaction?(input: { id: string }): Promise<{ data?: { transaction?: unknown } }>;
}

export function deriveWalletSetName(tenantId: string): string {
  const hash = createHash("sha256").update(`tenant-ws:${tenantId}`).digest("hex").substring(0, 16);
  return `arc-ws-${hash}`;
}

export function deriveWalletRefId(tenantId: string): string {
  const hash = createHash("sha256").update(`tenant-ref:${tenantId}`).digest("hex").substring(0, 16);
  return `arc-ref-${hash}`;
}

export class CircleDeveloperWalletsAdapter {
  private readonly sdkClient: CircleDeveloperSdkClient;
  private readonly config: CircleDeveloperWalletsConfig;

  constructor(
    config?: Partial<CircleDeveloperWalletsConfig>,
    customSdkClient?: CircleDeveloperSdkClient,
  ) {
    this.config = validateCircleDeveloperWalletsConfig(config);
    if (customSdkClient) {
      this.sdkClient = customSdkClient;
    } else {
      throw new Error("SDK client injection required or production factory not provided in test harness");
    }
  }

  async ensureWalletSetForTenant(tenantId: string): Promise<SdkWalletSet> {
    const walletSetName = deriveWalletSetName(tenantId);
    try {
      const listRes = await this.sdkClient.listWalletSets({ name: walletSetName });
      const rawSets = listRes.data?.walletSets ?? [];
      const matchingSets = rawSets
        .map((s) => SdkWalletSetSchema.safeParse(s))
        .filter((r): r is { success: true; data: SdkWalletSet } => r.success && r.data.name === walletSetName)
        .map((r) => r.data);

      if (matchingSets.length > 0) {
        return matchingSets[0];
      }
    } catch {
      // Proceed to try create with idempotency key if list failed
    }

    try {
      const createRes = await this.sdkClient.createWalletSet({
        name: walletSetName,
        idempotencyKey: deriveWalletSetName(tenantId),
      });
      const rawSet = createRes.data?.walletSet;
      if (!rawSet) {
        throw new Error("Empty walletSet response from Circle Developer SDK");
      }
      return SdkWalletSetSchema.parse(rawSet);
    } catch (err) {
      // Reconcile if creation returned error or timed out
      try {
        const listRes = await this.sdkClient.listWalletSets({ name: walletSetName });
        const rawSets = listRes.data?.walletSets ?? [];
        const matchingSets = rawSets
          .map((s) => SdkWalletSetSchema.safeParse(s))
          .filter((r): r is { success: true; data: SdkWalletSet } => r.success && r.data.name === walletSetName)
          .map((r) => r.data);
        if (matchingSets.length > 0) {
          return matchingSets[0];
        }
      } catch {
        // ignore list reconciliation error
      }
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async ensureScaWalletForTenant(
    tenantId: string,
    walletSetId: string,
    idempotencyKey: string,
  ): Promise<SdkWallet> {
    const refId = deriveWalletRefId(tenantId);

    // 1. Reconciliation check first
    try {
      const listRes = await this.sdkClient.listWallets({ walletSetId, refId });
      const rawWallets = listRes.data?.wallets ?? [];
      const matchingWallets = rawWallets
        .map((w) => SdkWalletSchema.safeParse(w))
        .filter(
          (r): r is { success: true; data: SdkWallet } =>
            r.success && r.data.blockchain === ARC_HOSTED_CHAIN && r.data.accountType === ARC_HOSTED_ACCOUNT_TYPE,
        )
        .map((r) => r.data);

      if (matchingWallets.length > 0) {
        return matchingWallets[0];
      }
    } catch {
      // ignore list error before creation
    }

    // 2. Create SCA Wallet
    try {
      const createRes = await this.sdkClient.createWallets({
        blockchains: [ARC_HOSTED_CHAIN],
        count: 1,
        walletSetId,
        accountType: ARC_HOSTED_ACCOUNT_TYPE,
        refId,
        idempotencyKey,
      });

      const rawWallets = createRes.data?.wallets ?? [];
      if (rawWallets.length === 0) {
        throw new Error("Empty wallets response from Circle Developer SDK");
      }

      const parsedWallet = SdkWalletSchema.parse(rawWallets[0]);
      if (
        parsedWallet.blockchain !== ARC_HOSTED_CHAIN ||
        parsedWallet.accountType !== ARC_HOSTED_ACCOUNT_TYPE ||
        parsedWallet.custodyType !== ARC_HOSTED_CUSTODY_TYPE
      ) {
        throw new Error(
          `Created wallet does not match required properties: expected ${ARC_HOSTED_CHAIN}/${ARC_HOSTED_ACCOUNT_TYPE}/${ARC_HOSTED_CUSTODY_TYPE}`,
        );
      }

      return parsedWallet;
    } catch (err) {
      // 3. Reconcile on creation failure or timeout
      try {
        const listRes = await this.sdkClient.listWallets({ walletSetId, refId });
        const rawWallets = listRes.data?.wallets ?? [];
        const matchingWallets = rawWallets
          .map((w) => SdkWalletSchema.safeParse(w))
          .filter(
            (r): r is { success: true; data: SdkWallet } =>
              r.success && r.data.blockchain === ARC_HOSTED_CHAIN && r.data.accountType === ARC_HOSTED_ACCOUNT_TYPE,
          )
          .map((r) => r.data);

        if (matchingWallets.length > 0) {
          return matchingWallets[0];
        }
      } catch {
        // ignore list reconciliation error
      }
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async provisionHostedUserWallet(input: {
    authUserId: string;
    tenantId: string;
    provisioningIdempotencyKey: string;
    fencingToken: string;
    repository: ArcHostedAccountRepository;
  }): Promise<{ walletSetId: string; walletId: string; walletAddress: string }> {
    try {
      const walletSet = await this.ensureWalletSetForTenant(input.tenantId);
      const scaWallet = await this.ensureScaWalletForTenant(
        input.tenantId,
        walletSet.id,
        input.provisioningIdempotencyKey,
      );

      await input.repository.completeProvisioning({
        authUserId: input.authUserId,
        fencingToken: input.fencingToken,
        circleWalletSetId: walletSet.id,
        circleWalletId: scaWallet.id,
        walletAddress: scaWallet.address,
      });

      return {
        walletSetId: walletSet.id,
        walletId: scaWallet.id,
        walletAddress: scaWallet.address,
      };
    } catch (err) {
      const formattedError = redactSecretsAndFormatError(err, this.config);
      try {
        await input.repository.failProvisioning({
          authUserId: input.authUserId,
          fencingToken: input.fencingToken,
          errorCode: "PROVISIONING_FAILED",
        });
      } catch {
        // ignore failProvisioning errors if repository call fails
      }
      throw formattedError;
    }
  }

  async getWalletBalances(walletId: string): Promise<Array<{ symbol: string; amount: string; address?: string }>> {
    try {
      const res = await this.sdkClient.getWalletTokenBalance({ walletId });
      const parsed = SdkBalancesResponseSchema.parse(res.data ?? {});
      return parsed.tokenBalances.map((tb) => ({
        symbol: tb.token.symbol ?? "USDC",
        amount: tb.amount,
        address: tb.token.address,
      }));
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }
}
