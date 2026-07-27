import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
} from "viem";

import {
  ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
  erc8004IdentityAbi,
} from "@agentpay-ai/shared-arc";

import { createArcErc8004ViemReaders } from "./arc-erc8004-viem.ts";

const owner = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const validator = "0x3333333333333333333333333333333333333333";
const hash = `0x${"a".repeat(64)}` as const;
const requestHash = `0x${"b".repeat(64)}` as const;
const zeroHash = `0x${"0".repeat(64)}` as const;

describe("Arc ERC-8004 Viem readers", () => {
  it("reads deployed registry state and transparent summaries", async () => {
    const calls: string[] = [];
    const { reader } = createArcErc8004ViemReaders({
      client: {
        async readContract(input) {
          calls.push(input.functionName);
          switch (input.functionName) {
            case "ownerOf": return owner;
            case "tokenURI": return "ipfs://bafy-agent";
            case "getAgentWallet": return wallet;
            case "getApproved": return validator;
            case "isApprovedForAll": return true;
            case "getValidationStatus":
              return [validator, 42n, 80, requestHash, "kyc", 123n];
            case "getSummary":
              return input.address === "0x8004B663056A597Dffe9eCcC1965A193B7388713"
                ? [2n, 195n, 2]
                : [3n, 90];
            default: throw new Error("unexpected read");
          }
        },
        async getTransactionReceipt() {
          throw new Error("unused");
        },
      },
    });

    assert.equal(await reader.ownerOf("42"), owner);
    assert.equal(await reader.tokenURI("42"), "ipfs://bafy-agent");
    assert.equal(await reader.getAgentWallet("42"), wallet);
    assert.equal(await reader.getApproved("42"), validator);
    assert.equal(await reader.isApprovedForAll(owner, validator), true);
    assert.deepEqual(await reader.getValidationStatus(requestHash), {
      exists: true,
      validatorAddress: validator,
      agentId: "42",
      response: 80,
      responseHash: requestHash,
      tag: "kyc",
      lastUpdate: "123",
      hasResponse: true,
    });
    assert.deepEqual(
      await reader.getReputationSummary("42", [owner], "payment", "settled"),
      { count: "2", summaryValue: "195", summaryValueDecimals: 2 },
    );
    assert.deepEqual(
      await reader.getValidationSummary("42", [validator], "kyc"),
      { count: "3", averageResponse: 90 },
    );
    assert.ok(calls.includes("getSummary"));
  });

  it("proves the expected registry event from a successful Arc receipt", async () => {
    const abi = parseAbi([...erc8004IdentityAbi]);
    const topics = encodeEventTopics({
      abi,
      eventName: "Registered",
      args: { agentId: 42n, owner },
    });
    const data = encodeAbiParameters([{ type: "string" }], ["ipfs://bafy-agent"]);
    const { proofReader } = createArcErc8004ViemReaders({
      client: {
        async readContract() {
          return zeroHash;
        },
        async getTransactionReceipt() {
          return {
            status: "success",
            transactionHash: hash,
            blockNumber: 123n,
            logs: [{
              address: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
              topics,
              data,
            }],
          };
        },
      },
    });

    assert.deepEqual(
      await proofReader.proveMutation(
        {
          id: "circle-tx-1",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: hash,
        },
        {
          registry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          event: "Registered",
          expectedArgs: {
            owner,
            agentURI: "ipfs://bafy-agent",
          },
        },
      ),
      {
        transactionHash: hash,
        blockNumber: "123",
        agentId: "42",
      },
    );
    await assert.rejects(
      proofReader.proveMutation(
        {
          id: "circle-tx-1",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: hash,
        },
        {
          registry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          event: "Registered",
          expectedArgs: {
            owner,
            agentURI: "ipfs://different-agent",
          },
        },
      ),
      /event proof/,
    );
  });

  it("fails closed for missing hashes, reverted receipts, and mismatched events", async () => {
    const { proofReader } = createArcErc8004ViemReaders({
      client: {
        async readContract() {
          return zeroHash;
        },
        async getTransactionReceipt() {
          return {
            status: "reverted",
            transactionHash: hash,
            blockNumber: 123n,
            logs: [],
          };
        },
      },
    });

    await assert.rejects(
      proofReader.proveMutation(
        { id: "tx", state: "FAILED", blockchain: "ARC-TESTNET" },
        {
          registry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          event: "Registered",
          expectedArgs: { owner, agentURI: "ipfs://bafy-agent" },
        },
      ),
      /transaction hash/,
    );
    await assert.rejects(
      proofReader.proveMutation(
        { id: "tx", state: "COMPLETE", blockchain: "ARC-TESTNET", txHash: hash },
        {
          registry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          event: "Registered",
          expectedArgs: { owner, agentURI: "ipfs://bafy-agent" },
        },
      ),
      /successful receipt/,
    );
  });
});
