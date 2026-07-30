import { z } from "zod";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcEvmAddressSchema,
} from "@agentpay-ai/shared-arc";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";

export const ARC_HOSTED_USDC_TOKEN_ADDRESS = "0x3600000000000000000000000000000000000000";
const CIRCLE_PAGE_SIZE = 50;
const CIRCLE_MAX_PAGES = 20;
const CIRCLE_MAX_RECORDS = CIRCLE_PAGE_SIZE * CIRCLE_MAX_PAGES;
const CIRCLE_MAX_BALANCES = 256;

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
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(128),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE),
});
export type SdkWalletSet = z.infer<typeof SdkWalletSetSchema>;

export const SdkWalletSchema = z.object({
  id: z.string().trim().min(1).max(256),
  walletSetId: z.string().trim().min(1).max(256),
  address: ArcEvmAddressSchema,
  blockchain: z.literal(ARC_HOSTED_CHAIN),
  accountType: z.literal(ARC_HOSTED_ACCOUNT_TYPE),
  custodyType: z.literal(ARC_HOSTED_CUSTODY_TYPE),
  refId: z.string().trim().min(1).max(128).optional().nullable(),
});
export type SdkWallet = z.infer<typeof SdkWalletSchema>;

export const SdkTokenBalanceSchema = z.object({
  token: z.object({
    id: z.string().trim().min(1).max(256).optional(),
    symbol: z.string().trim().min(1).max(64).optional(),
    decimals: z.number().optional(),
    tokenAddress: ArcEvmAddressSchema.optional(),
  }),
  amount: z.string().trim().min(1).max(128),
});

export const SdkBalancesResponseSchema = z.object({
  tokenBalances: z.array(SdkTokenBalanceSchema).max(CIRCLE_MAX_BALANCES).default([]),
});

export const SdkTransactionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  state: z.string().trim().min(1).max(64),
  txHash: z.string().trim().min(1).max(256).optional().nullable(),
  walletId: z.string().trim().min(1).max(256).optional().nullable(),
});
export type SdkTransaction = z.infer<typeof SdkTransactionSchema>;

type CircleDeveloperSdkMethodName =
  | "listWalletSets"
  | "createWalletSet"
  | "listWallets"
  | "createWallets"
  | "getWalletTokenBalance"
  | "createTransaction"
  | "createContractExecutionTransaction"
  | "getTransaction";

type CircleDeveloperSdkMethod<
  TMethodName extends CircleDeveloperSdkMethodName,
> = CircleDeveloperControlledWalletsClient[TMethodName] extends (
  ...args: infer TArgs
) => Promise<unknown>
  ? (...args: TArgs) => Promise<{ readonly data?: unknown }>
  : never;

export type CircleDeveloperSdkClient = {
  readonly [TMethodName in CircleDeveloperSdkMethodName]:
    CircleDeveloperSdkMethod<TMethodName>;
};

type AssertTrue<TValue extends true> = TValue;
export type CircleOfficialSdkCompatibility = AssertTrue<
  CircleDeveloperControlledWalletsClient extends CircleDeveloperSdkClient
    ? true
    : false
>;

const WalletSetPageEnvelopeSchema = z.object({
  walletSets: z.array(SdkWalletSetSchema).max(CIRCLE_PAGE_SIZE),
}).strict();

const WalletPageEnvelopeSchema = z.object({
  wallets: z.array(SdkWalletSchema).max(CIRCLE_PAGE_SIZE),
}).strict();

const CreatedWalletSetEnvelopeSchema = z.object({
  walletSet: SdkWalletSetSchema,
}).strict();

const CreatedWalletsEnvelopeSchema = z.object({
  wallets: z.array(SdkWalletSchema).min(1).max(1),
}).strict();

const TransactionEnvelopeSchema = z.object({
  transaction: SdkTransactionSchema,
}).strict();

const CIRCLE_SDK_METHOD_NAMES: readonly CircleDeveloperSdkMethodName[] = [
  "listWalletSets",
  "createWalletSet",
  "listWallets",
  "createWallets",
  "getWalletTokenBalance",
  "createTransaction",
  "createContractExecutionTransaction",
  "getTransaction",
] as const;

export function deriveWalletSetName(tenantId: string): string {
  const hash = createHash("sha256").update(`tenant-ws:${tenantId}`).digest("hex").substring(0, 16);
  return `arc-ws-${hash}`;
}

export function deriveWalletRefId(tenantId: string): string {
  const hash = createHash("sha256").update(`tenant-ref:${tenantId}`).digest("hex").substring(0, 16);
  return `arc-ref-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCircleDeveloperSdkClient(
  value: unknown,
): value is CircleDeveloperSdkClient {
  return isRecord(value)
    && CIRCLE_SDK_METHOD_NAMES.every(
      (methodName) => typeof value[methodName] === "function",
    );
}

function createProductionSdkClient(
  config: CircleDeveloperWalletsConfig,
): CircleDeveloperSdkClient {
  const require = createRequire(import.meta.url);
  const sdkModule: unknown = require("@circle-fin/developer-controlled-wallets");
  if (
    !isRecord(sdkModule)
    || typeof sdkModule.initiateDeveloperControlledWalletsClient !== "function"
  ) {
    throw new Error("Circle SDK factory is unavailable");
  }

  const client: unknown = sdkModule.initiateDeveloperControlledWalletsClient({
    apiKey: config.apiKey,
    entitySecret: config.entitySecret,
  });
  if (!isCircleDeveloperSdkClient(client)) {
    throw new Error("Circle SDK client surface is incompatible");
  }
  return client;
}

function hasOversizedCollection(
  data: unknown,
  property: "walletSets" | "wallets",
): boolean {
  return isRecord(data)
    && Array.isArray(data[property])
    && data[property].length > CIRCLE_PAGE_SIZE;
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
      this.sdkClient = createProductionSdkClient(this.config);
    }
  }

  private async fetchAllWalletSets(): Promise<SdkWalletSet[]> {
    const allSets: SdkWalletSet[] = [];
    const seenCursors = new Set<string>();
    let pageAfter: string | undefined = undefined;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore) {
      pageCount++;
      if (pageCount > CIRCLE_MAX_PAGES) {
        throw new CircleReconciliationRequiredError("Pagination max page depth exceeded; state inconclusive");
      }

      if (pageAfter) {
        if (seenCursors.has(pageAfter)) {
          throw new CircleReconciliationRequiredError("Pagination cursor loop detected; state inconclusive");
        }
        seenCursors.add(pageAfter);
      }

      const res = await this.sdkClient.listWalletSets(
        pageAfter
          ? { pageAfter, pageSize: CIRCLE_PAGE_SIZE }
          : { pageSize: CIRCLE_PAGE_SIZE },
      );
      if (hasOversizedCollection(res.data, "walletSets")) {
        throw new CircleReconciliationRequiredError("Circle API returned page size exceeding maximum bound");
      }
      const envelope = WalletSetPageEnvelopeSchema.safeParse(res.data);
      if (!envelope.success) {
        throw new CircleReconciliationRequiredError(
          "Circle API returned malformed or unverified wallet-set envelope",
        );
      }

      const pageSets = envelope.data.walletSets;
      allSets.push(...pageSets);
      if (allSets.length > CIRCLE_MAX_RECORDS) {
        throw new CircleReconciliationRequiredError(
          "Pagination max record count exceeded; state inconclusive",
        );
      }

      if (pageSets.length < CIRCLE_PAGE_SIZE) {
        hasMore = false;
      } else {
        pageAfter = pageSets[pageSets.length - 1]?.id;
        if (!pageAfter) {
          throw new CircleReconciliationRequiredError(
            "Pagination cursor missing from a full wallet-set page",
          );
        }
      }
    }
    return allSets;
  }

  private async fetchAllWallets(walletSetId: string): Promise<SdkWallet[]> {
    const allWallets: SdkWallet[] = [];
    const seenCursors = new Set<string>();
    let pageAfter: string | undefined = undefined;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore) {
      pageCount++;
      if (pageCount > CIRCLE_MAX_PAGES) {
        throw new CircleReconciliationRequiredError("Pagination max page depth exceeded; state inconclusive");
      }

      if (pageAfter) {
        if (seenCursors.has(pageAfter)) {
          throw new CircleReconciliationRequiredError("Pagination cursor loop detected; state inconclusive");
        }
        seenCursors.add(pageAfter);
      }

      const res = await this.sdkClient.listWallets(
        pageAfter
          ? { walletSetId, pageAfter, pageSize: CIRCLE_PAGE_SIZE }
          : { walletSetId, pageSize: CIRCLE_PAGE_SIZE },
      );
      if (hasOversizedCollection(res.data, "wallets")) {
        throw new CircleReconciliationRequiredError("Circle API returned page size exceeding maximum bound");
      }
      const envelope = WalletPageEnvelopeSchema.safeParse(res.data);
      if (!envelope.success) {
        throw new CircleReconciliationRequiredError(
          "Circle API returned malformed or unverified wallet envelope",
        );
      }

      const pageWallets = envelope.data.wallets;
      allWallets.push(...pageWallets);
      if (allWallets.length > CIRCLE_MAX_RECORDS) {
        throw new CircleReconciliationRequiredError(
          "Pagination max record count exceeded; state inconclusive",
        );
      }

      if (pageWallets.length < CIRCLE_PAGE_SIZE) {
        hasMore = false;
      } else {
        pageAfter = pageWallets[pageWallets.length - 1]?.id;
        if (!pageAfter) {
          throw new CircleReconciliationRequiredError(
            "Pagination cursor missing from a full wallet page",
          );
        }
      }
    }
    return allWallets;
  }

  async ensureWalletSetForTenant(tenantId: string, idempotencyKey: string): Promise<SdkWalletSet> {
    const walletSetName = deriveWalletSetName(tenantId);
    let preflightSucceeded = false;

    try {
      const walletSets = await this.fetchAllWalletSets();
      preflightSucceeded = true;
      const matchingSets = walletSets.filter(
        (s) => s.name === walletSetName && s.custodyType === ARC_HOSTED_CUSTODY_TYPE,
      );

      if (matchingSets.length > 1) {
        throw new CircleReconciliationRequiredError("Multiple wallet sets found matching tenant ID; state inconclusive");
      }

      if (matchingSets.length === 1) {
        return matchingSets[0];
      }
    } catch (err) {
      if (err instanceof CircleReconciliationRequiredError) {
        throw err;
      }
      preflightSucceeded = false;
    }

    if (!preflightSucceeded) {
      throw new CircleReconciliationRequiredError("Preflight listWalletSets failed; state inconclusive");
    }

    try {
      const createRes = await this.sdkClient.createWalletSet({
        name: walletSetName,
        idempotencyKey,
      });
      const parsedEnvelope = CreatedWalletSetEnvelopeSchema.safeParse(createRes.data);
      if (
        !parsedEnvelope.success
        || parsedEnvelope.data.walletSet.name !== walletSetName
        || parsedEnvelope.data.walletSet.custodyType !== ARC_HOSTED_CUSTODY_TYPE
      ) {
        throw new Error("Created wallet set does not match required properties");
      }
      return parsedEnvelope.data.walletSet;
    } catch {
      try {
        const walletSets = await this.fetchAllWalletSets();
        const matchingSets = walletSets.filter(
          (s) => s.name === walletSetName && s.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        );
        if (matchingSets.length > 1) {
          throw new CircleReconciliationRequiredError("Multiple wallet sets found matching tenant ID during reconciliation");
        }
        if (matchingSets.length === 1) {
          return matchingSets[0];
        }
      } catch (err) {
        if (err instanceof CircleReconciliationRequiredError) {
          throw err;
        }
      }
      throw new CircleReconciliationRequiredError("Wallet set creation outcome ambiguous; reconciliation required");
    }
  }

  async ensureScaWalletForTenant(
    tenantId: string,
    walletSetId: string,
    idempotencyKey: string,
  ): Promise<SdkWallet> {
    const refId = deriveWalletRefId(tenantId);
    let preflightSucceeded = false;

    try {
      const wallets = await this.fetchAllWallets(walletSetId);
      preflightSucceeded = true;
      const matchingWallets = wallets.filter(
        (w) =>
          w.walletSetId === walletSetId &&
          w.refId === refId &&
          w.blockchain === ARC_HOSTED_CHAIN &&
          w.accountType === ARC_HOSTED_ACCOUNT_TYPE &&
          w.custodyType === ARC_HOSTED_CUSTODY_TYPE,
      );

      if (matchingWallets.length > 1) {
        throw new CircleReconciliationRequiredError("Multiple wallets found matching tenant refId; state inconclusive");
      }

      if (matchingWallets.length === 1) {
        return matchingWallets[0];
      }
    } catch (err) {
      if (err instanceof CircleReconciliationRequiredError) {
        throw err;
      }
      preflightSucceeded = false;
    }

    if (!preflightSucceeded) {
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

      const parsedEnvelope = CreatedWalletsEnvelopeSchema.safeParse(createRes.data);
      const validWallet = parsedEnvelope.success
        ? parsedEnvelope.data.wallets.find(
          (wallet) =>
            wallet.walletSetId === walletSetId
            && wallet.refId === refId
            && wallet.blockchain === ARC_HOSTED_CHAIN
            && wallet.accountType === ARC_HOSTED_ACCOUNT_TYPE
            && wallet.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        )
        : undefined;

      if (!validWallet) {
        throw new Error("Created wallet does not match required DEVELOPER SCA properties");
      }

      return validWallet;
    } catch {
      try {
        const wallets = await this.fetchAllWallets(walletSetId);
        const matchingWallets = wallets.filter(
          (w) =>
            w.walletSetId === walletSetId &&
            w.refId === refId &&
            w.blockchain === ARC_HOSTED_CHAIN &&
            w.accountType === ARC_HOSTED_ACCOUNT_TYPE &&
            w.custodyType === ARC_HOSTED_CUSTODY_TYPE,
        );

        if (matchingWallets.length > 1) {
          throw new CircleReconciliationRequiredError("Multiple wallets found matching tenant refId during reconciliation");
        }

        if (matchingWallets.length === 1) {
          return matchingWallets[0];
        }
      } catch (err) {
        if (err instanceof CircleReconciliationRequiredError) {
          throw err;
        }
      }

      throw new CircleReconciliationRequiredError("SCA wallet creation outcome ambiguous; reconciliation required");
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
      if (err instanceof CircleReconciliationRequiredError) {
        throw err;
      }
      try {
        await input.repository.failProvisioning({
          authUserId: job.authUserId,
          fencingToken: job.fencingToken,
          errorCode: "PROVISIONING_FAILED",
        });
      } catch {
        // ignore repository failure
      }
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async getWalletBalances(walletId: string): Promise<Array<{ symbol: string; amount: string; address?: string }>> {
    try {
      const res = await this.sdkClient.getWalletTokenBalance({ id: walletId });
      const parsed = SdkBalancesResponseSchema.parse(res.data);
      return parsed.tokenBalances.map((tb) => ({
        symbol: tb.token.symbol ?? "USDC",
        amount: tb.amount,
        address: tb.token.tokenAddress,
      }));
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async createDeveloperTransfer(input: {
    walletAddress: string;
    destinationAddress: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<{ transactionId: string; state: string }> {
    try {
      const res = await this.sdkClient.createTransaction({
        walletAddress: input.walletAddress,
        destinationAddress: input.destinationAddress,
        amount: [input.amount],
        tokenAddress: ARC_HOSTED_USDC_TOKEN_ADDRESS,
        blockchain: ARC_HOSTED_CHAIN,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: input.idempotencyKey,
      });
      const parsed = SdkTransactionSchema.parse(res.data);
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
    args: readonly unknown[];
    idempotencyKey: string;
  }): Promise<{ transactionId: string; state: string }> {
    try {
      const res = await this.sdkClient.createContractExecutionTransaction({
        walletId: input.walletId,
        contractAddress: input.contractAddress,
        abiFunctionSignature: input.abiFunctionSignature,
        abiParameters: [...input.args],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: input.idempotencyKey,
      });
      const parsed = SdkTransactionSchema.parse(res.data);
      return {
        transactionId: parsed.id,
        state: parsed.state,
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err, this.config);
    }
  }

  async getTransactionStatus(transactionId: string): Promise<{ transactionId: string; state: string; txHash?: string; walletId?: string }> {
    try {
      const res = await this.sdkClient.getTransaction({ id: transactionId });
      const parsed = TransactionEnvelopeSchema.parse(res.data).transaction;
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
}
