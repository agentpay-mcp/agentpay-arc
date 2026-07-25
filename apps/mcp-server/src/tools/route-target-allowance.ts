import {
  checkRouteTargetAllowanceInputSchema,
  getChainName,
  resolveCeloHomeChainId,
  type CeloHomeChainId,
  type CheckRouteTargetAllowanceInput,
  prepareRouteTargetAllowanceInputSchema,
  type PrepareRouteTargetAllowanceInput,
} from "@agentpay-ai/shared-arc";
import { Interface } from "ethers";

import type { AgentWalletRepository } from "./prepare-payment.ts";

const accountManagementInterface = new Interface([
  "function setAllowedRouteTarget(address target,bool allowed)",
]);

export interface PrepareRouteTargetAllowanceDependencies {
  wallets: AgentWalletRepository;
  homeChainId?: CeloHomeChainId;
}

export interface RouteTargetAllowanceCheckRequest {
  accountAddress: string;
  chainId: number;
  routeTarget: string;
}

export interface RouteTargetAllowanceChecker {
  isRouteTargetAllowed(request: RouteTargetAllowanceCheckRequest): Promise<boolean>;
}

export interface CheckRouteTargetAllowanceDependencies {
  wallets: AgentWalletRepository;
  routeTargetAllowances: RouteTargetAllowanceChecker;
  homeChainId?: CeloHomeChainId;
}

export interface RouteTargetAllowanceTransaction {
  from: string;
  to: string;
  value: "0";
  chainId: number;
  data: string;
}

export type PrepareRouteTargetAllowanceOutput =
  | {
      status: "READY";
      action: "ALLOW" | "REVOKE";
      routeTarget: string;
      allowed: boolean;
      ownerAddress: string;
      accountAddress: string;
      chainId: number;
      chain: string;
      transaction: RouteTargetAllowanceTransaction;
      instructionToAgent: string;
    }
  | {
      status: "NOT_CREATED";
      action: "ALLOW" | "REVOKE";
      routeTarget: string;
      allowed: boolean;
      transaction: null;
      instructionToAgent: string;
    };

export type CheckRouteTargetAllowanceOutput =
  | {
      status: "ACTIVE";
      routeTarget: string;
      routeTargetAllowed: boolean;
      ownerAddress: string;
      accountAddress: string;
      chainId: number;
      chain: string;
      instructionToAgent: string;
    }
  | {
      status: "NOT_CREATED";
      routeTarget: string;
      routeTargetAllowed: null;
      instructionToAgent: string;
    };

export async function checkRouteTargetAllowance(
  rawInput: CheckRouteTargetAllowanceInput,
  dependencies: CheckRouteTargetAllowanceDependencies,
): Promise<CheckRouteTargetAllowanceOutput> {
  const input = checkRouteTargetAllowanceInputSchema.parse(rawInput);
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet) {
    return {
      status: "NOT_CREATED",
      routeTarget: input.routeTarget,
      routeTargetAllowed: null,
      instructionToAgent: "Create an AgentPay wallet before checking route target allowlist status.",
    };
  }

  const chain = getChainName(wallet.homeChainId);
  const routeTargetAllowed = await dependencies.routeTargetAllowances.isRouteTargetAllowed({
    accountAddress: wallet.accountAddress,
    chainId: wallet.homeChainId,
    routeTarget: input.routeTarget,
  });

  return {
    status: "ACTIVE",
    routeTarget: input.routeTarget,
    routeTargetAllowed,
    ownerAddress: wallet.ownerAddress,
    accountAddress: wallet.accountAddress,
    chainId: wallet.homeChainId,
    chain,
    instructionToAgent: routeTargetAllowed
      ? `Route target ${input.routeTarget} is already allowlisted on ${chain}.`
      : `Route target ${input.routeTarget} is not allowlisted on ${chain}; call prepare_route_target_allowance before execution.`,
  };
}

export async function prepareRouteTargetAllowance(
  rawInput: PrepareRouteTargetAllowanceInput,
  dependencies: PrepareRouteTargetAllowanceDependencies,
): Promise<PrepareRouteTargetAllowanceOutput> {
  const input = prepareRouteTargetAllowanceInputSchema.parse(rawInput);
  const action = input.allowed ? "ALLOW" : "REVOKE";
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet) {
    return {
      status: "NOT_CREATED",
      action,
      routeTarget: input.routeTarget,
      allowed: input.allowed,
      transaction: null,
      instructionToAgent: "Create an AgentPay wallet before preparing a route target allowlist transaction.",
    };
  }

  const chain = getChainName(wallet.homeChainId);
  const transaction = {
    from: wallet.ownerAddress,
    to: wallet.accountAddress,
    value: "0",
    chainId: wallet.homeChainId,
    data: createSetAllowedRouteTargetCalldata(input.routeTarget, input.allowed),
  } satisfies RouteTargetAllowanceTransaction;

  return {
    status: "READY",
    action,
    routeTarget: input.routeTarget,
    allowed: input.allowed,
    ownerAddress: wallet.ownerAddress,
    accountAddress: wallet.accountAddress,
    chainId: wallet.homeChainId,
    chain,
    transaction,
    instructionToAgent: createInstruction({
      ownerAddress: wallet.ownerAddress,
      chain,
      routeTarget: input.routeTarget,
      allowed: input.allowed,
    }),
  };
}

export function createSetAllowedRouteTargetCalldata(routeTarget: string, allowed: boolean): string {
  return accountManagementInterface.encodeFunctionData("setAllowedRouteTarget", [routeTarget, allowed]);
}

export const prepareRouteTargetAllowanceTool = {
  name: "prepare_route_target_allowance",
  description: "Prepare the owner transaction that allows or revokes a LI.FI route target.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["routeTarget"],
    properties: {
      routeTarget: { type: "string" },
      allowed: { type: "boolean", default: true },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export const checkRouteTargetAllowanceTool = {
  name: "check_route_target_allowance",
  description: "Check whether a LI.FI route target is allowlisted on the AgentPay account.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["routeTarget"],
    properties: {
      routeTarget: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export function createPrepareRouteTargetAllowanceHandler(dependencies: PrepareRouteTargetAllowanceDependencies) {
  return (input: PrepareRouteTargetAllowanceInput) => prepareRouteTargetAllowance(input, dependencies);
}

export function createCheckRouteTargetAllowanceHandler(dependencies: CheckRouteTargetAllowanceDependencies) {
  return (input: CheckRouteTargetAllowanceInput) => checkRouteTargetAllowance(input, dependencies);
}

function createInstruction(input: {
  ownerAddress: string;
  chain: string;
  routeTarget: string;
  allowed: boolean;
}): string {
  const verb = input.allowed ? "allows" : "revokes";

  return `Ask the owner wallet ${input.ownerAddress} to submit this transaction on ${input.chain}. It ${verb} route target ${input.routeTarget} and does not approve any payment.`;
}
