import { z } from "zod";

export const STABLE_TOKEN_SYMBOLS = ["USDT0", "USDC", "USDT", "USDm"] as const;
export const CELO_STABLE_TOKEN_SYMBOLS = ["USDC", "USDT", "USDm"] as const;
export const DEFAULT_STABLE_TOKEN_SYMBOLS = CELO_STABLE_TOKEN_SYMBOLS;

export const stableTokenSymbolSchema = z.enum(STABLE_TOKEN_SYMBOLS);
export const celoStableTokenSymbolSchema = z.enum(CELO_STABLE_TOKEN_SYMBOLS);

export type StableTokenSymbol = z.infer<typeof stableTokenSymbolSchema>;
export type CeloStableTokenSymbol = z.infer<typeof celoStableTokenSymbolSchema>;

export const STABLE_TOKEN_DECIMALS: Record<StableTokenSymbol, number> = {
  USDT0: 6,
  USDC: 6,
  USDT: 6,
  USDm: 18,
};

export interface StableTokenMetadata {
  symbol: StableTokenSymbol;
  address: string;
  decimals: number;
}

export type StableTokenMetadataOverrides = Partial<
  Record<number, Partial<Record<StableTokenSymbol, Partial<Pick<StableTokenMetadata, "address" | "decimals">>>>>
>;

let configuredStableTokenMetadataOverrides: StableTokenMetadataOverrides = {};

export const STABLE_TOKENS_BY_CHAIN: Record<number, Partial<Record<StableTokenSymbol, StableTokenMetadata>>> = {
  196: {
    USDT0: {
      symbol: "USDT0",
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      decimals: 6,
    },
    USDC: {
      symbol: "USDC",
      address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      decimals: 6,
    },
  },
  1952: {
    USDT0: {
      symbol: "USDT0",
      address: "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c",
      decimals: 6,
    },
    USDC: {
      symbol: "USDC",
      address: "0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c",
      decimals: 6,
    },
  },
  5042002: {
    USDC: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
  },
  8453: {
    USDC: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6,
    },
  },
  42220: {
    USDC: {
      symbol: "USDC",
      address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
      decimals: 6,
    },
    USDm: {
      symbol: "USDm",
      address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
      decimals: 18,
    },
  },
  11142220: {
    USDC: {
      symbol: "USDC",
      address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
      decimals: 6,
    },
    USDm: {
      symbol: "USDm",
      address: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b",
      decimals: 18,
    },
  },
};

export function configureStableTokenMetadataOverrides(overrides: StableTokenMetadataOverrides): void {
  configuredStableTokenMetadataOverrides = { ...overrides };
}

export function getStableTokenDecimals(symbol: string): number {
  const decimals = STABLE_TOKEN_DECIMALS[symbol as StableTokenSymbol];
  if (decimals === undefined) {
    throw new Error(`Unsupported stable token symbol: ${symbol}`);
  }
  return decimals;
}

export function getStableTokenMetadata(chainId: number, symbol: string): StableTokenMetadata {
  const parsedSymbol = stableTokenSymbolSchema.parse(symbol);
  const metadata = STABLE_TOKENS_BY_CHAIN[chainId]?.[parsedSymbol];
  const override = configuredStableTokenMetadataOverrides[chainId]?.[parsedSymbol];

  if (!metadata && !override?.address) {
    throw new Error(`Unsupported stable token ${parsedSymbol} on chain ${chainId}.`);
  }

  return {
    ...(metadata ?? {
      symbol: parsedSymbol,
      address: override?.address ?? "",
      decimals: STABLE_TOKEN_DECIMALS[parsedSymbol],
    }),
    ...override,
    symbol: parsedSymbol,
  };
}

export function getStableTokenAddress(chainId: number, symbol: string): string {
  return getStableTokenMetadata(chainId, symbol).address;
}

export function getStableTokenDecimalsForChain(chainId: number, symbol: string): number {
  return getStableTokenMetadata(chainId, symbol).decimals;
}

export function getSupportedStableTokenMetadataForChain(chainId: number): StableTokenMetadata[] {
  const staticTokens = STABLE_TOKENS_BY_CHAIN[chainId] ?? {};
  const overrideTokens = configuredStableTokenMetadataOverrides[chainId] ?? {};
  const symbols = new Set<StableTokenSymbol>([
    ...(Object.keys(staticTokens) as StableTokenSymbol[]),
    ...(Object.keys(overrideTokens) as StableTokenSymbol[]),
  ]);

  return [...symbols].map((symbol) => getStableTokenMetadata(chainId, symbol));
}
