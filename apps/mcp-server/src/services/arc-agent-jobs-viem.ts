import {
  ARC_NETWORKS,
  ARC_TESTNET,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION,
  ERC1967_IMPLEMENTATION_SLOT,
  circleTransactionResultSchema,
  erc8183AgenticCommerceAbi,
  jobStateFromOnchainStatus,
} from "@agentpay-ai/shared-arc";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { z } from "zod";

import type {
  ArcAgentJobProofReader,
  ArcAgentJobReader,
} from "../tools/arc-agent-jobs.ts";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const uint256Schema = z.bigint().nonnegative().max((1n << 256n) - 1n);
const basisPointsSchema = z.bigint().nonnegative().max(10_000n);
const canonicalUint256Pattern = /^(?:0|[1-9]\d*)$/;
const canonicalJobIdSchema = z
  .string()
  .regex(canonicalUint256Pattern)
  .refine(
    (value) =>
      !canonicalUint256Pattern.test(value)
      || BigInt(value) <= (1n << 256n) - 1n,
  );
const zeroAddress = "0x0000000000000000000000000000000000000000";
const agenticCommerceAbi = parseAbi([...erc8183AgenticCommerceAbi]);
const erc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);
const verifiedMutationSignatures = new Map<string, string>([
  ["createJob", "createJob(address,address,uint256,string,address)"],
  ["setProvider", "setProvider(uint256,address)"],
  ["setBudget", "setBudget(uint256,uint256,bytes)"],
  ["fund", "fund(uint256,bytes)"],
  ["submit", "submit(uint256,bytes32,bytes)"],
  ["complete", "complete(uint256,bytes32,bytes)"],
  ["reject", "reject(uint256,bytes32,bytes)"],
  ["claimRefund", "claimRefund(uint256)"],
]);
const transactionSchema = z.object({
  to: addressSchema.nullable(),
  input: z.string().regex(/^0x[a-fA-F0-9]*$/),
}).passthrough();
const receiptSchema = z.object({
  status: z.literal("success"),
  transactionHash: hashSchema,
  blockNumber: uint256Schema,
  logs: z.array(z.object({
    address: addressSchema,
    topics: z.array(hashSchema).min(1),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  }).passthrough()),
}).passthrough();

export interface ArcAgentJobViemClient {
  readContract(input: {
    readonly address: string;
    readonly abi: unknown;
    readonly functionName: string;
    readonly args: readonly unknown[];
  }): Promise<unknown>;
  getTransactionReceipt(input: {
    readonly hash: Hex;
  }): Promise<unknown>;
  getStorageAt(input: {
    readonly address: string;
    readonly slot: Hex;
  }): Promise<Hex | undefined>;
  getBytecode(input: {
    readonly address: string;
  }): Promise<Hex | undefined>;
  getTransaction(input: {
    readonly hash: Hex;
  }): Promise<unknown>;
}

export interface ArcAgentJobViemReaders {
  readonly reader: ArcAgentJobReader;
  readonly proofReader: ArcAgentJobProofReader;
}

export function createArcAgentJobViemReaders(
  options: { readonly client?: ArcAgentJobViemClient } = {},
): ArcAgentJobViemReaders {
  const client = options.client ?? createDefaultClient();
  const verifyProxy = createProxyVerifier(client);
  return {
    reader: createReader(client, verifyProxy),
    proofReader: createProofReader(client, verifyProxy),
  };
}

function createReader(
  client: ArcAgentJobViemClient,
  verifyProxy: () => Promise<void>,
): ArcAgentJobReader {
  return {
    async getJob(rawJobId) {
      const jobId = canonicalJobIdSchema.parse(rawJobId);
      await verifyProxy();
      const tuple = z.array(z.unknown()).length(9).parse(await read(
        client,
        ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        agenticCommerceAbi,
        "getJob",
        [BigInt(jobId)],
      ));
      const status = z.union([
        z.number().int().nonnegative(),
        z.bigint().nonnegative().transform(Number),
      ]).parse(tuple[7]);
      return {
        id: uint256Schema.parse(tuple[0]).toString(),
        client: addressSchema.parse(tuple[1]),
        provider: addressSchema.parse(tuple[2]),
        evaluator: addressSchema.parse(tuple[3]),
        description: z.string().trim().min(1).max(2_048).parse(tuple[4]),
        budget: formatUsdcAtomic(uint256Schema.parse(tuple[5])),
        expiredAt: uint256Schema.parse(tuple[6]).toString(),
        state: jobStateFromOnchainStatus(status),
        hook: addressSchema.parse(tuple[8]),
      };
    },
    async paymentToken() {
      await verifyProxy();
      return await readAddress(
        client,
        ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        agenticCommerceAbi,
        "paymentToken",
        [],
      );
    },
    async platformFeeBasisPoints() {
      await verifyProxy();
      return await readBasisPoints(client, "platformFeeBP");
    },
    async evaluatorFeeBasisPoints() {
      await verifyProxy();
      return await readBasisPoints(client, "evaluatorFeeBP");
    },
    async usdcAllowance(owner, spender) {
      const parsedOwner = addressSchema.parse(owner);
      const parsedSpender = addressSchema.parse(spender);
      await verifyProxy();
      const allowance = uint256Schema.parse(await read(
        client,
        ARC_TESTNET.usdcAddress,
        erc20Abi,
        "allowance",
        [parsedOwner, parsedSpender],
      ));
      return allowance.toString();
    },
    async isHookWhitelisted(hook) {
      const parsedHook = addressSchema.parse(hook);
      await verifyProxy();
      return parsedHook.toLowerCase() === zeroAddress;
    },
  };
}

function createProofReader(
  client: ArcAgentJobViemClient,
  verifyProxy: () => Promise<void>,
): ArcAgentJobProofReader {
  return {
    async proveMutation(rawTransaction, expectation) {
      const transaction = circleTransactionResultSchema.parse(rawTransaction);
      const transactionHash = hashSchema.safeParse(transaction.txHash);
      if (!transactionHash.success) {
        throw new Error("ERC-8183 mutation transaction hash is unavailable.");
      }
      const target = addressSchema.parse(expectation.contract);
      const expectedJobId =
        expectation.jobId === undefined
          ? undefined
          : canonicalJobIdSchema.parse(expectation.jobId);
      await verifyProxy();
      const onchainTransaction = transactionSchema.safeParse(
        await client.getTransaction({ hash: transactionHash.data as Hex }),
      );
      if (
        !onchainTransaction.success
        || onchainTransaction.data.to?.toLowerCase() !== target.toLowerCase()
      ) {
        throw new Error("ERC-8183 transaction target does not match the expected contract.");
      }
      verifyTransactionInput(
        target,
        onchainTransaction.data.input as Hex,
        expectedJobId,
        expectation.functionSignature,
        expectation.parameters,
      );
      const receipt = receiptSchema.safeParse(
        await client.getTransactionReceipt({ hash: transactionHash.data as Hex }),
      );
      if (
        !receipt.success
        || receipt.data.transactionHash.toLowerCase() !== transactionHash.data.toLowerCase()
      ) {
        throw new Error("ERC-8183 mutation does not have a successful receipt.");
      }

      const targetLogs = receipt.data.logs.filter(
        (log) => log.address.toLowerCase() === target.toLowerCase(),
      );
      if (targetLogs.length === 0) {
        throw new Error("ERC-8183 proof contains no exact target contract log.");
      }

      const isCreate =
        target.toLowerCase() === ARC_TESTNET_ERC8183_AGENTIC_COMMERCE.toLowerCase()
        && expectedJobId === undefined;
      if (isCreate) {
        const createdJobId = decodeCreatedJobId(targetLogs);
        if (createdJobId === undefined) {
          throw new Error("Expected ERC-8183 JobCreated event proof was not found.");
        }
        return {
          transactionHash: transactionHash.data,
          blockNumber: receipt.data.blockNumber.toString(),
          jobId: createdJobId,
        };
      }

      return {
        transactionHash: transactionHash.data,
        blockNumber: receipt.data.blockNumber.toString(),
        ...(expectedJobId === undefined ? {} : { jobId: expectedJobId }),
      };
    },
  };
}

function verifyTransactionInput(
  target: string,
  input: Hex,
  expectedJobId: string | undefined,
  expectedFunctionSignature: string,
  expectedParameters: readonly string[],
): void {
  if (target.toLowerCase() === ARC_TESTNET_ERC8183_AGENTIC_COMMERCE.toLowerCase()) {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: agenticCommerceAbi, data: input });
    } catch {
      throw new Error("ERC-8183 transaction input does not match the verified ABI.");
    }

    const verifiedSignature = verifiedMutationSignatures.get(decoded.functionName);
    if (
      verifiedSignature !== expectedFunctionSignature
      || !parametersMatch(decoded.args as readonly unknown[] | undefined, expectedParameters)
    ) {
      throw new Error("ERC-8183 transaction input does not match the requested mutation.");
    }
    if (
      expectedJobId === undefined
        ? decoded.functionName !== "createJob"
        : String((decoded.args as readonly unknown[] | undefined)?.[0]) !== expectedJobId
    ) {
      throw new Error(`ERC-8183 transaction input job id does not match expected job ${expectedJobId}.`);
    }
    return;
  }

  if (
    target.toLowerCase() !== ARC_TESTNET.usdcAddress.toLowerCase()
    || expectedJobId !== undefined
  ) {
    throw new Error("ERC-8183 proof cannot bind a job id to a non-job contract.");
  }
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: input });
    if (
      decoded.functionName !== "approve"
      || expectedFunctionSignature !== "approve(address,uint256)"
      || !parametersMatch(decoded.args as readonly unknown[] | undefined, expectedParameters)
    ) {
      throw new Error("unexpected approval");
    }
  } catch {
    throw new Error("ERC-8183 funding approval transaction input does not match the exact request.");
  }
}

function parametersMatch(
  actual: readonly unknown[] | undefined,
  expected: readonly string[],
): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return actual.every((value, index) => parameterMatches(value, expected[index]!));
}

function parameterMatches(actual: unknown, expected: string): boolean {
  if (typeof actual === "bigint" || typeof actual === "number") {
    return String(actual) === expected;
  }
  if (typeof actual !== "string") return false;
  if (/^0x[a-fA-F0-9]*$/.test(expected)) {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

function createProxyVerifier(client: ArcAgentJobViemClient): () => Promise<void> {
  return () => verifyProxyImplementation(client);
}

async function verifyProxyImplementation(client: ArcAgentJobViemClient): Promise<void> {
  const storage = await client.getStorageAt({
    address: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
    slot: ERC1967_IMPLEMENTATION_SLOT,
  });
  if (!storage || !/^0x[a-fA-F0-9]{64}$/.test(storage)) {
    throw abiReverificationError();
  }
  const implementation = `0x${storage.slice(-40)}`;
  if (
    implementation.toLowerCase()
    !== ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION
  ) {
    throw abiReverificationError();
  }
  const bytecode = await client.getBytecode({ address: implementation });
  if (!bytecode || bytecode === "0x") {
    throw abiReverificationError();
  }
}

function abiReverificationError(): Error {
  return new Error(
    "ERC-8183 proxy implementation changed or has no bytecode; ABI re-verification is required.",
  );
}

function decodeCreatedJobId(
  logs: readonly z.output<typeof receiptSchema>["logs"][number][],
): string | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: agenticCommerceAbi,
        eventName: "JobCreated",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const args = decoded.args as Readonly<Record<string, unknown>>;
      return uint256Schema.parse(args.jobId).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readBasisPoints(
  client: ArcAgentJobViemClient,
  functionName: "platformFeeBP" | "evaluatorFeeBP",
): Promise<number> {
  return Number(basisPointsSchema.parse(await read(
    client,
    ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
    agenticCommerceAbi,
    functionName,
    [],
  )));
}

async function read(
  client: ArcAgentJobViemClient,
  address: string,
  abi: unknown,
  functionName: string,
  args: readonly unknown[],
): Promise<unknown> {
  return await client.readContract({ address, abi, functionName, args });
}

async function readAddress(
  client: ArcAgentJobViemClient,
  address: string,
  abi: unknown,
  functionName: string,
  args: readonly unknown[],
): Promise<string> {
  return addressSchema.parse(await read(client, address, abi, functionName, args));
}

function formatUsdcAtomic(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function createDefaultClient(): ArcAgentJobViemClient {
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
    getStorageAt: async (input) => await client.getStorageAt(input as never),
    getBytecode: async (input) => await client.getBytecode(input as never),
    getTransaction: async (input) => await client.getTransaction(input),
  };
}
