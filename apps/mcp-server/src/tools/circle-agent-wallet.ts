import {
  ARC_TESTNET,
  CIRCLE_ARC_CHAIN,
  circleAddressSchema,
  type CircleAgentWallet,
  type CircleWalletBalance,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import {
  CircleCliCommandError,
  type CircleCli,
} from "../services/circle-cli.ts";

const walletSelectionInputSchema = z
  .object({
    walletAddress: circleAddressSchema.optional(),
  })
  .strict();

const withdrawAgentBudgetInputSchema = walletSelectionInputSchema
  .extend({
    amount: z
      .string()
      .trim()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, "Expected USDC with at most six decimal places")
      .refine((amount) => /[1-9]/.test(amount), "Expected a positive USDC amount"),
    source: z.enum(["ONCHAIN", "GATEWAY"]).default("ONCHAIN"),
    recipient: circleAddressSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.source === "ONCHAIN" && !input.recipient) {
      context.addIssue({
        code: "custom",
        path: ["recipient"],
        message: "An onchain withdrawal recipient is required.",
      });
    }
  });

export type WalletSelectionInput = z.input<typeof walletSelectionInputSchema>;
export type WithdrawAgentBudgetInput = z.input<typeof withdrawAgentBudgetInputSchema>;
export interface CircleAgentWalletDependencies {
  circleCli: CircleCli;
}

export type SetupAgentWalletOutput =
  | {
      status: "LOGIN_REQUIRED" | "TERMS_REQUIRED";
      chain: typeof CIRCLE_ARC_CHAIN;
      instructionToAgent: string;
    }
  | {
      status: "WALLET_REQUIRED";
      chain: typeof CIRCLE_ARC_CHAIN;
      wallets: readonly [];
      selectedWalletAddress: null;
      instructionToAgent: string;
    }
  | {
      status: "READY";
      chain: typeof CIRCLE_ARC_CHAIN;
      wallets: readonly CircleAgentWallet[];
      selectedWalletAddress: string | null;
      instructionToAgent: string;
    };

export interface AgentBudgetOutput {
  status: "READY";
  walletAddress: string;
  chain: typeof CIRCLE_ARC_CHAIN;
  onchainUsdc: string;
  gatewayConfirmedUsdc: string;
  gatewayPendingUsdc: null;
  pendingSource: "NOT_AVAILABLE_FROM_CIRCLE_CLI";
  autonomousBudgetUsdc: string;
}

export async function setupAgentWallet(
  rawInput: unknown,
  dependencies: CircleAgentWalletDependencies,
): Promise<SetupAgentWalletOutput> {
  const input = walletSelectionInputSchema.parse(rawInput);

  try {
    const session = await dependencies.circleCli.status();
    if (session.testnet.tokenStatus !== "VALID") {
      return loginRequiredOutput();
    }

    const wallets = await dependencies.circleCli.listAgentWallets();
    if (wallets.length === 0) {
      return {
        status: "WALLET_REQUIRED",
        chain: CIRCLE_ARC_CHAIN,
        wallets: [],
        selectedWalletAddress: null,
        instructionToAgent:
          "Complete Circle Agent Wallet testnet login manually. Circle provisions Arc wallets during authentication.",
      };
    }

    if (!input.walletAddress && wallets.length > 1) {
      return {
        status: "READY",
        chain: CIRCLE_ARC_CHAIN,
        wallets: wallets.map((wallet) => ({ ...wallet })),
        selectedWalletAddress: null,
        instructionToAgent:
          "Multiple Circle Agent Wallets are ready. Ask the user which listed walletAddress to use.",
      };
    }

    const selected = selectWallet(wallets, input.walletAddress);
    return {
      status: "READY",
      chain: CIRCLE_ARC_CHAIN,
      wallets: wallets.map((wallet) => ({ ...wallet })),
      selectedWalletAddress: selected.address,
      instructionToAgent:
        "The Circle Agent Wallet is ready. Its funded USDC balance is the autonomous AgentPay budget.",
    };
  } catch (error) {
    if (error instanceof CircleCliCommandError && error.code === "AUTH_REQUIRED") {
      return loginRequiredOutput();
    }
    if (error instanceof CircleCliCommandError && error.code === "TERMS_REQUIRED") {
      return {
        status: "TERMS_REQUIRED",
        chain: CIRCLE_ARC_CHAIN,
        instructionToAgent:
          "Review and accept the Circle CLI Terms manually in the local terminal, then run setup_agent_wallet again.",
      };
    }
    throw error;
  }
}

export async function getAgentBudget(
  rawInput: unknown,
  dependencies: CircleAgentWalletDependencies,
): Promise<AgentBudgetOutput> {
  const input = walletSelectionInputSchema.parse(rawInput);
  const selected = selectWallet(
    await dependencies.circleCli.listAgentWallets(),
    input.walletAddress,
  );
  const [walletBalance, gatewayBalance] = await Promise.all([
    dependencies.circleCli.getBalance(selected.address),
    dependencies.circleCli.getGatewayBalance(selected.address),
  ]);
  const onchainUsdc = getCanonicalArcUsdcBalance(walletBalance);
  const gatewayConfirmedUsdc = normalizeUsdcAmount(gatewayBalance.total);

  return {
    status: "READY",
    walletAddress: selected.address,
    chain: CIRCLE_ARC_CHAIN,
    onchainUsdc,
    gatewayConfirmedUsdc,
    gatewayPendingUsdc: null,
    pendingSource: "NOT_AVAILABLE_FROM_CIRCLE_CLI",
    autonomousBudgetUsdc: addUsdcAmounts(onchainUsdc, gatewayConfirmedUsdc),
  };
}

export async function fundAgentWallet(
  rawInput: unknown,
  dependencies: CircleAgentWalletDependencies,
) {
  const input = walletSelectionInputSchema.parse(rawInput);
  const selected = selectWallet(
    await dependencies.circleCli.listAgentWallets(),
    input.walletAddress,
  );
  const funding = await dependencies.circleCli.fundFromFaucet(selected.address);

  return {
    status: "SUBMITTED" as const,
    walletAddress: selected.address,
    chain: CIRCLE_ARC_CHAIN,
    funding,
  };
}

export async function withdrawAgentBudget(
  rawInput: unknown,
  dependencies: CircleAgentWalletDependencies,
) {
  const input = withdrawAgentBudgetInputSchema.parse(rawInput);
  const selected = selectWallet(
    await dependencies.circleCli.listAgentWallets(),
    input.walletAddress,
  );

  if (input.source === "GATEWAY") {
    const withdrawal = await dependencies.circleCli.withdrawGateway({
      address: selected.address,
      amount: input.amount,
      recipient: input.recipient ?? selected.address,
    });
    return {
      status: "SUBMITTED" as const,
      source: input.source,
      walletAddress: selected.address,
      chain: CIRCLE_ARC_CHAIN,
      withdrawal,
    };
  }

  const transaction = await dependencies.circleCli.transfer({
    address: selected.address,
    amount: input.amount,
    recipient: input.recipient!,
  });
  return {
    status: "SUBMITTED" as const,
    source: input.source,
    walletAddress: selected.address,
    chain: CIRCLE_ARC_CHAIN,
    transaction,
  };
}

export function createSetupAgentWalletHandler(dependencies: CircleAgentWalletDependencies) {
  return (input: unknown) => setupAgentWallet(input, dependencies);
}

export function createGetAgentBudgetHandler(dependencies: CircleAgentWalletDependencies) {
  return (input: unknown) => getAgentBudget(input, dependencies);
}

export function createFundAgentWalletHandler(dependencies: CircleAgentWalletDependencies) {
  return (input: unknown) => fundAgentWallet(input, dependencies);
}

export function createWithdrawAgentBudgetHandler(dependencies: CircleAgentWalletDependencies) {
  return (input: unknown) => withdrawAgentBudget(input, dependencies);
}

export const setupAgentWalletTool = {
  name: "setup_agent_wallet",
  description:
    "Check the local Circle Agent Wallet testnet session and return manual login or Terms instructions when needed.",
  inputSchema: walletSelectionJsonSchema(),
} as const;

export const getAgentBudgetTool = {
  name: "get_agent_budget",
  description:
    "Read the selected Arc Agent Wallet and confirmed Gateway USDC balances as one autonomous budget.",
  inputSchema: walletSelectionJsonSchema(),
} as const;

export const fundAgentWalletTool = {
  name: "fund_agent_wallet",
  description:
    "Request Arc Testnet faucet funding for the selected Circle Agent Wallet.",
  inputSchema: walletSelectionJsonSchema(),
} as const;

export const withdrawAgentBudgetTool = {
  name: "withdraw_agent_budget",
  description:
    "Withdraw USDC from the selected onchain Agent Wallet or its confirmed Gateway balance.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: {
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      amount: {
        type: "string",
        pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$",
      },
      source: {
        type: "string",
        enum: ["ONCHAIN", "GATEWAY"],
        default: "ONCHAIN",
      },
      recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    },
  },
} as const;

function selectWallet(
  wallets: readonly CircleAgentWallet[],
  requestedAddress: string | undefined,
): CircleAgentWallet {
  if (wallets.length === 0) {
    throw new Error("No authenticated Arc Circle Agent Wallet is available.");
  }
  if (requestedAddress) {
    const selected = wallets.find(
      (wallet) => sameAddress(wallet.address, requestedAddress),
    );
    if (!selected) {
      throw new Error(
        "walletAddress must reference an authenticated Circle Agent Wallet.",
      );
    }
    return selected;
  }
  if (wallets.length > 1) {
    throw new Error(
      "walletAddress is required when multiple Circle Agent Wallets are available.",
    );
  }
  return wallets[0]!;
}

function getCanonicalArcUsdcBalance(balance: CircleWalletBalance): string {
  const canonicalErc20 = balance.balances.find(
    ({ token }) =>
      token.symbol.toUpperCase() === "USDC" &&
      !token.isNative &&
      token.decimals === ARC_TESTNET.usdcDecimals &&
      token.tokenAddress !== undefined &&
      sameAddress(token.tokenAddress, ARC_TESTNET.usdcAddress),
  );
  const nativeFallback = balance.balances.find(
    ({ token }) =>
      token.symbol.toUpperCase() === "USDC" && token.isNative,
  );
  const selected = canonicalErc20 ?? nativeFallback;
  if (!selected) {
    return "0";
  }
  return selected.token.isNative
    ? normalizeNativeUsdcAmount(selected.amount, selected.token.decimals)
    : normalizeUsdcAmount(selected.amount);
}

function addUsdcAmounts(left: string, right: string): string {
  return formatUsdcAtomic(parseUsdcAtomic(left) + parseUsdcAtomic(right));
}

function normalizeUsdcAmount(amount: string): string {
  return formatUsdcAtomic(parseUsdcAtomic(amount));
}

function normalizeNativeUsdcAmount(amount: string, decimals: number): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new Error("Circle returned an invalid native USDC amount.");
  }
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(6))) {
    throw new Error(
      "Circle returned a native USDC amount below six-decimal AgentPay spending precision.",
    );
  }
  const sixDecimalAmount = fraction
    ? `${match[1]}.${fraction.slice(0, 6).padEnd(Math.min(6, decimals), "0")}`
    : match[1]!;
  return normalizeUsdcAmount(sixDecimalAmount);
}

function parseUsdcAtomic(amount: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) {
    throw new Error("Circle returned an invalid six-decimal USDC amount.");
  }
  const whole = BigInt(match[1]!);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * 1_000_000n + BigInt(fraction || "0");
}

function formatUsdcAtomic(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function loginRequiredOutput(): SetupAgentWalletOutput {
  return {
    status: "LOGIN_REQUIRED",
    chain: CIRCLE_ARC_CHAIN,
    instructionToAgent:
      "Log in to the Circle Agent Wallet testnet session manually with email OTP, then run setup_agent_wallet again.",
  };
}

function walletSelectionJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    },
  } as const;
}
