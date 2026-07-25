import {
  createApprovalInstruction,
  createApprovalPhrase,
  createRouteCalldataHash,
  getChainName,
  getStableTokenMetadata,
  resolveCeloHomeChainId,
  type CeloHomeChainId,
  type PaymentIntentRecord,
  type PrepareContractCallInput,
  prepareContractCallInputSchema,
  type StableTokenSymbol,
} from "@agentpay-ai/shared-arc";

import type { AgentWalletRepository, PaymentIntentRepository } from "./prepare-payment.ts";
import { assertSufficientSourceTokenBalance } from "./prepare-payment.ts";
import type { TokenBalanceChecker } from "./execute-payment.ts";

export interface PrepareContractCallDependencies {
  wallets: AgentWalletRepository;
  balances: TokenBalanceChecker;
  paymentIntents: PaymentIntentRepository;
  clock: () => Date;
  createId: () => string;
  createNonce: () => string;
  homeChainId?: CeloHomeChainId;
  approvalTtlSeconds?: number;
}

export interface PrepareContractCallOutput {
  paymentIntentId: string;
  status: "AWAITING_APPROVAL";
  approvalPhrase: string;
  summary: {
    targetAddress: string;
    chainId: number;
    chain: string;
    sourceTokenSymbol: StableTokenSymbol;
    maxTokenSpend: string;
    maxNativeFee: string;
    callDataHash: string;
    requiresTargetAllowlist: true;
    deadline: string;
    purpose: string;
  };
  instructionToAgent: string;
}

export async function prepareContractCall(
  rawInput: PrepareContractCallInput,
  dependencies: PrepareContractCallDependencies,
): Promise<PrepareContractCallOutput> {
  const input = prepareContractCallInputSchema.parse(rawInput);
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet || wallet.status !== "ACTIVE") {
    throw new Error("No active AgentPay wallet is available.");
  }

  const chain = getChainName(wallet.homeChainId);
  const token = getStableTokenMetadata(wallet.homeChainId, input.sourceTokenSymbol);

  await assertSufficientSourceTokenBalance({
    balances: dependencies.balances,
    wallet,
    tokenAddress: token.address,
    tokenSymbol: input.sourceTokenSymbol,
    requiredAmount: input.maxTokenSpend,
  });

  const paymentIntentId = dependencies.createId();
  const approvalPhrase = createApprovalPhrase(paymentIntentId);
  const approvalTtlSeconds = dependencies.approvalTtlSeconds ?? 900;
  const deadline = new Date(dependencies.clock().getTime() + approvalTtlSeconds * 1000).toISOString();
  const callDataHash = createRouteCalldataHash(input.callData);
  const intent: PaymentIntentRecord = {
    id: paymentIntentId,
    accountAddress: wallet.accountAddress,
    ownerAddress: wallet.ownerAddress,
    status: "AWAITING_APPROVAL",
    paymentType: "CONTRACT_CALL",
    sourceChainId: wallet.homeChainId,
    destinationChainId: wallet.homeChainId,
    sourceTokenAddress: token.address,
    sourceTokenSymbol: input.sourceTokenSymbol,
    destinationTokenAddress: token.address,
    destinationTokenSymbol: input.sourceTokenSymbol,
    recipientAddress: input.targetAddress,
    amountOut: input.maxTokenSpend,
    maxAmountIn: input.maxTokenSpend,
    maxNativeFee: input.maxNativeFee,
    routeProvider: "CONTRACT_CALL",
    routeTarget: input.targetAddress,
    routeCalldata: input.callData,
    routeCalldataHash: callDataHash,
    routeSummary: `Contract call to ${input.targetAddress} on ${chain}.`,
    estimatedFee: "0",
    estimatedEtaSeconds: 0,
    nonce: dependencies.createNonce(),
    deadline,
    purpose: input.purpose,
    approvalPhrase,
  };

  await dependencies.paymentIntents.createPaymentIntent(intent);

  return {
    paymentIntentId,
    status: "AWAITING_APPROVAL",
    approvalPhrase,
    summary: {
      targetAddress: input.targetAddress,
      chainId: wallet.homeChainId,
      chain,
      sourceTokenSymbol: input.sourceTokenSymbol,
      maxTokenSpend: input.maxTokenSpend,
      maxNativeFee: input.maxNativeFee,
      callDataHash,
      requiresTargetAllowlist: true,
      deadline,
      purpose: input.purpose,
    },
    instructionToAgent: `${createApprovalInstruction(paymentIntentId)}\n\nBefore execution, verify ${input.targetAddress} is allowlisted with check_route_target_allowance or prepare the owner allowlist transaction with prepare_route_target_allowance.`,
  };
}

export const prepareContractCallTool = {
  name: "prepare_contract_call",
  description: "Prepare a guarded same-chain AgentPay contract call intent with calldata hash review.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["targetAddress", "callData", "maxTokenSpend", "purpose"],
    properties: {
      targetAddress: { type: "string" },
      callData: { type: "string" },
      sourceTokenSymbol: { type: "string", enum: ["USDC", "USDT", "USDm"] },
      maxTokenSpend: { type: "string" },
      maxNativeFee: { type: "string" },
      purpose: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export function createPrepareContractCallHandler(dependencies: PrepareContractCallDependencies) {
  return (input: PrepareContractCallInput) => prepareContractCall(input, dependencies);
}

export { prepareContractCallInputSchema };
