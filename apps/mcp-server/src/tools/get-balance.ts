import {
  getBalanceInputSchema,
  getChainName,
  getNativeCurrency,
  getStableTokenMetadata,
  resolveCeloHomeChainId,
  type CeloHomeChainId,
  type GetBalanceInput,
  type StableTokenSymbol,
} from "@agentpay-ai/shared-arc";

import type { AgentWalletRepository } from "./prepare-payment.ts";

export interface TokenBalanceReadRequest {
  accountAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: StableTokenSymbol;
  decimals: number;
}

export interface TokenBalanceReadResult {
  amount: string;
}

export interface TokenBalanceReader {
  getTokenBalance(request: TokenBalanceReadRequest): Promise<TokenBalanceReadResult>;
}

export interface NativeBalanceReadRequest {
  accountAddress: string;
  chainId: number;
  tokenSymbol: string;
  decimals: number;
}

export interface NativeBalanceReader {
  getNativeBalance(request: NativeBalanceReadRequest): Promise<TokenBalanceReadResult>;
}

export interface GetBalanceDependencies {
  wallets: AgentWalletRepository;
  tokenBalances: TokenBalanceReader;
  nativeBalances: NativeBalanceReader;
  homeChainId?: CeloHomeChainId;
}

export interface GetBalanceOutput {
  status: "ACTIVE" | "NOT_CREATED";
  accountAddress: string | null;
  ownerAddress: string | null;
  chainId: number | null;
  chain: string | null;
  balances: Array<{
    tokenSymbol: StableTokenSymbol;
    tokenAddress: string;
    amount: string;
    decimals: number;
  }>;
  nativeBalance: {
    tokenSymbol: string;
    tokenAddress: "native";
    amount: string;
    decimals: number;
  } | null;
}

export async function getBalance(rawInput: GetBalanceInput, dependencies: GetBalanceDependencies): Promise<GetBalanceOutput> {
  const input = getBalanceInputSchema.parse(rawInput);
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet) {
    return {
      status: "NOT_CREATED",
      accountAddress: null,
      ownerAddress: null,
      chainId: null,
      chain: null,
      balances: [],
      nativeBalance: null,
    };
  }

  const nativeCurrency = getNativeCurrency(wallet.homeChainId);
  const balances = await Promise.all(
    input.tokenSymbols.map(async (tokenSymbol) => {
      const metadata = getStableTokenMetadata(wallet.homeChainId, tokenSymbol);
      const balance = await dependencies.tokenBalances.getTokenBalance({
        accountAddress: wallet.accountAddress,
        chainId: wallet.homeChainId,
        tokenAddress: metadata.address,
        tokenSymbol,
        decimals: metadata.decimals,
      });

      return {
        tokenSymbol,
        tokenAddress: metadata.address,
        amount: balance.amount,
        decimals: metadata.decimals,
      };
    }),
  );
  const nativeBalance = await dependencies.nativeBalances.getNativeBalance({
    accountAddress: wallet.accountAddress,
    chainId: wallet.homeChainId,
    tokenSymbol: nativeCurrency.symbol,
    decimals: nativeCurrency.decimals,
  });

  return {
    status: "ACTIVE",
    accountAddress: wallet.accountAddress,
    ownerAddress: wallet.ownerAddress,
    chainId: wallet.homeChainId,
    chain: getChainName(wallet.homeChainId),
    balances,
    nativeBalance: {
      tokenSymbol: nativeCurrency.symbol,
      tokenAddress: "native",
      amount: nativeBalance.amount,
      decimals: nativeCurrency.decimals,
    },
  };
}

export const getBalanceTool = {
  name: "get_balance",
  description: "Read AgentPay wallet token balances on the active home chain.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tokenSymbols: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: ["USDC", "USDT", "USDm"] },
      },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export function createGetBalanceHandler(dependencies: GetBalanceDependencies) {
  return (input: GetBalanceInput) => getBalance(input, dependencies);
}
