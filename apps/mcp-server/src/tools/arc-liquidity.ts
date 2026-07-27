import { createHash } from "node:crypto";

import {
  circleAddressSchema,
  parseUsdcAtomic,
  uuidV4Schema,
  type CircleAgentWallet,
  type CircleBridgeResult,
  type CircleSwapResult,
  type CircleWalletBalance,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import {
  cloneArcLiquidityOperation,
  createUnavailableSwapSettlementVerifier,
  type ArcLiquidityDependencies,
  type ArcLiquidityOperation,
  type ArcLiquidityOperationStatus,
  type ArcLiquidityStep,
  type ArcLiquidityToolOutput,
  type SwapPaymentExecutor,
  type SwapSettlementProof,
} from "./arc-liquidity-state.ts";

export {
  bridgeUsdcTool,
  fundFromAnyChainTool,
  getUnifiedBalanceTool,
  swapAndPayTool,
  swapTokensTool,
} from "./arc-liquidity-definitions.ts";
export * from "./arc-liquidity-state.ts";

const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const ARC_EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ARC_APP_KIT_CHAIN = "Arc_Testnet";
const ARC_EXPLORER_TRANSACTION_BASE_URL = "https://testnet.arcscan.app/tx/";
const sixDecimalAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  .refine((value) => /[1-9]/.test(value), "Expected a positive six-decimal amount");
const tokenSchema = z.enum(["USDC", "EURC"]);
const walletSelectionSchema = z
  .object({ walletAddress: circleAddressSchema.optional() })
  .strict();
const swapInputSchema = walletSelectionSchema
  .extend({
    idempotencyKey: uuidV4Schema,
    sellToken: tokenSchema,
    buyToken: tokenSchema,
    sellAmount: sixDecimalAmountSchema,
    minimumReceive: sixDecimalAmountSchema,
    slippageBps: z.number().int().min(0).max(1_000),
  })
  .strict()
  .refine(({ sellToken, buyToken }) => sellToken !== buyToken, {
    message: "Swap assets must be different.",
  });
const bridgeInputSchema = walletSelectionSchema
  .extend({
    idempotencyKey: uuidV4Schema,
    destinationChain: z.string().trim().min(1).max(128),
    recipient: circleAddressSchema,
    amount: sixDecimalAmountSchema,
    token: z.literal("USDC").default("USDC"),
    minimumReceive: sixDecimalAmountSchema,
    slippageBps: z.number().int().min(0).max(1_000),
  })
  .strict();
const fundInputSchema = z
  .object({
    sourceChain: z.string().trim().min(1).max(128),
    sourceAddress: circleAddressSchema,
    walletAddress: circleAddressSchema,
    amount: sixDecimalAmountSchema,
  })
  .strict();
const swapAndPayInputSchema = swapInputSchema
  .extend({
    payment: z
      .object({
        recipient: circleAddressSchema,
        minimumAmount: sixDecimalAmountSchema,
        purpose: z.string().trim().min(1).max(512),
      })
      .strict(),
  })
  .strict()
  .refine(({ buyToken }) => buyToken === "USDC", {
    message: "swap_and_pay requires USDC as the purchased payment asset.",
  });

export async function getUnifiedBalance(
  rawInput: unknown,
  dependencies: ArcLiquidityDependencies,
) {
  const input = walletSelectionSchema.parse(rawInput);
  const wallet = selectWallet(await dependencies.circleCli.listAgentWallets(), input.walletAddress);
  const [walletBalance, gateway] = await Promise.all([
    dependencies.circleCli.getBalance(wallet.address),
    dependencies.appKit.getUnifiedBalances(wallet.address, true),
  ]);
  const onchain = canonicalArcUsdc(walletBalance);
  return {
    status: "READY" as const,
    walletAddress: wallet.address,
    onchainArcUsdc: onchain,
    gatewayConfirmedUsdc: normalizeSixDecimals(gateway.confirmed),
    gatewayPendingUsdc: gateway.pending === null ? null : normalizeSixDecimals(gateway.pending),
    gatewayPendingAvailable: gateway.pendingAvailable,
    confirmedAvailableUsdc: formatAtomic(
      parseAtomic(onchain) + parseAtomic(gateway.confirmed),
    ),
  };
}

export async function fundFromAnyChain(
  rawInput: unknown,
  dependencies: ArcLiquidityDependencies,
) {
  const input = fundInputSchema.parse(rawInput);
  const quote = await dependencies.appKit.estimateBridge({
    sourceChain: input.sourceChain,
    destinationChain: ARC_APP_KIT_CHAIN,
    sourceAddress: input.sourceAddress,
    recipient: input.walletAddress,
    amount: input.amount,
  });
  assertQuoteFresh(quote.expiresAt, now(dependencies));
  return {
    status: "SOURCE_ACTION_REQUIRED" as const,
    walletAddress: input.walletAddress,
    sourceAddress: input.sourceAddress,
    sourceChain: quote.sourceChain,
    destinationChain: quote.destinationChain,
    amount: normalizeSixDecimals(input.amount),
    quote,
    instruction:
      "Approve and execute this quoted USDC bridge from the source-chain wallet. AgentPay does not custody or sign with that wallet.",
  };
}

export async function bridgeUsdc(
  rawInput: unknown,
  dependencies: ArcLiquidityDependencies,
) {
  const input = bridgeInputSchema.parse(rawInput);
  const wallet = selectWallet(await dependencies.circleCli.listAgentWallets(), input.walletAddress);
  const replay = await replayOperation("BRIDGE", input, wallet.address, dependencies);
  if (replay) return operationOutput(replay);
  const quote = await dependencies.appKit.estimateBridge({
    sourceChain: ARC_APP_KIT_CHAIN,
    destinationChain: input.destinationChain,
    sourceAddress: wallet.address,
    recipient: input.recipient,
    amount: input.amount,
  });
  assertQuoteFresh(quote.expiresAt, now(dependencies));
  assertExactBridgeReceive(input.amount, input.minimumReceive, input.slippageBps);
  const claimed = await claimOperation("BRIDGE", input, wallet.address, quote.expiresAt, dependencies);
  if (!claimed.claimed) return operationOutput(claimed.operation);

  let result: CircleBridgeResult;
  try {
    result = await dependencies.circleCli.bridge({
      destination: quote.destinationChain,
      recipient: input.recipient,
      amount: input.amount,
      address: wallet.address,
      idempotencyKey: input.idempotencyKey,
    });
  } catch {
    return reconciliationOutput(
      await reconcile(claimed.operation, "BRIDGE", dependencies),
    );
  }
  try {
    return operationOutput(
      await persistBridgeResult(claimed.operation, result, quote.fees, dependencies),
    );
  } catch {
    return reconciliationOutput(
      await reconcile(
        claimed.operation,
        bridgeStep(result, quote.fees, "RECONCILIATION_REQUIRED"),
        dependencies,
      ),
    );
  }
}

export async function swapTokens(
  rawInput: unknown,
  dependencies: ArcLiquidityDependencies,
) {
  const input = swapInputSchema.parse(rawInput);
  const wallet = selectWallet(await dependencies.circleCli.listAgentWallets(), input.walletAddress);
  const replay = await replayOperation("SWAP", input, wallet.address, dependencies);
  if (replay) return operationOutput(replay);
  const { quote, effectiveMinimum } = await validatedSwapQuote(input, wallet.address, dependencies);
  const claimed = await claimOperation("SWAP", input, wallet.address, quote.expiresAt, dependencies);
  if (!claimed.claimed) return operationOutput(claimed.operation);

  let result: CircleSwapResult;
  try {
    result = await executeSwap(input, effectiveMinimum, wallet.address, dependencies);
  } catch {
    return reconciliationOutput(await reconcile(claimed.operation, "SWAP", dependencies));
  }
  try {
    return operationOutput(
      await persistSwapResult(claimed.operation, result, quote.fees, dependencies),
    );
  } catch {
    return reconciliationOutput(
      await reconcile(
        claimed.operation,
        swapStep(result, quote.fees, "RECONCILIATION_REQUIRED"),
        dependencies,
      ),
    );
  }
}

export async function swapAndPay(
  rawInput: unknown,
  dependencies: ArcLiquidityDependencies,
) {
  const input = swapAndPayInputSchema.parse(rawInput);
  const wallet = selectWallet(await dependencies.circleCli.listAgentWallets(), input.walletAddress);
  const replay = await replayOperation("SWAP_AND_PAY", input, wallet.address, dependencies);
  if (replay) return operationOutput(replay);
  const { quote, effectiveMinimum } = await validatedSwapQuote(input, wallet.address, dependencies);
  if (parseAtomic(input.payment.minimumAmount) > parseAtomic(effectiveMinimum)) {
    throw new Error("Payment minimum exceeds the protected swap receive amount.");
  }
  const claimed = await claimOperation(
    "SWAP_AND_PAY",
    input,
    wallet.address,
    quote.expiresAt,
    dependencies,
  );
  if (!claimed.claimed) return operationOutput(claimed.operation);

  let swap: CircleSwapResult;
  try {
    swap = await executeSwap(input, effectiveMinimum, wallet.address, dependencies);
  } catch {
    return reconciliationOutput(await reconcile(claimed.operation, "SWAP", dependencies));
  }
  let submitted: ArcLiquidityOperation;
  try {
    submitted = await transitionWithStep(
      claimed.operation,
      "SUBMITTED",
      swapStep(swap, quote.fees),
      ["SUBMITTING"],
      dependencies,
    );
  } catch {
    return reconciliationOutput(
      await reconcile(
        claimed.operation,
        swapStep(swap, quote.fees, "RECONCILIATION_REQUIRED"),
        dependencies,
      ),
    );
  }

  const verifier = dependencies.settlementVerifier ?? createUnavailableSwapSettlementVerifier();
  const proof = await verifier.verify({
    walletAddress: wallet.address,
    buyToken: input.buyToken,
    transactions: swap.transactions,
  });
  const paymentMinimumAtomic = parseAtomic(input.payment.minimumAmount);
  if (
    proof.status !== "MINED"
    || proof.actualReceivedAtomic === undefined
    || !/^\d+$/.test(proof.actualReceivedAtomic)
  ) {
    return reconciliationOutput(
      await reconciliationFromProof(submitted, proof, "PROOF_UNAVAILABLE", dependencies),
    );
  }
  if (BigInt(proof.actualReceivedAtomic) < paymentMinimumAtomic) {
    return reconciliationOutput(
      await reconciliationFromProof(
        submitted,
        proof,
        "RECEIVED_BELOW_MINIMUM",
        dependencies,
      ),
    );
  }
  const verified = await transitionWithStep(
    submitted,
    "SWAP_VERIFIED",
    proofStep(proof),
    ["SUBMITTED"],
    dependencies,
  );
  const paying = await dependencies.operations.transition(
    { ...verified, status: "PAYING", updatedAt: now(dependencies).toISOString() },
    ["SWAP_VERIFIED"],
  );
  let payment: Awaited<ReturnType<SwapPaymentExecutor["pay"]>>;
  try {
    payment = await dependencies.paymentExecutor.pay({
      idempotencyKey: input.idempotencyKey,
      walletAddress: wallet.address,
      recipient: input.payment.recipient,
      amount: input.payment.minimumAmount,
      token: "USDC",
      purpose: input.payment.purpose,
    });
  } catch {
    return reconciliationOutput(await reconcile(paying, "PAY", dependencies));
  }
  try {
    const completed = await transitionWithStep(
      paying,
      "COMPLETED",
      paymentStep(payment, "COMPLETED"),
      ["PAYING"],
      dependencies,
    );
    return operationOutput(completed);
  } catch {
    return reconciliationOutput(
      await reconcile(
        paying,
        paymentStep(payment, "RECONCILIATION_REQUIRED"),
        dependencies,
      ),
    );
  }
}

async function validatedSwapQuote(
  input: z.output<typeof swapInputSchema>,
  walletAddress: string,
  dependencies: ArcLiquidityDependencies,
) {
  const quote = await dependencies.appKit.estimateSwap({
    chain: ARC_APP_KIT_CHAIN,
    walletAddress,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount,
    slippageBps: input.slippageBps,
  });
  assertQuoteFresh(quote.expiresAt, now(dependencies));
  if (
    quote.chain !== ARC_APP_KIT_CHAIN
    || quote.sellToken !== input.sellToken
    || quote.buyToken !== input.buyToken
    || parseAtomic(quote.sellAmount) !== parseAtomic(input.sellAmount)
  ) {
    throw new Error("App Kit swap quote does not match the requested Arc swap.");
  }
  const quotedMinimum = parseAtomic(quote.minimumReceive);
  const estimated = parseAtomic(quote.estimatedReceive);
  const userMinimum = parseAtomic(input.minimumReceive);
  if (userMinimum < quotedMinimum) {
    throw new Error("minimumReceive is below the App Kit slippage-protected stop limit.");
  }
  if (userMinimum > estimated) {
    throw new Error("minimumReceive exceeds the App Kit estimated receive amount.");
  }
  return {
    quote,
    effectiveMinimum: formatAtomic(userMinimum > quotedMinimum ? userMinimum : quotedMinimum),
  };
}

async function executeSwap(
  input: z.output<typeof swapInputSchema>,
  minimumReceive: string,
  walletAddress: string,
  dependencies: ArcLiquidityDependencies,
) {
  return await dependencies.circleCli.swap({
    address: walletAddress,
    sellToken: tokenAddress(input.sellToken),
    sellAmount: input.sellAmount,
    buyToken: tokenAddress(input.buyToken),
    minimumBuy: minimumReceive,
    idempotencyKey: input.idempotencyKey,
  });
}

async function claimOperation(
  kind: ArcLiquidityOperation["kind"],
  input: { readonly idempotencyKey: string },
  walletAddress: string,
  quoteExpiresAt: string,
  dependencies: ArcLiquidityDependencies,
) {
  const existing = await dependencies.operations.get(input.idempotencyKey);
  const fingerprint = fingerprintInput(input);
  if (existing) {
    assertReplayMatch(existing, kind, fingerprint, walletAddress);
    return { claimed: false, operation: existing };
  }
  const timestamp = now(dependencies).toISOString();
  const claim = await dependencies.operations.claim({
    id: input.idempotencyKey,
    kind,
    inputFingerprint: fingerprint,
    status: "SUBMITTING",
    walletAddress,
    quoteExpiresAt,
    steps: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  assertReplayMatch(claim.operation, kind, fingerprint, walletAddress);
  return claim;
}

async function replayOperation(
  kind: ArcLiquidityOperation["kind"],
  input: { readonly idempotencyKey: string },
  walletAddress: string,
  dependencies: ArcLiquidityDependencies,
): Promise<ArcLiquidityOperation | null> {
  const existing = await dependencies.operations.get(input.idempotencyKey);
  if (!existing) return null;
  assertReplayMatch(existing, kind, fingerprintInput(input), walletAddress);
  return existing;
}

async function persistBridgeResult(
  operation: ArcLiquidityOperation,
  result: CircleBridgeResult,
  fees: readonly Readonly<Record<string, unknown>>[],
  dependencies: ArcLiquidityDependencies,
) {
  const transaction = result.transactions.at(-1);
  const status = result.status === "complete" && result.burnTxHash
    ? "COMPLETED"
    : "SUBMITTED";
  return await transitionWithStep(
    operation,
    status,
    bridgeStep(result, fees, status),
    ["SUBMITTING"],
    dependencies,
  );
}

function bridgeStep(
  result: CircleBridgeResult,
  fees: readonly Readonly<Record<string, unknown>>[],
  status: ArcLiquidityOperationStatus,
): ArcLiquidityStep {
  const transaction = result.transactions.at(-1);
  return {
    name: "BRIDGE",
    status,
    transactionId: transaction?.id,
    transactionHash: result.burnTxHash,
    burnTransactionHash: result.burnTxHash,
    ...(result.forwardTxHash
      ? { forwardTransactionHash: result.forwardTxHash }
      : {}),
    ...(result.traceId ? { traceId: result.traceId } : {}),
    ...(result.transferId ? { transferId: result.transferId } : {}),
    arcscanUrl: arcscanUrl(result.burnTxHash),
    fees: fees.map((fee) => ({ ...fee })),
  };
}

async function persistSwapResult(
  operation: ArcLiquidityOperation,
  result: CircleSwapResult,
  fees: readonly Readonly<Record<string, unknown>>[],
  dependencies: ArcLiquidityDependencies,
) {
  const complete = result.transactions.length > 0
    && result.transactions.every((transaction) =>
      ["COMPLETE", "COMPLETED", "CONFIRMED"].includes(transaction.state.toUpperCase())
    );
  return await transitionWithStep(
    operation,
    complete ? "COMPLETED" : "SUBMITTED",
    swapStep(result, fees, complete ? "COMPLETED" : "SUBMITTED"),
    ["SUBMITTING"],
    dependencies,
  );
}

function swapStep(
  result: CircleSwapResult,
  fees: readonly Readonly<Record<string, unknown>>[],
  status: ArcLiquidityOperationStatus = "SUBMITTED",
): ArcLiquidityStep {
  const transaction = result.transactions.at(-1);
  return {
    name: "SWAP",
    status,
    transactionId: transaction?.id,
    ...(transaction?.txHash
      ? { transactionHash: transaction.txHash, arcscanUrl: arcscanUrl(transaction.txHash) }
      : {}),
    fees: fees.map((fee) => ({ ...fee })),
  };
}

function proofStep(proof: SwapSettlementProof): ArcLiquidityStep {
  return {
    name: "VERIFY_SWAP",
    status: "SWAP_VERIFIED",
    transactionHash: proof.transactionHash,
    actualReceivedAtomic: proof.actualReceivedAtomic,
    blockNumber: proof.blockNumber,
  };
}

function paymentStep(
  payment: Awaited<ReturnType<SwapPaymentExecutor["pay"]>>,
  status: ArcLiquidityOperationStatus,
): ArcLiquidityStep {
  return {
    name: "PAY",
    status,
    ...(payment.transactionId ? { transactionId: payment.transactionId } : {}),
    ...(payment.transactionHash
      ? {
          transactionHash: payment.transactionHash,
          arcscanUrl: arcscanUrl(payment.transactionHash),
        }
      : {}),
  };
}

async function transitionWithStep(
  operation: ArcLiquidityOperation,
  status: ArcLiquidityOperationStatus,
  step: ArcLiquidityStep,
  expected: readonly ArcLiquidityOperationStatus[],
  dependencies: ArcLiquidityDependencies,
) {
  return await dependencies.operations.transition(
    {
      ...operation,
      status,
      steps: [...operation.steps, step],
      updatedAt: now(dependencies).toISOString(),
    },
    expected,
  );
}

async function reconcile(
  operation: ArcLiquidityOperation,
  rawStep: ArcLiquidityStep["name"] | ArcLiquidityStep,
  dependencies: ArcLiquidityDependencies,
): Promise<{
  readonly operation: ArcLiquidityOperation;
  readonly persistenceFailed: boolean;
}> {
  const step: ArcLiquidityStep = typeof rawStep === "string"
    ? { name: rawStep, status: "RECONCILIATION_REQUIRED" }
    : { ...rawStep, status: "RECONCILIATION_REQUIRED" };
  try {
    return {
      operation: await dependencies.operations.transition(
        {
          ...operation,
          status: "RECONCILIATION_REQUIRED",
          errorCode: "EXECUTION_AMBIGUOUS",
          steps: [
            ...operation.steps,
            step,
          ],
          updatedAt: now(dependencies).toISOString(),
        },
        [operation.status],
      ),
      persistenceFailed: false,
    };
  } catch {
    return { operation, persistenceFailed: true };
  }
}

async function reconciliationFromProof(
  operation: ArcLiquidityOperation,
  proof: SwapSettlementProof,
  errorCode: ArcLiquidityOperation["errorCode"],
  dependencies: ArcLiquidityDependencies,
): Promise<{
  readonly operation: ArcLiquidityOperation;
  readonly persistenceFailed: boolean;
}> {
  try {
    return {
      operation: await dependencies.operations.transition(
        {
          ...operation,
          status: "RECONCILIATION_REQUIRED",
          errorCode,
          steps: [
            ...operation.steps,
            { ...proofStep(proof), status: "RECONCILIATION_REQUIRED" },
          ],
          updatedAt: now(dependencies).toISOString(),
        },
        ["SUBMITTED"],
      ),
      persistenceFailed: false,
    };
  } catch {
    return { operation, persistenceFailed: true };
  }
}

function operationOutput(operation: ArcLiquidityOperation): ArcLiquidityToolOutput {
  return {
    status: operation.status,
    operation: cloneArcLiquidityOperation(operation)!,
    reconciliationRequired: operation.status === "RECONCILIATION_REQUIRED",
  };
}

function reconciliationOutput(result: {
  readonly operation: ArcLiquidityOperation;
  readonly persistenceFailed: boolean;
}): ArcLiquidityToolOutput {
  if (!result.persistenceFailed) return operationOutput(result.operation);
  return {
    ...operationOutput(result.operation),
    reconciliationRequired: true,
    reconciliationPersistenceFailed: true,
    reconciliationMessage:
      "The last persisted state is returned unchanged; reconciliation is required because the durable reconciliation transition failed.",
  };
}

function selectWallet(
  wallets: readonly CircleAgentWallet[],
  requestedAddress: string | undefined,
): CircleAgentWallet {
  if (wallets.length === 0) throw new Error("No authenticated Arc Circle Agent Wallet is available.");
  if (requestedAddress) {
    const match = wallets.find((entry) =>
      entry.address.toLowerCase() === requestedAddress.toLowerCase()
    );
    if (!match) throw new Error("walletAddress must reference an authenticated Circle Agent Wallet.");
    return match;
  }
  if (wallets.length !== 1) throw new Error("walletAddress is required when multiple wallets exist.");
  return wallets[0]!;
}

function canonicalArcUsdc(balance: CircleWalletBalance): string {
  const erc20 = balance.balances.find(({ token }) =>
    token.symbol.toUpperCase() === "USDC"
    && token.isNative === false
    && token.decimals === 6
    && token.tokenAddress?.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase()
  );
  if (erc20) return normalizeSixDecimals(erc20.amount);
  const native = balance.balances.find(({ token }) =>
    token.symbol.toUpperCase() === "USDC" && token.isNative
  );
  if (!native) return "0";
  const raw = decimalToAtomic(native.amount, native.token.decimals);
  return formatAtomic(raw);
}

function assertExactBridgeReceive(
  amount: string,
  minimum: string,
  slippageBps: number,
): void {
  if (slippageBps !== 0 || parseAtomic(minimum) !== parseAtomic(amount)) {
    throw new Error(
      "Circle Agent Wallet bridge supports exact receive only; minimumReceive must equal amount and slippageBps must be zero.",
    );
  }
}

function assertQuoteFresh(expiresAt: string, current: Date): void {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= current.getTime()) {
    throw new Error("The App Kit quote expired before execution.");
  }
}

function assertReplayMatch(
  operation: ArcLiquidityOperation,
  kind: ArcLiquidityOperation["kind"],
  fingerprint: string,
  walletAddress: string,
): void {
  if (
    operation.kind !== kind
    || operation.inputFingerprint !== fingerprint
    || operation.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
  ) {
    throw new Error("Idempotency key is already bound to a different liquidity operation.");
  }
}

function tokenAddress(token: "USDC" | "EURC"): string {
  return token === "USDC" ? ARC_USDC_ADDRESS : ARC_EURC_ADDRESS;
}

function parseAtomic(amount: string): bigint {
  return parseUsdcAtomic(sixDecimalAmountSchema.parse(amount));
}

function normalizeSixDecimals(amount: string): string {
  return formatAtomic(parseAtomic(amount));
}

function formatAtomic(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function decimalToAtomic(amount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  const sourceAtomic = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (decimals === 6) return sourceAtomic;
  if (decimals > 6) return sourceAtomic / (10n ** BigInt(decimals - 6));
  return sourceAtomic * (10n ** BigInt(6 - decimals));
}

function fingerprintInput(input: object): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function arcscanUrl(transactionHash: string): string {
  return `${ARC_EXPLORER_TRANSACTION_BASE_URL}${transactionHash}`;
}

function now(dependencies: ArcLiquidityDependencies): Date {
  return dependencies.clock?.() ?? new Date();
}
