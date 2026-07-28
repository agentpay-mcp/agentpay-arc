import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_TESTNET,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION,
  erc8183AgenticCommerceAbi,
} from "@agentpay-ai/shared-arc";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
} from "viem";

import { createArcAgentJobViemReaders } from "./arc-agent-jobs-viem.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const EVALUATOR = "0x3333333333333333333333333333333333333333";
const HOOK = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const OTHER_HASH = `0x${"cd".repeat(32)}` as const;
const REASON_HASH = `0x${"ef".repeat(32)}` as const;

function verifiedProxy(options: {
  readonly implementation?: string;
  readonly bytecode?: `0x${string}` | undefined;
  readonly onStorageRead?: () => void;
  readonly onBytecodeRead?: () => void;
} = {}) {
  const implementation =
    options.implementation ?? ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION;
  return {
    async getStorageAt() {
      options.onStorageRead?.();
      return `0x${"0".repeat(24)}${implementation.slice(2)}` as const;
    },
    async getBytecode() {
      options.onBytecodeRead?.();
      return options.bytecode === undefined ? "0x6000" as const : options.bytecode;
    },
    async getTransaction() {
      throw new Error("unused");
    },
  };
}

describe("Arc ERC-8183 Viem reader", () => {
  it("reads the verified proxy, Arc USDC allowance, fees, and decoded job", async () => {
    const calls: Array<{
      readonly address: string;
      readonly functionName: string;
      readonly args: readonly unknown[];
    }> = [];
    let storageReads = 0;
    let bytecodeReads = 0;
    const { reader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy({
          onStorageRead: () => {
            storageReads += 1;
          },
          onBytecodeRead: () => {
            bytecodeReads += 1;
          },
        }),
        async readContract(input) {
          calls.push(input);
          switch (input.functionName) {
            case "getJob":
              return [
                7n,
                CLIENT,
                PROVIDER,
                EVALUATOR,
                "Ship the report",
                25_000_001n,
                4_102_444_800n,
                2,
                ZERO,
              ];
            case "paymentToken": return ARC_TESTNET.usdcAddress;
            case "platformFeeBP": return 25n;
            case "evaluatorFeeBP": return 75n;
            case "allowance": return 25_000_001n;
            default: throw new Error(`unexpected read: ${input.functionName}`);
          }
        },
        async getTransactionReceipt() {
          throw new Error("unused");
        },
      },
    });

    assert.deepEqual(await reader.getJob("7"), {
      id: "7",
      client: CLIENT,
      provider: PROVIDER,
      evaluator: EVALUATOR,
      description: "Ship the report",
      budget: "25.000001",
      expiredAt: "4102444800",
      state: "Submitted",
      hook: ZERO,
    });
    assert.equal(await reader.paymentToken(), ARC_TESTNET.usdcAddress);
    assert.equal(await reader.platformFeeBasisPoints(), 25);
    assert.equal(await reader.evaluatorFeeBasisPoints(), 75);
    assert.equal(
      await reader.usdcAllowance(CLIENT, ARC_TESTNET_ERC8183_AGENTIC_COMMERCE),
      "25000001",
    );

    for (const call of calls.filter((entry) => entry.functionName !== "allowance")) {
      assert.equal(call.address, ARC_TESTNET_ERC8183_AGENTIC_COMMERCE);
    }
    assert.equal(
      calls.find((entry) => entry.functionName === "allowance")?.address,
      ARC_TESTNET.usdcAddress,
    );
    assert.equal(storageReads, 5, "every ABI-dependent read must refresh the ERC-1967 slot");
    assert.equal(bytecodeReads, 5, "every ABI-dependent read must refresh implementation bytecode");
  });

  it("rejects a proxy upgrade that happens after an earlier successful read", async () => {
    let implementation: string =
      ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION;
    let contractReads = 0;
    const { reader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async getStorageAt() {
          return `0x${"0".repeat(24)}${implementation.slice(2)}` as const;
        },
        async readContract() {
          contractReads += 1;
          return ARC_TESTNET.usdcAddress;
        },
        async getTransactionReceipt() {
          throw new Error("unused");
        },
      },
    });

    assert.equal(await reader.paymentToken(), ARC_TESTNET.usdcAddress);
    implementation = "0x5555555555555555555555555555555555555555";
    await assert.rejects(reader.paymentToken(), /ABI re-verification/i);
    assert.equal(contractReads, 1, "the upgraded proxy must fail before another ABI read");
  });

  it("allows only the verified zero hook without inventing an onchain getter", async () => {
    let reads = 0;
    const { reader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          reads += 1;
          throw new Error("hook policy must not depend on an unverified getter");
        },
        async getTransactionReceipt() {
          throw new Error("unused");
        },
      },
    });

    assert.equal(await reader.isHookWhitelisted(ZERO), true);
    assert.equal(await reader.isHookWhitelisted(HOOK), false);
    assert.equal(reads, 0);
  });

  it("fails closed when the ERC-1967 implementation no longer matches the verified ABI", async () => {
    let contractReads = 0;
    const { reader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy({
          implementation: "0x5555555555555555555555555555555555555555",
        }),
        async readContract() {
          contractReads += 1;
          return ARC_TESTNET.usdcAddress;
        },
        async getTransactionReceipt() {
          throw new Error("unused");
        },
      },
    });

    await assert.rejects(reader.isHookWhitelisted(ZERO), /ABI re-verification/i);
    assert.equal(contractReads, 0, "an upgraded proxy must be refused before using the cached ABI");
  });
});

describe("Arc ERC-8183 Viem proof reader", () => {
  it("accepts the Circle transaction result and decodes JobCreated from the exact target", async () => {
    const abi = parseAbi([...erc8183AgenticCommerceAbi]);
    const topics = encodeEventTopics({
      abi,
      eventName: "JobCreated",
      args: { jobId: 7n, client: CLIENT, provider: PROVIDER },
    });
    const data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
      ],
      [EVALUATOR, 4_102_444_800n, ZERO],
    );
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt(input) {
          assert.equal(input.hash, TX_HASH);
          return {
            status: "success",
            transactionHash: TX_HASH,
            blockNumber: 123n,
            logs: [
              {
                address: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
                topics,
                data,
              },
            ],
          };
        },
        async getTransaction(input) {
          assert.equal(input.hash, TX_HASH);
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi,
              functionName: "createJob",
              args: [PROVIDER, EVALUATOR, 4_102_444_800n, "Ship the report", ZERO],
            }),
          };
        },
      },
    });

    assert.deepEqual(
      await proofReader.proveMutation(
        {
          id: "circle-tx-7",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship the report", ZERO],
        },
      ),
      {
        transactionHash: TX_HASH,
        blockNumber: "123",
        jobId: "7",
      },
    );
  });

  it("validates an expected job id from an exact-target mutation log", async () => {
    const expectedJobTopic =
      `0x${7n.toString(16).padStart(64, "0")}` as const;
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt(input) {
          if (input.hash === OTHER_HASH) {
            return {
              status: "reverted",
              transactionHash: OTHER_HASH,
              blockNumber: 125n,
              logs: [],
            };
          }
          return {
            status: "success",
            transactionHash: TX_HASH,
            blockNumber: 124n,
            logs: [{
              address: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
              topics: [OTHER_HASH, expectedJobTopic],
              data: "0x",
            }],
          };
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi: parseAbi([...erc8183AgenticCommerceAbi]),
              functionName: "setBudget",
              args: [7n, 25_000_000n, "0x"],
            }),
          };
        },
      },
    });

    assert.deepEqual(
      await proofReader.proveMutation(
        {
          id: "circle-tx-8",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          jobId: "7",
          functionSignature: "setBudget(uint256,uint256,bytes)",
          parameters: ["7", "25000000", "0x"],
        },
      ),
      {
        transactionHash: TX_HASH,
        blockNumber: "124",
        jobId: "7",
      },
    );
    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-8",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          jobId: "8",
          functionSignature: "setBudget(uint256,uint256,bytes)",
          parameters: ["8", "25000000", "0x"],
        },
      ),
      /transaction input/i,
    );
  });

  it("rejects another job even when a different log field equals the expected id", async () => {
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX_HASH,
            blockNumber: 124n,
            logs: [{
              address: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
              topics: [OTHER_HASH, toWord(8n)],
              data: toWord(7n),
            }],
          };
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi: parseAbi([...erc8183AgenticCommerceAbi]),
              functionName: "setBudget",
              args: [8n, 7n, "0x"],
            }),
          };
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-other-job",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          jobId: "7",
          functionSignature: "setBudget(uint256,uint256,bytes)",
          parameters: ["7", "25000000", "0x"],
        },
      ),
      /transaction input/i,
    );
  });

  it("rejects a different lifecycle operation on the same job", async () => {
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          throw new Error("wrong operation must fail before receipt proofing");
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi: parseAbi([...erc8183AgenticCommerceAbi]),
              functionName: "reject",
              args: [7n, REASON_HASH, "0x"],
            }),
          };
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-wrong-operation",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          jobId: "7",
          functionSignature: "complete(uint256,bytes32,bytes)",
          parameters: ["7", REASON_HASH, "0x"],
        },
      ),
      /transaction input/i,
    );
  });

  it("rejects createJob calldata whose participants differ from the expected job", async () => {
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          throw new Error("wrong create args must fail before receipt proofing");
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi: parseAbi([...erc8183AgenticCommerceAbi]),
              functionName: "createJob",
              args: [HOOK, EVALUATOR, 4_102_444_800n, "Ship", ZERO],
            }),
          };
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-wrong-create",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship", ZERO],
        },
      ),
      /transaction input/i,
    );
  });

  it("proves a USDC approval by exact token target without inventing a job id", async () => {
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX_HASH,
            blockNumber: 125n,
            logs: [{
              address: ARC_TESTNET.usdcAddress,
              topics: [OTHER_HASH],
              data: "0x",
            }],
          };
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET.usdcAddress,
            input: encodeFunctionData({
              abi: parseAbi([
                "function approve(address spender,uint256 amount) returns (bool)",
              ]),
              functionName: "approve",
              args: [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, 25_000_000n],
            }),
          };
        },
      },
    });

    assert.deepEqual(
      await proofReader.proveMutation(
        {
          id: "circle-approval",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET.usdcAddress,
          functionSignature: "approve(address,uint256)",
          parameters: [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, "25000000"],
        },
      ),
      {
        transactionHash: TX_HASH,
        blockNumber: "125",
      },
    );
  });

  it("rejects approval calldata with the wrong spender or amount", async () => {
    const maxUint = (1n << 256n) - 1n;
    for (const [spender, amount] of [
      [HOOK, 25_000_000n],
      [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, 1n],
      [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, maxUint],
    ] as const) {
      const { proofReader } = createArcAgentJobViemReaders({
        client: {
          ...verifiedProxy(),
          async readContract() {
            throw new Error("unused");
          },
          async getTransactionReceipt() {
            throw new Error("receipt must not be read");
          },
          async getTransaction() {
            return {
              to: ARC_TESTNET.usdcAddress,
              input: encodeFunctionData({
                abi: parseAbi([
                  "function approve(address spender,uint256 amount) returns (bool)",
                ]),
                functionName: "approve",
                args: [spender, amount],
              }),
            };
          },
        },
      });

      await assert.rejects(
        proofReader.proveMutation(
          {
            id: "circle-wrong-approval",
            state: "COMPLETE",
            blockchain: "ARC-TESTNET",
            txHash: TX_HASH,
          },
          {
            contract: ARC_TESTNET.usdcAddress,
            functionSignature: "approve(address,uint256)",
            parameters: [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, "25000000"],
          },
        ),
        /transaction input/i,
      );
    }
  });

  it("fails closed for missing hashes, reverted receipts, and wrong-target logs", async () => {
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy(),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX_HASH,
            blockNumber: 125n,
            logs: [{
              address: HOOK,
              topics: [OTHER_HASH],
              data: "0x",
            }],
          };
        },
        async getTransaction() {
          return {
            to: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
            input: encodeFunctionData({
              abi: parseAbi([...erc8183AgenticCommerceAbi]),
              functionName: "createJob",
              args: [PROVIDER, EVALUATOR, 4_102_444_800n, "Ship", ZERO],
            }),
          };
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        { id: "circle-tx-9", state: "COMPLETE", blockchain: "ARC-TESTNET" },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship", ZERO],
        },
      ),
      /transaction hash/i,
    );
    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-9",
          state: "FAILED",
          blockchain: "ARC-TESTNET",
          txHash: OTHER_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship", ZERO],
        },
      ),
      /successful receipt/i,
    );
    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-9",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship", ZERO],
        },
      ),
      /target contract log/i,
    );
  });

  it("refuses proofing when the verified implementation has no bytecode", async () => {
    let receiptReads = 0;
    const { proofReader } = createArcAgentJobViemReaders({
      client: {
        ...verifiedProxy({ bytecode: "0x" }),
        async readContract() {
          throw new Error("unused");
        },
        async getTransactionReceipt() {
          receiptReads += 1;
          throw new Error("must not fetch a receipt for an unverified implementation");
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-10",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TX_HASH,
        },
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          functionSignature: "createJob(address,address,uint256,string,address)",
          parameters: [PROVIDER, EVALUATOR, "4102444800", "Ship", ZERO],
        },
      ),
      /ABI re-verification/i,
    );
    assert.equal(receiptReads, 0);
  });
});

function toWord(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
