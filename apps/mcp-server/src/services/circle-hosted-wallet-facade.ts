import { z } from "zod";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcEvmAddressSchema,
  ArcHostedAuthority,
  ArcHostedAuthoritySchema,
  circleAmountSchema,
  circleIdempotencyKeySchema,
} from "@agentpay-ai/shared-arc";
import {
  CircleDeveloperWalletsAdapter,
  redactSecretsAndFormatError,
} from "./circle-developer-wallets.js";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";

export const CircleHostedTransferInputSchema = z.object({
  toAddress: ArcEvmAddressSchema,
  amount: circleAmountSchema,
  tokenId: z.string().trim().optional(),
  idempotencyKey: circleIdempotencyKeySchema,
});
export type CircleHostedTransferInput = z.infer<typeof CircleHostedTransferInputSchema>;

export const CircleHostedContractExecutionInputSchema = z.object({
  contractAddress: ArcEvmAddressSchema,
  abiFunctionSignature: z.string().trim().min(1),
  args: z.array(z.any()).default([]),
  idempotencyKey: circleIdempotencyKeySchema,
});
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

export const ARC_HOSTED_TOOL_CAPABILITY_MATRIX: readonly HostedToolCapability[] = [
  {
    toolName: "get_balance",
    hostedStatus: "SUPPORTED",
    description: "Reads stablecoin and token balances bound to the user's hosted authority wallet address.",
  },
  {
    toolName: "prepare_payment",
    hostedStatus: "SUPPORTED",
    description: "Prepares payment intents bound to the hosted authority.",
  },
  {
    toolName: "execute_payment",
    hostedStatus: "SUPPORTED",
    description: "Executes approved payments via the hosted Developer-Controlled SCA wallet.",
  },
  {
    toolName: "quote_payment_route",
    hostedStatus: "SUPPORTED",
    description: "Quotes payment routes for the hosted authority wallet.",
  },
  {
    toolName: "wallet_setup",
    hostedStatus: "SUPPORTED",
    description: "Verifies and manages hosted user wallet setup and status.",
  },
  {
    toolName: "route_target_allowance",
    hostedStatus: "SUPPORTED",
    description: "Checks and prepares route target allowances for the hosted wallet.",
  },
  {
    toolName: "x402_bazaar_search",
    hostedStatus: "SUPPORTED",
    description: "Searches x402 Bazaar services in hosted mode.",
  },
  {
    toolName: "x402_bazaar_prepare",
    hostedStatus: "SUPPORTED",
    description: "Prepares x402 Bazaar service requests for hosted authority.",
  },
  {
    toolName: "account_admin",
    hostedStatus: "SUPPORTED",
    description: "Manages hosted account state and consent.",
  },
  {
    toolName: "circle_agent_wallet",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Local Circle CLI session management. Delegated to local CLI runtime only; not used in hosted server mode.",
  },
] as const;

export class CircleHostedWalletFacade {
  private readonly adapter: CircleDeveloperWalletsAdapter;
  private readonly repository: ArcHostedAccountRepository;

  constructor(adapter: CircleDeveloperWalletsAdapter, repository: ArcHostedAccountRepository) {
    this.adapter = adapter;
    this.repository = repository;
  }

  private async validateAndResolvePrivateWalletId(authority: ArcHostedAuthority): Promise<string> {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error(`Hosted authority account status must be ACTIVE, received: ${validAuth.accountStatus}`);
    }

    const binding = await this.repository.getPrivateWalletBinding(validAuth.authUserId);
    if (!binding || binding.tenantId !== validAuth.tenantId) {
      throw new Error(`Cross-tenant or missing private wallet binding for authUserId ${validAuth.authUserId}`);
    }

    if (!binding.circleWalletId) {
      throw new Error(`Hosted wallet not fully provisioned for authUserId ${validAuth.authUserId}`);
    }

    if (binding.walletAddress && binding.walletAddress.toLowerCase() !== validAuth.walletAddress.toLowerCase()) {
      throw new Error("Wallet address mismatch between authority and private binding");
    }

    return binding.circleWalletId;
  }

  async getWallet(authority: ArcHostedAuthority): Promise<CircleHostedWalletInfo> {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error(`Hosted authority account status must be ACTIVE, received: ${validAuth.accountStatus}`);
    }
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
    const circleWalletId = await this.validateAndResolvePrivateWalletId(authority);
    return this.adapter.getWalletBalances(circleWalletId);
  }

  async transferTokens(
    authority: ArcHostedAuthority,
    input: CircleHostedTransferInput,
  ): Promise<{ transactionId: string; state: string }> {
    const circleWalletId = await this.validateAndResolvePrivateWalletId(authority);
    const validParams = CircleHostedTransferInputSchema.parse(input);

    try {
      return await this.adapter.createDeveloperTransfer({
        walletId: circleWalletId,
        destinationAddress: validParams.toAddress,
        amount: validParams.amount,
        tokenId: validParams.tokenId,
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
    const circleWalletId = await this.validateAndResolvePrivateWalletId(authority);
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
    await this.validateAndResolvePrivateWalletId(authority);
    if (!transactionId || typeof transactionId !== "string" || transactionId.trim().length === 0) {
      throw new Error("Invalid transactionId");
    }
    return this.adapter.getTransactionStatus(transactionId);
  }

  createAppKitAdapter(authority: ArcHostedAuthority) {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error(`Hosted authority account status must be ACTIVE, received: ${validAuth.accountStatus}`);
    }
    return this.adapter.createAppKitAdapter(validAuth);
  }

  getCapabilityMatrix(): readonly HostedToolCapability[] {
    return ARC_HOSTED_TOOL_CAPABILITY_MATRIX;
  }
}
