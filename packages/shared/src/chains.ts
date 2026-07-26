import { z } from "zod";

export const SUPPORTED_CHAINS = {
  196: {
    id: 196,
    name: "X Layer",
    nativeCurrency: {
      symbol: "OKB",
      decimals: 18,
    },
  },
  1952: {
    id: 1952,
    name: "X Layer Testnet",
    nativeCurrency: {
      symbol: "OKB",
      decimals: 18,
    },
  },
  5042002: {
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: {
      symbol: "USDC",
      decimals: 18,
    },
  },
  8453: {
    id: 8453,
    name: "Base",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
  42220: {
    id: 42220,
    name: "Celo",
    nativeCurrency: {
      symbol: "CELO",
      decimals: 18,
    },
  },
  11142220: {
    id: 11142220,
    name: "Celo Sepolia",
    nativeCurrency: {
      symbol: "CELO",
      decimals: 18,
    },
  },
} as const;

export type SupportedChainId = keyof typeof SUPPORTED_CHAINS;
export type NativeCurrency = (typeof SUPPORTED_CHAINS)[SupportedChainId]["nativeCurrency"];

export const CELO_NETWORK_CHAIN_IDS = {
  mainnet: 42220,
  testnet: 11142220,
} as const;

export const CELO_NETWORKS = {
  mainnet: {
    chainId: 42220,
    caip2: "eip155:42220",
    name: "Celo Mainnet",
    nativeCurrency: { symbol: "CELO", decimals: 18 },
    rpcEnvName: "CELO_MAINNET_RPC_URL",
    fallbackRpcEnvName: "CELO_MAINNET_RPC_FALLBACK_URL",
    explorerUrl: "https://celoscan.io",
  },
  testnet: {
    chainId: 11142220,
    caip2: "eip155:11142220",
    name: "Celo Sepolia",
    nativeCurrency: { symbol: "CELO", decimals: 18 },
    rpcEnvName: "CELO_SEPOLIA_RPC_URL",
    explorerUrl: "https://celo-sepolia.blockscout.com",
  },
} as const;

export const ARC_NETWORKS = {
  testnet: {
    chainId: 5042002,
    caip2: "eip155:5042002",
    circleChain: "ARC-TESTNET",
    name: "Arc Testnet",
    nativeCurrency: { symbol: "USDC", decimals: 18 },
    rpcUrl: "https://rpc.testnet.arc.io",
    websocketUrl: "wss://rpc.testnet.arc.io",
    explorerUrl: "https://testnet.arcscan.app",
  },
} as const;

export const AGENTPAY_CELO_PUBLIC_URLS = {
  consumerMcp: "https://wallet.agentpay.site/celo/mcp",
  paidMcp: "https://mcp.agentpay.site/celo/mcp",
  setup: "https://wallet.agentpay.site/celo/setup",
  review: "https://wallet.agentpay.site/celo/review",
} as const;

export const AGENTPAY_ARC_PUBLIC_URLS = {
  consumerMcp: "https://wallet.agentpay.site/arc/mcp",
  paidMcp: "https://mcp.agentpay.site/arc/mcp",
  setup: "https://wallet.agentpay.site/arc/setup",
  review: "https://wallet.agentpay.site/arc/review",
  marketplace: "https://wallet.agentpay.site/arc/marketplace",
  activity: "https://wallet.agentpay.site/arc/activity",
} as const;

export const celoNetworkSchema = z.enum(["mainnet", "testnet"]);
export const celoHomeChainIdSchema = z.union([z.literal(42220), z.literal(11142220)]);
export const arcNetworkSchema = z.literal("testnet");
export const arcHomeChainIdSchema = z.literal(5042002);
export const networkSelectionShape = {
  network: arcNetworkSchema.optional(),
  homeChainId: arcHomeChainIdSchema.optional(),
} as const;

export type CeloNetwork = z.infer<typeof celoNetworkSchema>;
export type CeloHomeChainId = z.infer<typeof celoHomeChainIdSchema>;
export type ArcNetwork = z.infer<typeof arcNetworkSchema>;
export type ArcHomeChainId = z.infer<typeof arcHomeChainIdSchema>;
export type NetworkSelectionInput = {
  network?: ArcNetwork;
  homeChainId?: ArcHomeChainId;
};

export function resolveArcHomeChainId(input: NetworkSelectionInput, fallbackHomeChainId?: number): ArcHomeChainId {
  if (input.network !== undefined && input.network !== "testnet") {
    throw new Error(`Unsupported Arc network ${input.network}.`);
  }
  if (input.homeChainId !== undefined && input.homeChainId !== 5042002) {
    throw new Error(`Unsupported Arc homeChainId ${input.homeChainId}.`);
  }
  if (fallbackHomeChainId !== undefined && fallbackHomeChainId !== 5042002) {
    throw new Error(`Unsupported configured Arc homeChainId ${fallbackHomeChainId}.`);
  }
  return 5042002;
}

type CeloNetworkSelectionInput = {
  network?: CeloNetwork;
  homeChainId?: CeloHomeChainId;
};

export function resolveCeloHomeChainId(
  input: CeloNetworkSelectionInput,
  fallbackHomeChainId: CeloHomeChainId = 42220,
): CeloHomeChainId {
  const networkHomeChainId = input.network ? CELO_NETWORK_CHAIN_IDS[input.network] : undefined;

  if (networkHomeChainId !== undefined && input.homeChainId !== undefined && networkHomeChainId !== input.homeChainId) {
    throw new Error(`Network ${input.network} maps to chain ${networkHomeChainId}, but homeChainId ${input.homeChainId} was provided.`);
  }

  return input.homeChainId ?? networkHomeChainId ?? fallbackHomeChainId;
}

export function getChainName(chainId: number): string {
  return SUPPORTED_CHAINS[chainId as SupportedChainId]?.name ?? `Chain ${chainId}`;
}

export function getNativeCurrency(chainId: number): NativeCurrency {
  const nativeCurrency = SUPPORTED_CHAINS[chainId as SupportedChainId]?.nativeCurrency;

  if (!nativeCurrency) {
    throw new Error(`Unsupported chain ${chainId}.`);
  }

  return nativeCurrency;
}

export function formatNativeAmount(atomicAmount: string, chainId: number): string {
  const nativeCurrency = getNativeCurrency(chainId);
  return `${atomicToDecimal(BigInt(atomicAmount), nativeCurrency.decimals)} ${nativeCurrency.symbol}`;
}

function atomicToDecimal(amount: bigint, decimals: number): string {
  const padded = amount.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}
