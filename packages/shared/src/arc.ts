import { ARC_NETWORKS } from "./chains.ts";
import { STABLE_TOKENS_BY_CHAIN } from "./tokens.ts";

const arcTestnetNetwork = ARC_NETWORKS.testnet;
const arcTestnetUsdc = STABLE_TOKENS_BY_CHAIN[arcTestnetNetwork.chainId]?.USDC;

if (!arcTestnetUsdc) {
  throw new Error("Arc Testnet USDC metadata is not configured.");
}

export const ARC_TESTNET_CCTP_DOMAIN = 26;

export const ARC_TESTNET = {
  chainId: arcTestnetNetwork.chainId,
  caip2: arcTestnetNetwork.caip2,
  circleChain: arcTestnetNetwork.circleChain,
  name: arcTestnetNetwork.name,
  nativeCurrency: arcTestnetNetwork.nativeCurrency,
  rpcUrl: arcTestnetNetwork.rpcUrl,
  websocketUrl: arcTestnetNetwork.websocketUrl,
  explorerUrl: arcTestnetNetwork.explorerUrl,
  usdcAddress: arcTestnetUsdc.address,
  usdcDecimals: arcTestnetUsdc.decimals,
  cctpDomain: ARC_TESTNET_CCTP_DOMAIN,
} as const;

export const ARC_TESTNET_USDC = {
  symbol: "USDC",
  native: {
    decimals: arcTestnetNetwork.nativeCurrency.decimals,
  },
  erc20: {
    address: arcTestnetUsdc.address,
    decimals: arcTestnetUsdc.decimals,
  },
  balanceSemantics: {
    sameUnderlyingBalance: true,
    sumViews: false,
  },
} as const;
