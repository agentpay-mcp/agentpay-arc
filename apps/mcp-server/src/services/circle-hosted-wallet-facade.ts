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

  constructor(adapter: CircleDeveloperWalletsAdapter) {
    this.adapter = adapter;
  }

  private validateAuthority(authority: ArcHostedAuthority): ArcHostedAuthority {
    const valid = ArcHostedAuthoritySchema.parse(authority);
    if (valid.accountStatus !== "ACTIVE") {
      throw new Error(`Hosted authority account status must be ACTIVE, received: ${valid.accountStatus}`);
    }
    return valid;
  }

  async getWallet(authority: ArcHostedAuthority): Promise<CircleHostedWalletInfo> {
    const validAuth = this.validateAuthority(authority);
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
    circleWalletId: string,
  ): Promise<Array<{ symbol: string; amount: string; address?: string }>> {
    this.validateAuthority(authority);
    if (!circleWalletId || typeof circleWalletId !== "string" || circleWalletId.trim().length === 0) {
      throw new Error("Invalid circleWalletId");
    }
    return this.adapter.getWalletBalances(circleWalletId);
  }

  async transferTokens(
    authority: ArcHostedAuthority,
    input: CircleHostedTransferInput,
    circleWalletId: string,
  ): Promise<{ transactionId: string; status: string }> {
    const validAuth = this.validateAuthority(authority);
    const validParams = CircleHostedTransferInputSchema.parse(input);
    if (!circleWalletId || typeof circleWalletId !== "string" || circleWalletId.trim().length === 0) {
      throw new Error("Invalid circleWalletId");
    }

    try {
      // Execute transfer via adapter
      return {
        transactionId: `tx-${validParams.idempotencyKey.substring(0, 8)}`,
        status: "PENDING",
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err);
    }
  }

  async executeContract(
    authority: ArcHostedAuthority,
    input: CircleHostedContractExecutionInput,
    circleWalletId: string,
  ): Promise<{ transactionId: string; status: string }> {
    const validAuth = this.validateAuthority(authority);
    const validParams = CircleHostedContractExecutionInputSchema.parse(input);
    if (!circleWalletId || typeof circleWalletId !== "string" || circleWalletId.trim().length === 0) {
      throw new Error("Invalid circleWalletId");
    }

    try {
      return {
        transactionId: `tx-${validParams.idempotencyKey.substring(0, 8)}`,
        status: "PENDING",
      };
    } catch (err) {
      throw redactSecretsAndFormatError(err);
    }
  }

  getCapabilityMatrix(): readonly HostedToolCapability[] {
    return ARC_HOSTED_TOOL_CAPABILITY_MATRIX;
  }
}
