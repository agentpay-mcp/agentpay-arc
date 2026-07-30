import { z } from "zod";
import {
  ARC_HOSTED_CHAIN,
  ArcEvmAddressSchema,
  ArcHostedAuthoritySchema,
  arcUsdcAmountSchema,
  uuidV4Schema,
  type ArcHostedAuthority,
} from "@agentpay-ai/shared-arc";

import type { ArcAppKitService } from "../services/arc-app-kit.js";
import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.js";
import type {
  CircleHostedTransferInput,
  CircleHostedWalletInfo,
} from "../services/circle-hosted-wallet-facade.js";

const walletSelectionInputSchema = z
  .object({
    walletAddress: ArcEvmAddressSchema.optional(),
  })
  .strict();

const sendUsdcInputSchema = walletSelectionInputSchema
  .extend({
    recipient: ArcEvmAddressSchema,
    amount: arcUsdcAmountSchema,
    idempotencyKey: uuidV4Schema,
  })
  .strict();

const getPaymentReceiptInputSchema = walletSelectionInputSchema
  .extend({
    transactionId: z.string().trim().min(1).max(256),
  })
  .strict();

const getUnifiedBalanceInputSchema = walletSelectionInputSchema
  .extend({
    includePending: z.boolean().default(true),
  })
  .strict();

export const HOSTED_ARC_TOOL_NAMES = Object.freeze([
  "setup_agent_wallet",
  "get_agent_budget",
  "send_usdc",
  "get_payment_receipt",
  "get_unified_balance",
] as const);

export type HostedArcToolName = (typeof HOSTED_ARC_TOOL_NAMES)[number];

export interface HostedArcToolDescriptor {
  readonly name: HostedArcToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export const HOSTED_ARC_TOOL_REGISTRY = Object.freeze({
  setup_agent_wallet: Object.freeze({
    name: "setup_agent_wallet",
    description:
      "Read the authenticated tenant's already-provisioned hosted Arc wallet.",
    inputSchema: walletSelectionInputSchema,
  }),
  get_agent_budget: Object.freeze({
    name: "get_agent_budget",
    description:
      "Read balances for the authenticated tenant's hosted Arc wallet.",
    inputSchema: walletSelectionInputSchema,
  }),
  send_usdc: Object.freeze({
    name: "send_usdc",
    description:
      "Send canonical Arc Testnet USDC from the authenticated tenant's hosted wallet.",
    inputSchema: sendUsdcInputSchema,
  }),
  get_payment_receipt: Object.freeze({
    name: "get_payment_receipt",
    description:
      "Read Circle transaction status for the authenticated tenant's hosted wallet.",
    inputSchema: getPaymentReceiptInputSchema,
  }),
  get_unified_balance: Object.freeze({
    name: "get_unified_balance",
    description:
      "Read App Kit unified USDC balances for the authenticated tenant's hosted wallet.",
    inputSchema: getUnifiedBalanceInputSchema,
  }),
} satisfies Readonly<Record<HostedArcToolName, HostedArcToolDescriptor>>);

type WalletInfo = Awaited<ReturnType<HostedArcWalletFacade["getWallet"]>>;
type HostedBalances = Awaited<ReturnType<HostedArcWalletFacade["getBalances"]>>;
type HostedTransfer = Awaited<
  ReturnType<HostedArcWalletFacade["transferTokens"]>
>;
type HostedReceipt = Awaited<
  ReturnType<HostedArcWalletFacade["getTransactionStatus"]>
>;
type UnifiedBalance = Awaited<
  ReturnType<ArcAppKitService["getUnifiedBalances"]>
>;

export interface HostedArcToolInputMap {
  readonly setup_agent_wallet: z.input<typeof walletSelectionInputSchema>;
  readonly get_agent_budget: z.input<typeof walletSelectionInputSchema>;
  readonly send_usdc: z.input<typeof sendUsdcInputSchema>;
  readonly get_payment_receipt: z.input<
    typeof getPaymentReceiptInputSchema
  >;
  readonly get_unified_balance: z.input<
    typeof getUnifiedBalanceInputSchema
  >;
}

export interface HostedArcToolOutputMap {
  readonly setup_agent_wallet: WalletInfo;
  readonly get_agent_budget: {
    readonly walletAddress: string;
    readonly chain: typeof ARC_HOSTED_CHAIN;
    readonly balances: HostedBalances;
  };
  readonly send_usdc: HostedTransfer;
  readonly get_payment_receipt: HostedReceipt;
  readonly get_unified_balance: UnifiedBalance;
}

export interface HostedArcWalletFacade {
  getWallet(authority: ArcHostedAuthority): Promise<CircleHostedWalletInfo>;
  getBalances(
    authority: ArcHostedAuthority,
  ): Promise<Array<{ symbol: string; amount: string; address?: string }>>;
  transferTokens(
    authority: ArcHostedAuthority,
    input: CircleHostedTransferInput,
  ): Promise<{ transactionId: string; state: string }>;
  getTransactionStatus(
    authority: ArcHostedAuthority,
    transactionId: string,
  ): Promise<{ transactionId: string; state: string; txHash?: string }>;
  createAppKitAdapter(
    authority: ArcHostedAuthority,
  ): Promise<ArcAppKitService>;
}

export interface HostedArcWalletRuntimeDependencies {
  /**
   * A cryptographically verified request authority from the HTTP/session
   * coordinator. This runtime refreshes its account/tenant/wallet binding; it
   * does not mint sessions or replace token expiry, scope, or client checks.
   */
  readonly authority: ArcHostedAuthority;
  readonly repository: ArcHostedAccountRepository;
  readonly facade: HostedArcWalletFacade;
}

export interface HostedArcWalletRuntime {
  readonly toolNames: typeof HOSTED_ARC_TOOL_NAMES;

  dispatch<Name extends HostedArcToolName>(
    name: Name,
    input: HostedArcToolInputMap[Name],
  ): Promise<HostedArcToolOutputMap[Name]>;

  dispatch(name: string, input: unknown): Promise<unknown>;
}

export function createHostedArcWalletRuntime(
  dependencies: HostedArcWalletRuntimeDependencies,
): HostedArcWalletRuntime {
  const authority = freezeAuthority(
    ArcHostedAuthoritySchema.parse(dependencies.authority),
  );
  if (authority.accountStatus !== "ACTIVE") {
    throw new Error(
      "Hosted authority is stale, revoked, paused, or unavailable",
    );
  }

  async function freshAuthority(): Promise<ArcHostedAuthority> {
    const current = await dependencies.repository.resolveHostedAuthority({
      authUserId: authority.authUserId,
      ...(authority.oauthClientId
        ? { oauthClientId: authority.oauthClientId }
        : {}),
    });
    if (!current) {
      throw new Error(
        "Hosted authority is stale, revoked, paused, or unavailable",
      );
    }

    const validCurrent = ArcHostedAuthoritySchema.parse(current);
    if (validCurrent.accountStatus !== "ACTIVE") {
      throw new Error(
        "Hosted authority is stale, revoked, paused, or unavailable",
      );
    }
    if (!sameAuthority(authority, validCurrent)) {
      throw new Error(
        "Hosted authority no longer matches the authenticated session",
      );
    }
    return freezeAuthority(validCurrent);
  }

  async function dispatch(name: string, rawInput: unknown): Promise<unknown> {
    if (!isHostedArcToolName(name)) {
      throw new Error(`Unknown hosted Arc tool: ${String(name)}`);
    }

    const input = HOSTED_ARC_TOOL_REGISTRY[name].inputSchema.parse(rawInput);
    assertBoundWallet(authority.walletAddress, input);
    const currentAuthority = await freshAuthority();

    switch (name) {
      case "setup_agent_wallet": {
        const wallet = await dependencies.facade.getWallet(currentAuthority);
        return { ...wallet };
      }
      case "get_agent_budget": {
        const balances = await dependencies.facade.getBalances(
          currentAuthority,
        );
        return {
          walletAddress: currentAuthority.walletAddress,
          chain: ARC_HOSTED_CHAIN,
          balances: balances.map((balance) => ({ ...balance })),
        };
      }
      case "send_usdc": {
        const sendInput = sendUsdcInputSchema.parse(input);
        const transaction = await dependencies.facade.transferTokens(
          currentAuthority,
          {
            toAddress: sendInput.recipient,
            amount: sendInput.amount,
            idempotencyKey: sendInput.idempotencyKey,
          },
        );
        return { ...transaction };
      }
      case "get_payment_receipt": {
        const receiptInput = getPaymentReceiptInputSchema.parse(input);
        const receipt = await dependencies.facade.getTransactionStatus(
          currentAuthority,
          receiptInput.transactionId,
        );
        return { ...receipt };
      }
      case "get_unified_balance": {
        const balanceInput = getUnifiedBalanceInputSchema.parse(input);
        const appKit = await dependencies.facade.createAppKitAdapter(
          currentAuthority,
        );
        const balances = await appKit.getUnifiedBalances(
          currentAuthority.walletAddress,
          balanceInput.includePending,
        );
        return {
          ...balances,
          breakdown: balances.breakdown.map((entry) => immutableClone(entry)),
        };
      }
    }
  }

  return Object.freeze({
    toolNames: HOSTED_ARC_TOOL_NAMES,
    dispatch,
  }) as HostedArcWalletRuntime;
}

function isHostedArcToolName(name: string): name is HostedArcToolName {
  return Object.prototype.hasOwnProperty.call(HOSTED_ARC_TOOL_REGISTRY, name);
}

function assertBoundWallet(
  boundWalletAddress: string,
  input: unknown,
): void {
  if (
    typeof input !== "object"
    || input === null
    || !("walletAddress" in input)
    || input.walletAddress === undefined
  ) {
    return;
  }

  const requestedWallet = ArcEvmAddressSchema.parse(input.walletAddress);
  if (requestedWallet !== boundWalletAddress) {
    throw new Error(
      "walletAddress does not match authenticated hosted wallet",
    );
  }
}

function sameAuthority(
  expected: ArcHostedAuthority,
  current: ArcHostedAuthority,
): boolean {
  return (
    current.authUserId === expected.authUserId
    && current.tenantId === expected.tenantId
    && current.walletAddress === expected.walletAddress
    && current.authEpoch === expected.authEpoch
    && current.accountStatus === "ACTIVE"
    && current.oauthClientId === expected.oauthClientId
  );
}

function freezeAuthority(
  authority: ArcHostedAuthority,
): ArcHostedAuthority {
  return Object.freeze({ ...authority });
}

function immutableClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
