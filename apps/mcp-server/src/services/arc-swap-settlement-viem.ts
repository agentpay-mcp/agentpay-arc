import {
  ARC_TESTNET,
  getStableTokenAddress,
} from "@agentpay-ai/shared-arc";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { z } from "zod";

import type {
  SwapSettlementVerifier,
} from "../tools/arc-liquidity.ts";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const transferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const receiptSchema = z
  .object({
    status: z.enum(["success", "reverted"]),
    transactionHash: hashSchema,
    blockNumber: z.bigint().nonnegative(),
    logs: z.array(
      z
        .object({
          address: addressSchema,
          topics: z.array(hashSchema).min(1),
          data: z.string().regex(/^0x[a-fA-F0-9]*$/),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface ArcSwapSettlementViemClient {
  getTransactionReceipt(input: { readonly hash: Hex }): Promise<unknown>;
}

export function createArcSwapSettlementViemVerifier(
  options: { readonly client?: ArcSwapSettlementViemClient } = {},
): SwapSettlementVerifier {
  const client = options.client ?? createDefaultClient();

  return {
    async verify(input) {
      const walletAddress = addressSchema.parse(input.walletAddress);
      const buyTokenAddress = getStableTokenAddress(
        ARC_TESTNET.chainId,
        input.buyToken,
      );
      const transactionHashes = [...new Set(
        input.transactions.flatMap((transaction) => {
          const parsed = hashSchema.safeParse(transaction.txHash);
          return parsed.success ? [parsed.data.toLowerCase()] : [];
        }),
      )];
      if (transactionHashes.length === 0) {
        return { status: "UNAVAILABLE" };
      }

      let actualReceivedAtomic = 0n;
      let latestBlockNumber = 0n;
      let proofTransactionHash = transactionHashes[0]!;

      for (const transactionHash of transactionHashes) {
        let rawReceipt: unknown;
        try {
          rawReceipt = await client.getTransactionReceipt({
            hash: transactionHash as Hex,
          });
        } catch {
          return {
            status: "UNAVAILABLE",
            transactionHash,
          };
        }
        if (rawReceipt === null || rawReceipt === undefined) {
          return {
            status: "PENDING",
            transactionHash,
          };
        }
        const receipt = receiptSchema.safeParse(rawReceipt);
        if (
          !receipt.success
          || receipt.data.transactionHash.toLowerCase()
            !== transactionHash.toLowerCase()
          || receipt.data.status !== "success"
        ) {
          return {
            status: "UNAVAILABLE",
            transactionHash,
          };
        }

        proofTransactionHash = receipt.data.transactionHash;
        if (receipt.data.blockNumber > latestBlockNumber) {
          latestBlockNumber = receipt.data.blockNumber;
        }
        for (const log of receipt.data.logs) {
          if (log.address.toLowerCase() !== buyTokenAddress.toLowerCase()) {
            continue;
          }
          try {
            const decoded = decodeEventLog({
              abi: transferAbi,
              eventName: "Transfer",
              topics: log.topics as [Hex, ...Hex[]],
              data: log.data as Hex,
            });
            const args = decoded.args as {
              readonly to?: string;
              readonly value?: bigint;
            };
            if (
              args.to?.toLowerCase() === walletAddress.toLowerCase()
              && typeof args.value === "bigint"
              && args.value >= 0n
            ) {
              actualReceivedAtomic += args.value;
            }
          } catch {
            continue;
          }
        }
      }

      return {
        status: "MINED",
        transactionHash: proofTransactionHash,
        actualReceivedAtomic: actualReceivedAtomic.toString(),
        blockNumber: latestBlockNumber.toString(),
      };
    },
  };
}

function createDefaultClient(): ArcSwapSettlementViemClient {
  const chain = defineChain({
    id: ARC_TESTNET.chainId,
    name: ARC_TESTNET.name,
    nativeCurrency: {
      name: ARC_TESTNET.nativeCurrency.symbol,
      symbol: ARC_TESTNET.nativeCurrency.symbol,
      decimals: ARC_TESTNET.nativeCurrency.decimals,
    },
    rpcUrls: {
      default: { http: [ARC_TESTNET.rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "Arcscan",
        url: ARC_TESTNET.explorerUrl,
      },
    },
    testnet: true,
  });
  const client = createPublicClient({
    chain,
    transport: http(ARC_TESTNET.rpcUrl),
  });

  return {
    getTransactionReceipt: async (input) =>
      await client.getTransactionReceipt(input),
  };
}
