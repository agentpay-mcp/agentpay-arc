import { AppKit } from "@circle-fin/app-kit";
import { ViemAdapter } from "@circle-fin/adapter-viem-v2";
import { isIP } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
} from "viem";
import { z } from "zod";

const decimalSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const chainNameSchema = z.string().trim().min(1).max(128);
const feeSchema = z
  .object({
    token: z.string().trim().min(1).max(128),
    amount: decimalSchema,
    type: z.string().trim().min(1).max(128).optional(),
  })
  .passthrough();
const chainSchema = z
  .object({
    chain: chainNameSchema,
    name: chainNameSchema,
    isTestnet: z.boolean(),
    type: z.string().optional(),
    chainId: z.number().int().positive().optional(),
    nativeCurrency: z
      .object({
        name: z.string(),
        symbol: z.string(),
        decimals: z.number().int().nonnegative(),
      })
      .optional(),
    rpcEndpoints: z
      .array(
        z.string().url().refine(isPublicHttpsRpcEndpoint, {
          message: "Expected a public HTTPS RPC endpoint",
        }),
      )
      .readonly()
      .optional(),
    explorerUrl: z.string().optional(),
  })
  .passthrough();
const balanceResultSchema = z
  .object({
    token: z.literal("USDC"),
    totalConfirmedBalance: decimalSchema,
    totalPendingBalance: decimalSchema.optional(),
    breakdown: z.array(z.unknown()),
  })
  .passthrough();
const swapEstimateSchema = z
  .object({
    stopLimit: z.object({ token: z.string(), amount: decimalSchema }),
    estimatedOutput: z.object({ token: z.string(), amount: decimalSchema }),
    fees: z.array(feeSchema).readonly().optional(),
  })
  .passthrough();
const bridgeEstimateSchema = z
  .object({
    fees: z.array(feeSchema).readonly().optional(),
  })
  .passthrough();

export interface ArcAppKitChain {
  readonly chain: string;
  readonly name: string;
  readonly isTestnet: boolean;
  readonly type?: string;
  readonly chainId?: number;
  readonly nativeCurrency?: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly rpcEndpoints?: readonly string[];
  readonly explorerUrl?: string;
  readonly [key: string]: unknown;
}

export interface ArcAppKitClient {
  getSupportedChains(
    operation?: "bridge" | "swap" | "unifiedBalance",
  ): readonly ArcAppKitChain[];
  readonly unifiedBalance: {
    getBalances(input: {
      readonly token: "USDC";
      readonly sources: { readonly address: string };
      readonly includePending: boolean;
      readonly networkType: "testnet";
    }): Promise<unknown>;
  };
  estimateBridge(input: {
    readonly from: { readonly adapter: unknown; readonly chain: string };
    readonly to: {
      readonly adapter: unknown;
      readonly chain: string;
      readonly recipientAddress: string;
    };
    readonly amount: string;
    readonly token: "USDC";
  }): Promise<unknown>;
  estimateSwap(input: {
    readonly from: { readonly adapter: unknown; readonly chain: string };
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly amountIn: string;
    readonly config: { readonly slippageBps: number };
  }): Promise<unknown>;
}

export interface ArcBridgeQuoteInput {
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly sourceAddress: string;
  readonly recipient: string;
  readonly amount: string;
}

export interface ArcSwapQuoteInput {
  readonly chain: string;
  readonly walletAddress: string;
  readonly sellToken: "USDC" | "EURC";
  readonly buyToken: "USDC" | "EURC";
  readonly sellAmount: string;
  readonly slippageBps: number;
}

export interface ArcAppKitService {
  getSupportedChains(
    operation?: "bridge" | "swap" | "unifiedBalance",
  ): readonly ArcAppKitChain[];
  getUnifiedBalances(
    address: string,
    includePending: boolean,
  ): Promise<{
    readonly token: "USDC";
    readonly confirmed: string;
    readonly pending: string | null;
    readonly pendingAvailable: boolean;
    readonly breakdown: readonly unknown[];
  }>;
  estimateBridge(input: ArcBridgeQuoteInput): Promise<{
    readonly token: "USDC";
    readonly sourceChain: string;
    readonly destinationChain: string;
    readonly amount: string;
    readonly fees: readonly Readonly<Record<string, unknown>>[];
    readonly quotedAt: string;
    readonly expiresAt: string;
  }>;
  estimateSwap(input: ArcSwapQuoteInput): Promise<{
    readonly chain: string;
    readonly sellToken: "USDC" | "EURC";
    readonly buyToken: "USDC" | "EURC";
    readonly sellAmount: string;
    readonly minimumReceive: string;
    readonly estimatedReceive: string;
    readonly fees: readonly Readonly<Record<string, unknown>>[];
    readonly quotedAt: string;
    readonly expiresAt: string;
  }>;
}

export interface ArcAppKitServiceOptions {
  readonly client?: ArcAppKitClient;
  readonly adapterFactory?: (
    chain: ArcAppKitChain,
    walletAddress: string,
  ) => unknown;
  readonly clock?: () => Date;
  readonly quoteTtlMs?: number;
}

export function createArcAppKitService(
  options: ArcAppKitServiceOptions = {},
): ArcAppKitService {
  const client = options.client ?? (new AppKit() as unknown as ArcAppKitClient);
  const adapterFactory = options.adapterFactory ?? createReadOnlyViemAdapter;
  const clock = options.clock ?? (() => new Date());
  const quoteTtlMs = z.number().int().positive().max(3_600_000).parse(
    options.quoteTtlMs ?? 300_000,
  );

  return {
    getSupportedChains(operation) {
      return parseChains(client.getSupportedChains(operation));
    },

    async getUnifiedBalances(rawAddress, includePending) {
      const address = addressSchema.parse(rawAddress);
      const parsed = balanceResultSchema.safeParse(
        await client.unifiedBalance.getBalances({
          token: "USDC",
          sources: { address },
          includePending,
          networkType: "testnet",
        }),
      );
      if (!parsed.success) {
        throw new Error("Circle App Kit returned an unexpected response.");
      }
      const hasPending = includePending && parsed.data.totalPendingBalance !== undefined;
      return {
        token: "USDC",
        confirmed: normalizeDecimal(parsed.data.totalConfirmedBalance),
        pending: hasPending
          ? normalizeDecimal(parsed.data.totalPendingBalance!)
          : null,
        pendingAvailable: hasPending,
        breakdown: parsed.data.breakdown.map((entry) => immutableClone(entry)),
      };
    },

    async estimateBridge(rawInput) {
      const input = parseBridgeQuoteInput(rawInput);
      const chains = parseChains(client.getSupportedChains("bridge"));
      const source = resolveChain(chains, input.sourceChain, "bridge");
      const destination = resolveChain(chains, input.destinationChain, "bridge");
      assertNetworkMatch(source, destination);
      const estimate = bridgeEstimateSchema.safeParse(
        await client.estimateBridge({
          from: {
            adapter: adapterFactory(source, input.sourceAddress),
            chain: source.chain,
          },
          to: {
            adapter: adapterFactory(destination, input.recipient),
            chain: destination.chain,
            recipientAddress: input.recipient,
          },
          amount: input.amount,
          token: "USDC",
        }),
      );
      if (!estimate.success) {
        throw new Error("Circle App Kit returned an unexpected bridge estimate.");
      }
      const timestamps = quoteTimestamps(clock(), quoteTtlMs);
      return {
        token: "USDC",
        sourceChain: source.chain,
        destinationChain: destination.chain,
        amount: normalizeDecimal(input.amount),
        fees: (estimate.data.fees ?? []).map((fee) => immutableClone(fee)),
        ...timestamps,
      };
    },

    async estimateSwap(rawInput) {
      const input = parseSwapQuoteInput(rawInput);
      const chain = resolveChain(
        parseChains(client.getSupportedChains("swap")),
        input.chain,
        "swap",
      );
      const estimate = swapEstimateSchema.safeParse(
        await client.estimateSwap({
          from: {
            adapter: adapterFactory(chain, input.walletAddress),
            chain: chain.chain,
          },
          tokenIn: input.sellToken,
          tokenOut: input.buyToken,
          amountIn: input.sellAmount,
          config: { slippageBps: input.slippageBps },
        }),
      );
      if (
        !estimate.success
        || estimate.data.stopLimit.token.toUpperCase() !== input.buyToken
        || estimate.data.estimatedOutput.token.toUpperCase() !== input.buyToken
      ) {
        throw new Error("Circle App Kit returned an unexpected swap estimate.");
      }
      const timestamps = quoteTimestamps(clock(), quoteTtlMs);
      return {
        chain: chain.chain,
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmount: normalizeDecimal(input.sellAmount),
        minimumReceive: normalizeDecimal(estimate.data.stopLimit.amount),
        estimatedReceive: normalizeDecimal(estimate.data.estimatedOutput.amount),
        fees: (estimate.data.fees ?? []).map((fee) => immutableClone(fee)),
        ...timestamps,
      };
    },
  };
}

function parseChains(chains: readonly ArcAppKitChain[]): readonly ArcAppKitChain[] {
  return z.array(chainSchema).readonly().parse(chains).map((chain) => ({
    ...chain,
    ...(chain.rpcEndpoints ? { rpcEndpoints: [...chain.rpcEndpoints] } : {}),
  }));
}

function isPublicHttpsRpcEndpoint(value: string): boolean {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.hostname.endsWith(".localhost")
    || url.hostname.endsWith(".local")
  ) {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(hostname);
  if (family === 4) {
    const [first, second] = hostname.split(".").map(Number);
    return !(
      first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first! >= 224
    );
  }
  if (family === 6) {
    return !(
      hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("::ffff:")
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || /^fe[89ab]/.test(hostname)
      || hostname.startsWith("ff")
    );
  }
  return hostname !== "localhost";
}

function parseBridgeQuoteInput(input: ArcBridgeQuoteInput): ArcBridgeQuoteInput {
  return z
    .object({
      sourceChain: chainNameSchema,
      destinationChain: chainNameSchema,
      sourceAddress: addressSchema,
      recipient: addressSchema,
      amount: decimalSchema.refine((value) => /[1-9]/.test(value)),
    })
    .strict()
    .parse(input);
}

function parseSwapQuoteInput(input: ArcSwapQuoteInput): ArcSwapQuoteInput {
  return z
    .object({
      chain: chainNameSchema,
      walletAddress: addressSchema,
      sellToken: z.enum(["USDC", "EURC"]),
      buyToken: z.enum(["USDC", "EURC"]),
      sellAmount: decimalSchema.refine((value) => /[1-9]/.test(value)),
      slippageBps: z.number().int().min(0).max(1_000),
    })
    .strict()
    .refine(({ sellToken, buyToken }) => sellToken !== buyToken, {
      message: "Swap assets must be different.",
    })
    .parse(input);
}

function resolveChain(
  chains: readonly ArcAppKitChain[],
  requested: string,
  operation: string,
): ArcAppKitChain {
  const match = chains.find(
    (chain) =>
      chain.chain.toLowerCase() === requested.toLowerCase()
      || chain.name.toLowerCase() === requested.toLowerCase(),
  );
  if (!match) {
    throw new Error(`Unsupported App Kit ${operation} chain.`);
  }
  return match;
}

function assertNetworkMatch(source: ArcAppKitChain, destination: ArcAppKitChain): void {
  if (source.isTestnet !== destination.isTestnet) {
    throw new Error("App Kit bridge source and destination networks must match.");
  }
}

function quoteTimestamps(now: Date, ttlMs: number) {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Quote clock returned an invalid date.");
  }
  return {
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

function normalizeDecimal(value: string): string {
  const [whole, fraction = ""] = decimalSchema.parse(value).split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole!;
}

function immutableClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => immutableClone(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableClone(entry)]),
    ) as T;
  }
  return value;
}

function createReadOnlyViemAdapter(
  chain: ArcAppKitChain,
  walletAddress: string,
): unknown {
  if (
    chain.type !== "evm"
    || typeof chain.chainId !== "number"
    || !chain.nativeCurrency
    || !chain.rpcEndpoints?.[0]
  ) {
    throw new Error("A read-only EVM adapter is unavailable for this App Kit chain.");
  }
  const viemChain = defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency as {
      name: string;
      symbol: string;
      decimals: number;
    },
    rpcUrls: {
      default: { http: [...chain.rpcEndpoints] },
    },
    blockExplorers: chain.explorerUrl
      ? { default: { name: `${chain.name} explorer`, url: chain.explorerUrl } }
      : undefined,
  });
  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http(chain.rpcEndpoints[0]),
  });
  const walletClient = createWalletClient({
    account: addressSchema.parse(walletAddress) as Address,
    chain: viemChain,
    transport: custom({
      async request({ method, params }) {
        assertReadOnlyRpcMethod(method);
        return await publicClient.request({ method, params } as never);
      },
    }),
  });
  return new ViemAdapter(
    {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
    },
    {
      addressContext: "user-controlled",
      supportedChains: [chain as never],
    },
  );
}

export function assertReadOnlyRpcMethod(method: string): void {
  const allowed = method.startsWith("eth_get")
    || method === "eth_call"
    || method === "eth_estimateGas"
    || method === "eth_chainId"
    || method === "eth_blockNumber"
    || method === "eth_feeHistory"
    || method === "eth_gasPrice"
    || method === "eth_maxPriorityFeePerGas"
    || method === "eth_syncing"
    || method === "eth_protocolVersion"
    || method === "net_version"
    || method === "net_listening"
    || method === "net_peerCount"
    || method === "web3_clientVersion";
  if (!allowed) throw new Error("Arc App Kit quote adapter is read-only.");
}
