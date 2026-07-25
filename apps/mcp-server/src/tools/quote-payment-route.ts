import {
  createDirectPaymentRouteQuote,
  formatNativeAmount,
  getChainName,
  isDirectPaymentRoute,
  quotePaymentRouteInputSchema,
  resolveCeloHomeChainId,
  type CeloHomeChainId,
  type QuotePaymentRouteInput,
  type RouteProvider,
} from "@agentpay-ai/shared-arc";

import type { AgentWalletRepository, RouteQuoteProvider } from "./prepare-payment.ts";
import { assertSufficientSourceTokenBalance } from "./prepare-payment.ts";
import type { TokenBalanceChecker } from "./execute-payment.ts";

export interface QuotePaymentRouteDependencies {
  wallets: AgentWalletRepository;
  routes: RouteQuoteProvider;
  balances: TokenBalanceChecker;
  homeChainId?: CeloHomeChainId;
}

export interface QuotePaymentRouteOutput {
  paymentType: "DIRECT" | "SWAP_BRIDGE_PAY";
  routeProvider: RouteProvider;
  sourceChainId: number;
  sourceChain: string;
  destinationChainId: number;
  destinationChain: string;
  sourceTokenSymbol: string;
  sourceTokenAddress: string;
  destinationTokenSymbol: string;
  destinationTokenAddress: string;
  amountOut: string;
  maxAmountIn: string;
  maxNativeFee: string;
  maxNativeFeeDisplay: string;
  routeTarget: string;
  routeCalldataHash: string;
  requiresRouteTargetAllowlist: boolean;
  estimatedFee: string;
  estimatedEtaSeconds: number;
  routeSummary: string;
}

export async function quotePaymentRoute(
  rawInput: QuotePaymentRouteInput,
  dependencies: QuotePaymentRouteDependencies,
): Promise<QuotePaymentRouteOutput> {
  const input = quotePaymentRouteInputSchema.parse(rawInput);
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet || wallet.status !== "ACTIVE") {
    throw new Error("No active AgentPay wallet is available.");
  }

  const paymentType = determinePaymentType(
    wallet.homeChainId,
    input.destinationChainId,
    input.sourceTokenSymbol,
    input.destinationTokenSymbol,
  );
  const quote =
    paymentType === "DIRECT"
      ? createDirectPaymentRouteQuote({
          chainId: wallet.homeChainId,
          tokenSymbol: input.sourceTokenSymbol,
          amountOut: input.amountOut,
        })
      : await dependencies.routes.quotePaymentRoute({
          accountAddress: wallet.accountAddress,
          ownerAddress: wallet.ownerAddress,
          sourceChainId: wallet.homeChainId,
          destinationChainId: input.destinationChainId,
          sourceTokenSymbol: input.sourceTokenSymbol,
          destinationTokenSymbol: input.destinationTokenSymbol,
          recipientAddress: input.recipientAddress,
          amountOut: input.amountOut,
        });

  await assertSufficientSourceTokenBalance({
    balances: dependencies.balances,
    wallet,
    tokenAddress: quote.sourceTokenAddress,
    tokenSymbol: input.sourceTokenSymbol,
    requiredAmount: quote.maxAmountIn,
  });

  return {
    paymentType,
    routeProvider: quote.routeProvider,
    sourceChainId: wallet.homeChainId,
    sourceChain: getChainName(wallet.homeChainId),
    destinationChainId: input.destinationChainId,
    destinationChain: getChainName(input.destinationChainId),
    sourceTokenSymbol: input.sourceTokenSymbol,
    sourceTokenAddress: quote.sourceTokenAddress,
    destinationTokenSymbol: input.destinationTokenSymbol,
    destinationTokenAddress: quote.destinationTokenAddress,
    amountOut: input.amountOut,
    maxAmountIn: quote.maxAmountIn,
    maxNativeFee: quote.maxNativeFee,
    maxNativeFeeDisplay: formatNativeAmount(quote.maxNativeFee, wallet.homeChainId),
    routeTarget: quote.routeTarget,
    routeCalldataHash: quote.routeCalldataHash,
    requiresRouteTargetAllowlist: quote.routeProvider !== "DIRECT",
    estimatedFee: quote.estimatedFee ?? "0",
    estimatedEtaSeconds: quote.estimatedEtaSeconds ?? 0,
    routeSummary: quote.routeSummary,
  };
}

export const quotePaymentRouteTool = {
  name: "quote_payment_route",
  description: "Quote an AgentPay payment route without creating an approval intent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["recipientAddress", "destinationChainId", "destinationTokenSymbol", "amountOut"],
    properties: {
      recipientAddress: { type: "string" },
      destinationChainId: { type: "number" },
      destinationTokenSymbol: { type: "string", enum: ["USDT0", "USDC", "USDT", "USDm"] },
      amountOut: { type: "string" },
      sourceTokenSymbol: { type: "string", enum: ["USDC", "USDT", "USDm"] },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export function createQuotePaymentRouteHandler(dependencies: QuotePaymentRouteDependencies) {
  return (input: QuotePaymentRouteInput) => quotePaymentRoute(input, dependencies);
}

function determinePaymentType(
  sourceChainId: number,
  destinationChainId: number,
  sourceTokenSymbol: string,
  destinationTokenSymbol: string,
): QuotePaymentRouteOutput["paymentType"] {
  return isDirectPaymentRoute(sourceChainId, destinationChainId, sourceTokenSymbol, destinationTokenSymbol)
    ? "DIRECT"
    : "SWAP_BRIDGE_PAY";
}
