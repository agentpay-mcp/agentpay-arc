import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_TESTNET,
  getStableTokenAddress,
} from "@agentpay-ai/shared-arc";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  type Hex,
} from "viem";

import {
  createArcSwapSettlementViemVerifier,
  type ArcSwapSettlementViemClient,
} from "./arc-swap-settlement-viem.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const txHash = `0x${"a".repeat(64)}` as Hex;
const arcUsdcAddress = getStableTokenAddress(ARC_TESTNET.chainId, "USDC");
const arcEurcAddress = getStableTokenAddress(ARC_TESTNET.chainId, "EURC");
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);

describe("createArcSwapSettlementViemVerifier", () => {
  it("proves the exact inbound buy-token amount from successful receipts", async () => {
    let receiptReads = 0;
    const client: ArcSwapSettlementViemClient = {
      async getTransactionReceipt() {
        receiptReads += 1;
        return {
          status: "success",
          transactionHash: txHash,
          blockNumber: 42n,
          logs: [
            {
              address: arcUsdcAddress,
              topics: encodeEventTopics({
                abi: [transferEvent],
                eventName: "Transfer",
                args: { from: sender, to: wallet },
              }),
              data: encodeAbiParameters([{ type: "uint256" }], [1_250_000n]),
            },
            {
              address: arcEurcAddress,
              topics: encodeEventTopics({
                abi: [transferEvent],
                eventName: "Transfer",
                args: { from: sender, to: wallet },
              }),
              data: encodeAbiParameters([{ type: "uint256" }], [9_000_000n]),
            },
          ],
        };
      },
    };
    const verifier = createArcSwapSettlementViemVerifier({ client });

    assert.deepEqual(
      await verifier.verify({
        walletAddress: wallet,
        buyToken: "USDC",
        transactions: [
          {
            id: "circle_tx_1",
            state: "COMPLETE",
            blockchain: "ARC-TESTNET",
            txHash,
          },
          {
            id: "circle_tx_duplicate",
            state: "COMPLETE",
            blockchain: "ARC-TESTNET",
            txHash,
          },
        ],
      }),
      {
        status: "MINED",
        transactionHash: txHash,
        actualReceivedAtomic: "1250000",
        blockNumber: "42",
      },
    );
    assert.equal(receiptReads, 1, "duplicate Circle transaction rows must not double-count settlement");
  });

  it("returns PENDING without inventing settlement when a receipt is unavailable", async () => {
    const verifier = createArcSwapSettlementViemVerifier({
      client: { async getTransactionReceipt() { return null; } },
    });

    assert.deepEqual(
      await verifier.verify({
        walletAddress: wallet,
        buyToken: "EURC",
        transactions: [
          {
            id: "circle_tx_2",
            state: "PENDING",
            blockchain: "ARC-TESTNET",
            txHash,
          },
        ],
      }),
      { status: "PENDING", transactionHash: txHash },
    );
  });

  it("returns UNAVAILABLE for missing hashes, reverted receipts, or malformed proof data", async () => {
    const missingHash = createArcSwapSettlementViemVerifier({
      client: { async getTransactionReceipt() { throw new Error("must not run"); } },
    });
    assert.deepEqual(
      await missingHash.verify({
        walletAddress: wallet,
        buyToken: "USDC",
        transactions: [
          { id: "circle_tx_3", state: "PENDING", blockchain: "ARC-TESTNET" },
        ],
      }),
      { status: "UNAVAILABLE" },
    );

    const reverted = createArcSwapSettlementViemVerifier({
      client: {
        async getTransactionReceipt() {
          return {
            status: "reverted",
            transactionHash: txHash,
            blockNumber: 42n,
            logs: [],
          };
        },
      },
    });
    assert.deepEqual(
      await reverted.verify({
        walletAddress: wallet,
        buyToken: "USDC",
        transactions: [
          {
            id: "circle_tx_4",
            state: "FAILED",
            blockchain: "ARC-TESTNET",
            txHash,
          },
        ],
      }),
      { status: "UNAVAILABLE", transactionHash: txHash },
    );
  });
});
