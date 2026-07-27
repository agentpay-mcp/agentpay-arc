import {
  ARC_NETWORKS,
  ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
  ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
  ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
  erc8004IdentityAbi,
  erc8004ReputationAbi,
  erc8004ValidationAbi,
} from "@agentpay-ai/shared-arc";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

import type {
  ArcErc8004ProofReader,
  ArcErc8004Reader,
} from "../tools/arc-agent-identity.ts";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const zeroAddress = "0x0000000000000000000000000000000000000000";
const zeroHash = `0x${"0".repeat(64)}`;
const identityAbi = parseAbi([...erc8004IdentityAbi]);
const reputationAbi = parseAbi([...erc8004ReputationAbi]);
const validationAbi = parseAbi([...erc8004ValidationAbi]);
const receiptSchema = z.object({
  status: z.literal("success"),
  transactionHash: hashSchema,
  blockNumber: z.bigint().nonnegative(),
  logs: z.array(z.object({
    address: addressSchema,
    topics: z.array(hashSchema).min(1),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  }).passthrough()),
}).passthrough();

export interface ArcErc8004ViemClient {
  readContract(input: {
    readonly address: string;
    readonly abi: unknown;
    readonly functionName: string;
    readonly args: readonly unknown[];
  }): Promise<unknown>;
  getTransactionReceipt(input: {
    readonly hash: Hex;
  }): Promise<unknown>;
}

export interface ArcErc8004ViemReaders {
  readonly reader: ArcErc8004Reader;
  readonly proofReader: ArcErc8004ProofReader;
}

export function createArcErc8004ViemReaders(
  options: { readonly client?: ArcErc8004ViemClient } = {},
): ArcErc8004ViemReaders {
  const client = options.client ?? createDefaultClient();
  return {
    reader: createReader(client),
    proofReader: createProofReader(client),
  };
}

function createReader(client: ArcErc8004ViemClient): ArcErc8004Reader {
  return {
    ownerOf: (agentId) => readAddress(
      client,
      ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
      identityAbi,
      "ownerOf",
      [BigInt(agentId)],
    ),
    tokenURI: async (agentId) => {
      const value = await read(
        client,
        ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
        identityAbi,
        "tokenURI",
        [BigInt(agentId)],
      );
      return z.string().min(1).max(2_048).parse(value);
    },
    getAgentWallet: (agentId) => readAddress(
      client,
      ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
      identityAbi,
      "getAgentWallet",
      [BigInt(agentId)],
    ),
    getApproved: (agentId) => readAddress(
      client,
      ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
      identityAbi,
      "getApproved",
      [BigInt(agentId)],
    ),
    isApprovedForAll: async (owner, operator) => {
      const value = await read(
        client,
        ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
        identityAbi,
        "isApprovedForAll",
        [addressSchema.parse(owner), addressSchema.parse(operator)],
      );
      return z.boolean().parse(value);
    },
    getValidationStatus: async (requestHash) => {
      const tuple = tupleSchema(6).parse(await read(
        client,
        ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
        validationAbi,
        "getValidationStatus",
        [hashSchema.parse(requestHash)],
      ));
      const validatorAddress = addressSchema.parse(tuple[0]);
      const responseHash = hashSchema.parse(tuple[3]);
      return {
        exists: validatorAddress.toLowerCase() !== zeroAddress,
        validatorAddress,
        agentId: z.bigint().nonnegative().parse(tuple[1]).toString(),
        response: z.number().int().min(0).max(255).parse(tuple[2]),
        responseHash,
        tag: z.string().max(128).parse(tuple[4]),
        lastUpdate: z.bigint().nonnegative().parse(tuple[5]).toString(),
        hasResponse: responseHash.toLowerCase() !== zeroHash,
      };
    },
    getReputationSummary: async (agentId, clients, tag1, tag2) => {
      const tuple = tupleSchema(3).parse(await read(
        client,
        ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
        reputationAbi,
        "getSummary",
        [
          BigInt(agentId),
          clients.map((address) => addressSchema.parse(address)),
          tag1,
          tag2,
        ],
      ));
      return {
        count: z.bigint().nonnegative().parse(tuple[0]).toString(),
        summaryValue: z.bigint().parse(tuple[1]).toString(),
        summaryValueDecimals: z.number().int().min(0).max(255).parse(tuple[2]),
      };
    },
    getValidationSummary: async (agentId, validators, tag) => {
      const tuple = tupleSchema(2).parse(await read(
        client,
        ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
        validationAbi,
        "getSummary",
        [
          BigInt(agentId),
          validators.map((address) => addressSchema.parse(address)),
          tag,
        ],
      ));
      return {
        count: z.bigint().nonnegative().parse(tuple[0]).toString(),
        averageResponse: z.number().int().min(0).max(255).parse(tuple[1]),
      };
    },
  };
}

function createProofReader(client: ArcErc8004ViemClient): ArcErc8004ProofReader {
  return {
    async proveMutation(transaction, expectation) {
      const parsedHash = hashSchema.safeParse(transaction.txHash);
      if (!parsedHash.success) {
        throw new Error("ERC-8004 mutation transaction hash is unavailable.");
      }
      const transactionHash = parsedHash.data;
      const receipt = receiptSchema.safeParse(
        await client.getTransactionReceipt({ hash: transactionHash as Hex }),
      );
      if (!receipt.success || receipt.data.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error("ERC-8004 mutation does not have a successful receipt.");
      }
      const registry = addressSchema.parse(expectation.registry);
      const abi = eventAbi(expectation.event);
      for (const log of receipt.data.logs) {
        if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi,
            eventName: expectation.event,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data as Hex,
          });
          const args = decoded.args as Readonly<Record<string, unknown>>;
          if (!matchesExpectedArgs(args, expectation.expectedArgs)) continue;
          const agentId = args.agentId === undefined ? undefined : String(args.agentId);
          return {
            transactionHash,
            blockNumber: receipt.data.blockNumber.toString(),
            ...(agentId === undefined ? {} : { agentId }),
          };
        } catch {
          continue;
        }
      }
      throw new Error("Expected ERC-8004 event proof was not found.");
    },
  };
}

function matchesExpectedArgs(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = actual[key];
    if (actualValue === undefined || actualValue === null) return false;
    const normalizedActual = String(actualValue);
    if (
      /^0x[a-fA-F0-9]{40}$/.test(expectedValue)
      || /^0x[a-fA-F0-9]{64}$/.test(expectedValue)
    ) {
      return normalizedActual.toLowerCase() === expectedValue.toLowerCase();
    }
    return normalizedActual === expectedValue;
  });
}

async function read(
  client: ArcErc8004ViemClient,
  address: string,
  abi: unknown,
  functionName: string,
  args: readonly unknown[],
): Promise<unknown> {
  return await client.readContract({ address, abi, functionName, args });
}

async function readAddress(
  client: ArcErc8004ViemClient,
  address: string,
  abi: unknown,
  functionName: string,
  args: readonly unknown[],
): Promise<string> {
  return addressSchema.parse(await read(client, address, abi, functionName, args));
}

function tupleSchema(length: number) {
  return z.array(z.unknown()).length(length);
}

function eventAbi(event: "Registered" | "NewFeedback" | "ValidationRequest" | "ValidationResponse") {
  if (event === "Registered") return identityAbi;
  if (event === "NewFeedback") return reputationAbi;
  return validationAbi;
}

function createDefaultClient(): ArcErc8004ViemClient {
  const chain = defineChain({
    id: ARC_NETWORKS.testnet.chainId,
    name: ARC_NETWORKS.testnet.name,
    nativeCurrency: {
      name: ARC_NETWORKS.testnet.nativeCurrency.symbol,
      symbol: ARC_NETWORKS.testnet.nativeCurrency.symbol,
      decimals: ARC_NETWORKS.testnet.nativeCurrency.decimals,
    },
    rpcUrls: { default: { http: [ARC_NETWORKS.testnet.rpcUrl] } },
    blockExplorers: {
      default: { name: "Arcscan", url: ARC_NETWORKS.testnet.explorerUrl },
    },
    testnet: true,
  });
  const client = createPublicClient({ chain, transport: http(ARC_NETWORKS.testnet.rpcUrl) });
  return {
    readContract: async (input) => await client.readContract(input as never),
    getTransactionReceipt: async (input) => await client.getTransactionReceipt(input),
  };
}
