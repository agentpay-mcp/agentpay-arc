import {
  getChainName,
  prepareAccountAdminTransactionInputSchema,
  resolveArcHomeChainId,
  type PrepareAccountAdminTransactionInput,
} from "@agentpay-ai/shared-arc";
import { Interface } from "ethers";

import type { AgentWalletRepository } from "./prepare-payment.ts";

const accountAdminInterface = new Interface([
  "function cancelNonce(uint256 nonce)",
  "function pause()",
  "function setAllowedToken(address token,bool allowed)",
  "function setExecutor(address newExecutor)",
  "function unpause()",
  "function withdrawNative(address to,uint256 amount)",
  "function withdrawToken(address token,address to,uint256 amount)",
]);

export interface PrepareAccountAdminTransactionDependencies {
  wallets: AgentWalletRepository;
  homeChainId?: number;
}

export interface AccountAdminTransaction {
  from: string;
  to: string;
  value: "0";
  chainId: number;
  data: string;
}

export type PrepareAccountAdminTransactionOutput =
  | {
      status: "READY";
      action: PrepareAccountAdminTransactionInput["action"];
      ownerAddress: string;
      accountAddress: string;
      chainId: number;
      chain: string;
      transaction: AccountAdminTransaction;
      instructionToAgent: string;
    }
  | {
      status: "NOT_CREATED";
      action: PrepareAccountAdminTransactionInput["action"];
      transaction: null;
      instructionToAgent: string;
    };

export async function prepareAccountAdminTransaction(
  rawInput: PrepareAccountAdminTransactionInput,
  dependencies: PrepareAccountAdminTransactionDependencies,
): Promise<PrepareAccountAdminTransactionOutput> {
  const input = prepareAccountAdminTransactionInputSchema.parse(rawInput);
  const homeChainId = resolveArcHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet) {
    return {
      status: "NOT_CREATED",
      action: input.action,
      transaction: null,
      instructionToAgent: "Create an AgentPay wallet before preparing an account admin transaction.",
    };
  }

  const chain = getChainName(wallet.homeChainId);
  const transaction = {
    from: wallet.ownerAddress,
    to: wallet.accountAddress,
    value: "0",
    chainId: wallet.homeChainId,
    data: encodeAccountAdminCalldata(input),
  } satisfies AccountAdminTransaction;

  return {
    status: "READY",
    action: input.action,
    ownerAddress: wallet.ownerAddress,
    accountAddress: wallet.accountAddress,
    chainId: wallet.homeChainId,
    chain,
    transaction,
    instructionToAgent: createInstruction({
      ownerAddress: wallet.ownerAddress,
      chain,
      action: input.action,
    }),
  };
}

export function encodeAccountAdminCalldata(input: PrepareAccountAdminTransactionInput): string {
  switch (input.action) {
    case "PAUSE":
      return accountAdminInterface.encodeFunctionData("pause");
    case "UNPAUSE":
      return accountAdminInterface.encodeFunctionData("unpause");
    case "SET_EXECUTOR":
      return accountAdminInterface.encodeFunctionData("setExecutor", [input.newExecutorAddress]);
    case "CANCEL_NONCE":
      return accountAdminInterface.encodeFunctionData("cancelNonce", [BigInt(input.nonce)]);
    case "SET_ALLOWED_TOKEN":
      return accountAdminInterface.encodeFunctionData("setAllowedToken", [input.tokenAddress, input.allowed]);
    case "WITHDRAW_NATIVE":
      return accountAdminInterface.encodeFunctionData("withdrawNative", [input.toAddress, BigInt(input.amountAtomic)]);
    case "WITHDRAW_TOKEN":
      return accountAdminInterface.encodeFunctionData("withdrawToken", [
        input.tokenAddress,
        input.toAddress,
        BigInt(input.amountAtomic),
      ]);
  }
}

export const prepareAccountAdminTransactionTool = {
  name: "prepare_account_admin_transaction",
  description: "Prepare an owner transaction for AgentPay account pause, withdrawals, executor rotation, or token controls.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: [
          "PAUSE",
          "UNPAUSE",
          "SET_EXECUTOR",
          "CANCEL_NONCE",
          "SET_ALLOWED_TOKEN",
          "WITHDRAW_NATIVE",
          "WITHDRAW_TOKEN",
        ],
      },
      newExecutorAddress: { type: "string" },
      nonce: { type: "string" },
      tokenAddress: { type: "string" },
      allowed: { type: "boolean" },
      toAddress: { type: "string" },
      amountAtomic: { type: "string" },
      network: { type: "string", enum: ["testnet"] },
      homeChainId: { type: "number", enum: [5042002] },
    },
  },
} as const;

export function createPrepareAccountAdminTransactionHandler(
  dependencies: PrepareAccountAdminTransactionDependencies,
) {
  return (input: PrepareAccountAdminTransactionInput) => prepareAccountAdminTransaction(input, dependencies);
}

function createInstruction(input: {
  ownerAddress: string;
  chain: string;
  action: PrepareAccountAdminTransactionInput["action"];
}): string {
  return `Ask the owner wallet ${input.ownerAddress} to submit this ${input.action} transaction on ${input.chain}. This is an owner admin action and does not approve any payment.`;
}
