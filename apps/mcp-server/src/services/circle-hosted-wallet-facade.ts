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
    toolName: "execute_payment",
    hostedStatus: "SUPPORTED",
    description: "Executes approved payments via the hosted Developer-Controlled SCA wallet.",
  },
  {
    toolName: "wallet_setup",
    hostedStatus: "SUPPORTED",
    description: "Verifies and manages hosted user wallet setup and status.",
  },
  {
    toolName: "prepare_payment",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Prepares payment intents locally. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "quote_payment_route",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Quotes payment routes locally. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "route_target_allowance",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Route target allowance management. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "x402_bazaar_search",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "x402 Bazaar search. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "x402_bazaar_prepare",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "x402 Bazaar request preparation. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "account_admin",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Local account administration. Delegated to local CLI runtime only; not supported in hosted server mode.",
  },
  {
    toolName: "circle_agent_wallet",
    hostedStatus: "DELEGATED_LOCAL_ONLY",
    description: "Local Circle CLI session management. Delegated to local CLI runtime only; not used in hosted server mode.",
  },
] as const;

export interface CircleAppKitHostedAdapter {
  authority: ArcHostedAuthority;
  getWallet(): Promise<CircleHostedWalletInfo>;
  getBalances(): Promise<Array<{ symbol: string; amount: string; address?: string }>>;
  transferTokens(input: CircleHostedTransferInput): Promise<{ transactionId: string; state: string }>;
  executeContract(input: CircleHostedContractExecutionInput): Promise<{ transactionId: string; state: string }>;
  getTransactionStatus(transactionId: string): Promise<{ transactionId: string; state: string; txHash?: string }>;
}

export class CircleHostedWalletFacade {
  private readonly adapter: CircleDeveloperWalletsAdapter;
  private readonly repository: ArcHostedAccountRepository;

  constructor(adapter: CircleDeveloperWalletsAdapter, repository: ArcHostedAccountRepository) {
    this.adapter = adapter;
    this.repository = repository;
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

    if (!binding.circleWalletId) {
      throw new Error("Hosted wallet not fully provisioned");
    }

    if (binding.walletAddress && binding.walletAddress.toLowerCase() !== validAuth.walletAddress.toLowerCase()) {
      throw new Error("Wallet address mismatch between authority and private binding");
    }

    return { circleWalletId: binding.circleWalletId, walletAddress: validAuth.walletAddress };
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
    const { circleWalletId } = await this.validateAndResolvePrivateWalletId(authority);
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
    if (!transactionId || typeof transactionId !== "string" || transactionId.trim().length === 0) {
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

  createAppKitAdapter(authority: ArcHostedAuthority): CircleAppKitHostedAdapter {
    const validAuth = ArcHostedAuthoritySchema.parse(authority);
    if (validAuth.accountStatus !== "ACTIVE") {
      throw new Error("Hosted authority account status must be ACTIVE");
    }
    const facadeInstance = this;
    return {
      authority: validAuth,
      getWallet: () => facadeInstance.getWallet(validAuth),
      getBalances: () => facadeInstance.getBalances(validAuth),
      transferTokens: (input) => facadeInstance.transferTokens(validAuth, input),
      executeContract: (input) => facadeInstance.executeContract(validAuth, input),
      getTransactionStatus: (txId) => facadeInstance.getTransactionStatus(validAuth, txId),
    };
  }

  getCapabilityMatrix(): readonly HostedToolCapability[] {
    return ARC_HOSTED_TOOL_CAPABILITY_MATRIX;
  }
}
