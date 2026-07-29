import { z } from "zod";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcEvmAddressSchema,
  ArcHostedAuthority,
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

export class CircleReconciliationRequiredError extends Error {
  constructor(message: string = "Operation state ambiguous; reconciliation required before retry") {
    super(message);
    this.name = "CircleReconciliationRequiredError";
  }
}

export function redactSecretsAndFormatError(
  err: unknown,
  config?: Partial<CircleDeveloperWalletsConfig>,
): Error {
  if (err instanceof CircleReconciliationRequiredError) {
    return err;
  }

  const rawMessage = err instanceof Error ? err.message : String(err);
  if (rawMessage.includes("ETIMEDOUT") || rawMessage.includes("timeout") || rawMessage.includes("ECONNRESET")) {
    return new CircleReconciliationRequiredError("Circle API request timed out; state ambiguous");
  }

  return new Error("Circle Developer SDK operation failed: UPSTREAM_ERROR");
}

export const SdkWalletSetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE),
});
export type SdkWalletSet = z.infer<typeof SdkWalletSetSchema>;

export const SdkWalletSchema = z.object({
  id: z.string().trim().min(1),
  walletSetId: z.string().trim().min(1),
  address: ArcEvmAddressSchema,
  blockchain: z.literal(ARC_HOSTED_CHAIN),
  accountType: z.literal(ARC_HOSTED_ACCOUNT_TYPE),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE),
  refId: z.string().trim().min(1).optional().nullable(),
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
  walletId: z.string().trim().min(1).optional().nullable(),
});
export type SdkTransaction = z.infer<typeof SdkTransactionSchema>;

export interface CircleDeveloperSdkClient {
  createWalletSet(input: { name: string; idempotencyKey?: string }): Promise<{ data?: { walletSet?: any } }>;
  listWalletSets(input?: { pageBefore?: string; pageAfter?: string; pageSize?: number }): Promise<{ data?: { walletSets?: any[] } }>;
  createWallets(input: {
    blockchains: string[];
    count: number;
    walletSetId: string;
    accountType: string;
    metadata?: Array<{ refId: string }>;
    idempotencyKey?: string;
  }): Promise<{ data?: { wallets?: any[] } }>;
  listWallets(input: { walletSetId?: string; pageBefore?: string; pageAfter?: string; pageSize?: number }): Promise<{ data?: { wallets?: any[] } }>;
  getWalletTokenBalance(input: { id: string }): Promise<{ data?: { tokenBalances?: any[] } }>;
  createTransaction?(input: {
    walletId: string;
    destinationAddress: string;
    amounts: string[];
    tokenId?: string;
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
    idempotencyKey?: string;
  }): Promise<{ data?: { id?: string; state?: string; txHash?: string; walletId?: string } }>;
  createContractExecutionTransaction?(input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: any[];
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
    idempotencyKey?: string;
  }): Promise<{ data?: { id?: string; state?: string; txHash?: string; walletId?: string } }>;
  getTransaction?(input: { id: string }): Promise<{ data?: { transaction?: any } }>;
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
      this.sdkClient = initiateDeveloperControlledWalletsClient({
        apiKey: this.config.apiKey,
        entitySecret: this.config.entitySecret,
      }) as unknown as CircleDeveloperSdkClient;
    }
  }

  async ensureWalletSetForTenant(tenantId: string, idempotencyKey: string): Promise<SdkWalletSet> {
    const walletSetName = deriveWalletSetName(tenantId);
    let listSucceeded = false;
    try {
      const listRes = await this.sdkClient.listWalletSets();
      listSucceeded = true;
      const rawSets = listRes.data?.walletSets ?? [];
      const matchingSets = rawSets
        .map((s) => SdkWalletSetSchema.safeParse(s))
        .filter(
          (r): r is { success: true; data: SdkWalletSet } =>
            r.success && r.data.name === walletSetName && r.data.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        )
        .map((r) => r.data);

      if (matchingSets.length > 0) {
        return matchingSets[0];
      }
    } catch {
      listSucceeded = false;
    }

    if (!listSucceeded) {
      throw new CircleReconciliationRequiredError("Preflight listWalletSets failed; state inconclusive");
    }

    try {
      const createRes = await this.sdkClient.createWalletSet({
        name: walletSetName,
        idempotencyKey,
      });
      const rawSet = createRes.data?.walletSet;
      const parsedSet = SdkWalletSetSchema.safeParse(rawSet);
      if (!parsedSet.success || parsedSet.data.name !== walletSetName || parsedSet.data.custodyType !== ARC_HOSTED_CUSTODY_TYPE) {
        throw new Error("Created wallet set does not match required properties");
      }
      return parsedSet.data;
    } catch (err) {
      try {
        const listRes = await this.sdkClient.listWalletSets();
        const rawSets = listRes.data?.walletSets ?? [];
        const matchingSets = rawSets
          .map((s) => SdkWalletSetSchema.safeParse(s))
          .filter(
            (r): r is { success: true; data: SdkWalletSet } =>
              r.success && r.data.name === walletSetName && r.data.custodyType === ARC_HOSTED_CUSTODY_TYPE,
          )
          .map((r) => r.data);
        if (matchingSets.length > 0) {
          return matchingSets[0];
        }
      } catch {
        // ignore list error during reconciliation
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
    let listSucceeded = false;

    try {
      const listRes = await this.sdkClient.listWallets({ walletSetId });
      listSucceeded = true;
      const rawWallets = listRes.data?.wallets ?? [];
      const matchingWallets = rawWallets
        .map((w) => SdkWalletSchema.safeParse(w))
        .filter(
          (r): r is { success: true; data: SdkWallet } =>
            r.success &&
            r.data.walletSetId === walletSetId &&
            r.data.refId === refId &&
            r.data.blockchain === ARC_HOSTED_CHAIN &&
            r.data.accountType === ARC_HOSTED_ACCOUNT_TYPE &&
            r.data.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        )
        .map((r) => r.data);

      if (matchingWallets.length > 0) {
        return matchingWallets[0];
      }
    } catch {
      listSucceeded = false;
    }

    if (!listSucceeded) {
      throw new CircleReconciliationRequiredError("Preflight listWallets failed; state inconclusive");
    }

    try {
      const createRes = await this.sdkClient.createWallets({
        blockchains: [ARC_HOSTED_CHAIN],
        count: 1,
        walletSetId,
        accountType: ARC_HOSTED_ACCOUNT_TYPE,
        metadata: [{ refId }],
        idempotencyKey,
      });

      const rawWallets = createRes.data?.wallets ?? [];
      const validWallets = rawWallets
        .map((w) => SdkWalletSchema.safeParse(w))
        .filter(
          (r): r is { success: true; data: SdkWallet } =>
            r.success &&
            r.data.walletSetId === walletSetId &&
            r.data.refId === refId &&
            r.data.blockchain === ARC_HOSTED_CHAIN &&
            r.data.accountType === ARC_HOSTED_ACCOUNT_TYPE &&
            r.data.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        )
        .map((r) => r.data);

      if (validWallets.length === 0) {
        throw new Error("Created wallet does not match required DEVELOPER SCA properties");
      }

      return validWallets[0];
    } catch (err) {
      try {
        const listRes = await this.sdkClient.listWallets({ walletSetId });
        const rawWallets = listRes.data?.wallets ?? [];
        const matchingWallets = rawWallets
          .map((w) => SdkWalletSchema.safeParse(w))
          .filter(
            (r): r is { success: true; data: SdkWallet } =>
              r.success &&
              r.data.walletSetId === walletSetId &&
              r.data.refId === refId &&
              r.data.blockchain === ARC_HOSTED_CHAIN &&
              r.data.accountType === ARC_HOSTED_ACCOUNT_TYPE &&
              r.data.custodyType === ARC_HOSTED_CUSTODY_TYPE,
          )
          .map((r) => r.data);

        if (matchingWallets.length > 0) {
          return matchingWallets[0];
        }
      } catch {
        // ignore list error during reconciliation
      }

      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async provisionHostedUserWallet(input: {
    authUserId: string;
    repository: ArcHostedAccountRepository;
  }): Promise<{ walletAddress: string; status: "LIVE" }> {
    const job = await input.repository.claimProvisioningJob(input.authUserId);

    if (!job) {
      const existingAccount = await input.repository.getHostedAccount(input.authUserId);
      if (existingAccount && existingAccount.walletStatus === "LIVE" && existingAccount.walletAddress) {
        return {
          walletAddress: existingAccount.walletAddress,
          status: "LIVE",
        };
      }
      throw new Error("Unable to claim provisioning job");
    }

    try {
      const walletSet = await this.ensureWalletSetForTenant(job.tenantId, job.provisioningIdempotencyKey);
      const scaWallet = await this.ensureScaWalletForTenant(
        job.tenantId,
        walletSet.id,
        job.provisioningIdempotencyKey,
      );

      await input.repository.completeProvisioning({
        authUserId: job.authUserId,
        fencingToken: job.fencingToken,
        circleWalletSetId: walletSet.id,
        circleWalletId: scaWallet.id,
        walletAddress: scaWallet.address,
      });

      return {
        walletAddress: scaWallet.address,
        status: "LIVE",
      };
    } catch (err) {
      const formattedError = redactSecretsAndFormatError(err, this.config);
      if (!(err instanceof CircleReconciliationRequiredError)) {
        try {
          await input.repository.failProvisioning({
            authUserId: job.authUserId,
            fencingToken: job.fencingToken,
            errorCode: "PROVISIONING_FAILED",
          });
        } catch {
          // ignore repository failure
        }
      }
      throw formattedError;
    }
  }

  async getWalletBalances(walletId: string): Promise<Array<{ symbol: string; amount: string; address?: string }>> {
    try {
      const res = await this.sdkClient.getWalletTokenBalance({ id: walletId });
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

  async createDeveloperTransfer(input: {
    walletId: string;
    destinationAddress: string;
    amount: string;
    tokenId?: string;
    idempotencyKey: string;
  }): Promise<{ transactionId: string; state: string }> {
    if (!this.sdkClient.createTransaction) {
      throw new Error("Circle SDK createTransaction method unavailable");
    }

    try {
      const res = await this.sdkClient.createTransaction({
        walletId: input.walletId,
        destinationAddress: input.destinationAddress,
        amounts: [input.amount],
        tokenId: input.tokenId,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: input.idempotencyKey,
      });
      const parsed = SdkTransactionSchema.parse(res.data ?? {});
      return {
        transactionId: parsed.id,
        state: parsed.state,
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async executeDeveloperContract(input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    args: any[];
    idempotencyKey: string;
  }): Promise<{ transactionId: string; state: string }> {
    if (!this.sdkClient.createContractExecutionTransaction) {
      throw new Error("Circle SDK createContractExecutionTransaction method unavailable");
    }

    try {
      const res = await this.sdkClient.createContractExecutionTransaction({
        walletId: input.walletId,
        contractAddress: input.contractAddress,
        abiFunctionSignature: input.abiFunctionSignature,
        abiParameters: input.args,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: input.idempotencyKey,
      });
      const parsed = SdkTransactionSchema.parse(res.data ?? {});
      return {
        transactionId: parsed.id,
        state: parsed.state,
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async getTransactionStatus(transactionId: string): Promise<{ transactionId: string; state: string; txHash?: string; walletId?: string }> {
    if (!this.sdkClient.getTransaction) {
      throw new Error("Circle SDK getTransaction method unavailable");
    }

    try {
      const res = await this.sdkClient.getTransaction({ id: transactionId });
      const rawTx = res.data?.transaction ?? res.data;
      const parsed = SdkTransactionSchema.parse(rawTx);
      return {
        transactionId: parsed.id,
        state: parsed.state,
        txHash: parsed.txHash ?? undefined,
        walletId: parsed.walletId ?? undefined,
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  createAppKitAdapter(authority: ArcHostedAuthority): { authority: ArcHostedAuthority; isAppKitAdapter: true } {
    return {
      authority,
      isAppKitAdapter: true,
    };
  }
}
