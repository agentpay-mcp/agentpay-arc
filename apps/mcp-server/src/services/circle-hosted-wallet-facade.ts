import { z } from "zod";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcEvmAddressSchema,
  ArcHostedAuthority,
  ArcHostedAuthoritySchema,
  circleIdempotencyKeySchema,
  circlePositiveAmountSchema,
} from "@agentpay-ai/shared-arc";
import {
  CircleDeveloperWalletsAdapter,
  redactSecretsAndFormatError,
} from "./circle-developer-wallets.js";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";
import {
  createArcAppKitService,
  type ArcAppKitService,
} from "./arc-app-kit.js";

export const CircleHostedTransferInputSchema = z.object({
  toAddress: ArcEvmAddressSchema,
  amount: circlePositiveAmountSchema,
  idempotencyKey: circleIdempotencyKeySchema,
}).strict();
export type CircleHostedTransferInput = z.infer<typeof CircleHostedTransferInputSchema>;

export const CircleHostedContractExecutionInputSchema = z.object({
  contractAddress: ArcEvmAddressSchema,
  abiFunctionSignature: z.string().trim().min(1).max(256),
  args: z.array(z.unknown()).max(64).default([]),
  idempotencyKey: circleIdempotencyKeySchema,
}).strict();
export type CircleHostedContractExecutionInput = z.infer<typeof CircleHostedContractExecutionInputSchema>;

export interface CircleHostedWalletInfo {
  walletAddress: string;
  chain: typeof ARC_HOSTED_CHAIN;
  accountType: typeof ARC_HOSTED_ACCOUNT_TYPE;
  custodyType: typeof ARC_HOSTED_CUSTODY_TYPE;
  status: "LIVE";
}

export interface HostedToolCapability {
  toolName: string;
  hostedStatus: "SUPPORTED" | "DELEGATED_LOCAL_ONLY";
  description: string;
}

export const ALL_ARC_MCP_TOOL_NAMES = [
  "setup_agent_wallet",
  "get_agent_budget",
  "fund_agent_wallet",
  "withdraw_agent_budget",
  "send_usdc",
  "create_payment_request",
  "pay_invoice",
  "batch_payout",
  "list_agent_activity",
  "get_payment_receipt",
  "search_paid_services",
  "inspect_paid_service",
  "pay_paid_service",
  "get_unified_balance",
  "fund_from_any_chain",
  "bridge_usdc",
  "swap_tokens",
  "swap_and_pay",
  "register_agent_identity",
  "get_agent_identity",
  "give_agent_feedback",
  "request_agent_validation",
  "respond_agent_validation",
  "get_agent_trust",
  "create_agent_job",
  "set_agent_job_budget",
  "fund_agent_job",
  "submit_agent_deliverable",
  "complete_agent_job",
  "reject_agent_job",
  "get_agent_job",
] as const;

type ArcMcpToolName = (typeof ALL_ARC_MCP_TOOL_NAMES)[number];

const HOSTED_TOOL_DESCRIPTIONS: Readonly<
  Partial<Record<ArcMcpToolName, string>>
> = Object.freeze({
  setup_agent_wallet:
    "Provisions and reports the authenticated tenant's Developer-Controlled Arc SCA wallet.",
  get_agent_budget:
    "Reads balances only from the authenticated tenant's private wallet binding.",
  send_usdc:
    "Transfers canonical Arc Testnet USDC from the authenticated tenant wallet.",
  get_payment_receipt:
    "Reads a transaction only when Circle reports the authenticated tenant wallet ID.",
  get_unified_balance:
    "Reads App Kit unified balances only for the authenticated tenant wallet address.",
});

export const ARC_HOSTED_TOOL_CAPABILITY_MATRIX: readonly HostedToolCapability[] =
  Object.freeze(
    ALL_ARC_MCP_TOOL_NAMES.map((toolName): HostedToolCapability =>
      Object.freeze({
        toolName,
        hostedStatus: HOSTED_TOOL_DESCRIPTIONS[toolName]
          ? "SUPPORTED"
          : "DELEGATED_LOCAL_ONLY",
        description:
          HOSTED_TOOL_DESCRIPTIONS[toolName]
          ?? "Not implemented by the hosted Developer-Controlled wallet facade; remains on the isolated local Arc runtime.",
      })),
  );

export class CircleHostedWalletFacade {
  private readonly adapter: CircleDeveloperWalletsAdapter;
  private readonly repository: ArcHostedAccountRepository;
  private readonly appKitServiceFactory: () => ArcAppKitService;

  constructor(
    adapter: CircleDeveloperWalletsAdapter,
    repository: ArcHostedAccountRepository,
    appKitServiceFactory: () => ArcAppKitService = createArcAppKitService,
  ) {
    this.adapter = adapter;
    this.repository = repository;
    this.appKitServiceFactory = appKitServiceFactory;
  }

  private async validateAndResolvePrivateWalletId(authority: ArcHostedAuthority): Promise<{ circleWalletId: string; walletAddress: string }> {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error("Hosted authority account status must be ACTIVE");
    }

    const binding = await this.repository.getPrivateWalletBinding(validAuth.authUserId);
    if (!binding || binding.tenantId !== validAuth.tenantId) {
      throw new Error("Cross-tenant or missing private wallet binding");
    }

    if (binding.provisioningState !== "LIVE") {
      throw new Error("Hosted wallet is not in LIVE provisioning state");
    }

    if (!binding.circleWalletId || !binding.walletAddress) {
      throw new Error("Hosted wallet not fully provisioned");
    }

    if (binding.walletAddress.toLowerCase() !== validAuth.walletAddress.toLowerCase()) {
      throw new Error("Wallet address mismatch between authority and private binding");
    }

    return {
      circleWalletId: binding.circleWalletId,
      walletAddress: binding.walletAddress,
    };
  }

  async getWallet(authority: ArcHostedAuthority): Promise<CircleHostedWalletInfo> {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error("Hosted authority account status must be ACTIVE");
    }

    await this.validateAndResolvePrivateWalletId(authority);

    return {
      walletAddress: validAuth.walletAddress,
      chain: ARC_HOSTED_CHAIN,
      accountType: ARC_HOSTED_ACCOUNT_TYPE,
      custodyType: ARC_HOSTED_CUSTODY_TYPE,
      status: "LIVE",
    };
  }

  async getBalances(
    authority: ArcHostedAuthority,
  ): Promise<Array<{ symbol: string; amount: string; address?: string }>> {
    const { circleWalletId } = await this.validateAndResolvePrivateWalletId(authority);
    return this.adapter.getWalletBalances(circleWalletId);
  }

  async transferTokens(
    authority: ArcHostedAuthority,
    input: CircleHostedTransferInput,
  ): Promise<{ transactionId: string; state: string }> {
    const { walletAddress } = await this.validateAndResolvePrivateWalletId(authority);
    const validParams = CircleHostedTransferInputSchema.parse(input);

    try {
      return await this.adapter.createDeveloperTransfer({
        walletAddress,
        destinationAddress: validParams.toAddress,
        amount: validParams.amount,
        idempotencyKey: validParams.idempotencyKey,
      });
    } catch (err) {
      throw redactSecretsAndFormatError(err);
    }
  }

  async executeContract(
    authority: ArcHostedAuthority,
    input: CircleHostedContractExecutionInput,
  ): Promise<{ transactionId: string; state: string }> {
    const { circleWalletId } = await this.validateAndResolvePrivateWalletId(authority);
    const validParams = CircleHostedContractExecutionInputSchema.parse(input);

    try {
      return await this.adapter.executeDeveloperContract({
        walletId: circleWalletId,
        contractAddress: validParams.contractAddress,
        abiFunctionSignature: validParams.abiFunctionSignature,
        args: validParams.args,
        idempotencyKey: validParams.idempotencyKey,
      });
    } catch (err) {
      throw redactSecretsAndFormatError(err);
    }
  }

  async getTransactionStatus(
    authority: ArcHostedAuthority,
    transactionId: string,
  ): Promise<{ transactionId: string; state: string; txHash?: string }> {
    const { circleWalletId } = await this.validateAndResolvePrivateWalletId(authority);
    if (
      !transactionId
      || typeof transactionId !== "string"
      || transactionId.trim().length === 0
      || transactionId.length > 256
    ) {
      throw new Error("Invalid transactionId");
    }

    const txStatus = await this.adapter.getTransactionStatus(transactionId);
    if (!txStatus.walletId || txStatus.walletId !== circleWalletId) {
      throw new Error("Access denied: transaction does not belong to caller tenant wallet");
    }

    return {
      transactionId: txStatus.transactionId,
      state: txStatus.state,
      txHash: txStatus.txHash,
    };
  }

  async createAppKitAdapter(authority: ArcHostedAuthority): Promise<ArcAppKitService> {
    const { walletAddress } = await this.validateAndResolvePrivateWalletId(authority);
    const baseService = this.appKitServiceFactory();
    const boundAddressLower = walletAddress.toLowerCase();

    const tenantBoundService: ArcAppKitService = {
      ...baseService,
      async getUnifiedBalances(rawAddress, includePending) {
        if (!rawAddress || rawAddress.toLowerCase() !== boundAddressLower) {
          throw new Error("Access denied: address does not match tenant-bound wallet address");
        }
        return baseService.getUnifiedBalances(walletAddress, includePending);
      },
      async estimateBridge(params) {
        if (params.sourceAddress.toLowerCase() !== boundAddressLower) {
          throw new Error("Access denied: sourceAddress does not match tenant-bound wallet address");
        }
        return baseService.estimateBridge({
          ...params,
          sourceAddress: walletAddress,
        });
      },
      async estimateSwap(params) {
        if (params.walletAddress.toLowerCase() !== boundAddressLower) {
          throw new Error("Access denied: walletAddress does not match tenant-bound wallet address");
        }
        return baseService.estimateSwap({
          ...params,
          walletAddress,
        });
      },
    };
    return tenantBoundService;
  }

  getCapabilityMatrix(): readonly HostedToolCapability[] {
    return ARC_HOSTED_TOOL_CAPABILITY_MATRIX;
  }
}
