import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArcPaymentReceiptRecord,
  CircleAgentWallet,
} from "@agentpay-ai/shared-arc";

import {
  batchPayoutTool,
  createBatchPayoutHandler,
  createSendUsdcHandler,
  type ArcPaymentRepository,
  sendUsdcTool,
} from "./arc-payments.ts";
import {
  baseReceipt,
  BATCH_ID,
  BATCH_KEY,
  completeTransaction,
  fakeCircleCli,
  fixedClock,
  memoryRepository,
  RECEIPT_ID,
  RECIPIENT_A,
  RECIPIENT_B,
  TX_HASH_A,
  TX_HASH_B,
  usdcBalance,
  WALLET,
} from "./arc-payments.test-support.ts";

describe("Arc payment tools", () => {
  it("publishes isolated send_usdc and batch_payout schemas", () => {
    assert.equal(sendUsdcTool.name, "send_usdc");
    assert.equal(batchPayoutTool.name, "batch_payout");
    assert.equal(sendUsdcTool.inputSchema.additionalProperties, false);
    assert.equal(batchPayoutTool.inputSchema.additionalProperties, false);
  });

  it("rejects invalid addresses, non-Arc chains, and non-six-decimal amounts before dependencies", async () => {
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli(),
      payments: memoryRepository(),
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({ idempotencyKey: RECEIPT_ID, recipient: "0x1234", amount: "1" }),
      /address/i,
    );
    await assert.rejects(
      () => handler({ idempotencyKey: RECEIPT_ID, recipient: RECIPIENT_A, amount: "1.0000001" }),
      /six|decimal|precision/i,
    );
    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "1",
        chain: "ETH-SEPOLIA",
      }),
      /ARC-TESTNET|invalid/i,
    );
  });

  it("checks the selected wallet balance and rejects insufficient USDC without transfer", async () => {
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        getBalance: async () => usdcBalance("1"),
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_A);
        },
      }),
      payments: memoryRepository(),
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "1.000001",
        purpose: "Invoice INV-1",
      }),
      /insufficient/i,
    );
    assert.equal(transfers, 0);
  });

  it("persists transaction identity before completion and invokes Circle transfer exactly once", async () => {
    const events: string[] = [];
    let transfers = 0;
    const repository = memoryRepository(events);
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async (input) => {
          transfers += 1;
          assert.deepEqual(input, {
            address: WALLET,
            amount: "2.5",
            recipient: RECIPIENT_A,
          });
          return completeTransaction("circle_tx_1", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      idempotencyKey: RECEIPT_ID,
      walletAddress: WALLET,
      recipient: RECIPIENT_A,
      amount: "2.5",
      chain: "ARC-TESTNET",
      token: "USDC",
      purpose: "Invoice INV-1",
    });

    assert.equal(transfers, 1);
    assert.deepEqual(events.filter((event) => event.startsWith("receipt:")), [
      "receipt:SUBMITTING",
      "receipt:SUBMITTED:circle_tx_1",
      "receipt:COMPLETED:circle_tx_1",
    ]);
    assert.equal(output.receipt.status, "COMPLETED");
    assert.equal(output.receipt.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH_A}`);
  });

  it("returns a previously persisted receipt without retrying the mutation", async () => {
    const repository = memoryRepository();
    await repository.seedReceipt({
      ...baseReceipt(RECEIPT_ID),
      status: "SUBMITTED",
      transactionId: "circle_tx_existing",
      transactionHash: TX_HASH_A,
      explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
    });
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "2.5",
      purpose: "Invoice INV-1",
    });

    assert.equal(transfers, 0);
    assert.equal(output.receipt.transactionId, "circle_tx_existing");
    assert.equal(output.receipt.status, "SUBMITTED");
  });

  it("binds receipt replay to the currently authenticated selected wallet", async () => {
    const repository = memoryRepository();
    await repository.seedReceipt({
      ...baseReceipt(RECEIPT_ID),
      status: "SUBMITTED",
      transactionId: "circle_tx_existing",
    });
    let transfers = 0;
    const foreignWallet: CircleAgentWallet = {
      address: "0x9999999999999999999999999999999999999999",
      type: "agent",
      blockchain: "ARC-TESTNET",
    };
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [foreignWallet],
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        recipient: RECIPIENT_A,
        amount: "2.5",
        purpose: "Invoice INV-1",
      }),
      /wallet|authenticated|bound/i,
    );
    await assert.rejects(
      () => handler({
        idempotencyKey: RECEIPT_ID,
        walletAddress: WALLET,
        recipient: RECIPIENT_A,
        amount: "2.5",
        purpose: "Invoice INV-1",
      }),
      /authenticated Circle Agent Wallet/i,
    );
    assert.equal(transfers, 0);
  });

  it("surfaces reconciliation when transaction identity persistence fails after transfer", async () => {
    const stored: ArcPaymentReceiptRecord[] = [];
    let transfers = 0;
    const base = memoryRepository();
    const repository: ArcPaymentRepository = {
      ...base,
      async transitionReceipt(receipt, expectedStatus) {
        if (receipt.status === "SUBMITTED") {
          throw new Error("database unavailable");
        }
        stored.push(structuredClone(receipt));
        return base.transitionReceipt(receipt, expectedStatus);
      },
    };
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("circle_tx_unsafe_to_retry", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "1",
      purpose: "Persistence boundary",
    });
    assert.equal(transfers, 1);
    assert.equal(output.status, "SUBMITTING");
    assert.equal(output.reconciliationRequired, true);
    assert.match(output.reconciliationMessage ?? "", /do not retry|get_payment_receipt/i);
    assert.equal(output.reconciliationTransactionId, "circle_tx_unsafe_to_retry");
    assert.equal(output.reconciliationTransactionHash, TX_HASH_A);
    assert.deepEqual(stored.map((receipt) => receipt.status), []);
    assert.equal(
      (await base.getReceiptByIdempotencyKey(RECEIPT_ID))?.status,
      "SUBMITTING",
    );

    const replay = await handler({
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "1",
      purpose: "Persistence boundary",
    });
    assert.equal(transfers, 1);
    assert.equal(replay.reconciliationRequired, true);
  });

  it("marks an ambiguous Circle transfer error for reconciliation without retrying", async () => {
    const events: string[] = [];
    const repository = memoryRepository(events);
    let transfers = 0;
    const handler = createSendUsdcHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          throw new Error("Circle response was lost");
        },
      }),
      payments: repository,
      clock: fixedClock,
    });
    const input = {
      idempotencyKey: RECEIPT_ID,
      recipient: RECIPIENT_A,
      amount: "1",
      purpose: "Ambiguous transfer",
    };

    const first = await handler(input);
    const replay = await handler(input);

    assert.equal(transfers, 1);
    assert.equal(first.status, "RECONCILIATION_REQUIRED");
    assert.equal(first.reconciliationRequired, true);
    assert.equal(replay.status, "RECONCILIATION_REQUIRED");
    assert.equal(replay.reconciliationRequired, true);
    assert.ok(events.includes("activity:PAYMENT:RECONCILIATION_REQUIRED"));
  });

  it("returns exact persisted item states on partial batch failure", async () => {
    const events: string[] = [];
    const repository = memoryRepository(events);
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        getBalance: async () => usdcBalance("10"),
        transfer: async ({ recipient }) => {
          transfers += 1;
          if (recipient === RECIPIENT_A) {
            return completeTransaction("circle_tx_a", TX_HASH_A);
          }
          throw new Error("adapter unavailable");
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [
        { recipient: RECIPIENT_A, amount: "1", purpose: "A" },
        { recipient: RECIPIENT_B, amount: "2", purpose: "B" },
      ],
    });

    assert.equal(transfers, 2);
    assert.equal(output.batch.status, "PARTIAL");
    assert.deepEqual(output.batch.items.map((item) => item.status), ["COMPLETED", "FAILED"]);
    assert.equal(output.batch.items[0]?.transactionId, "circle_tx_a");
    assert.equal(output.batch.items[0]?.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH_A}`);
    assert.equal(output.batch.items[1]?.transactionId, undefined);
    assert.match(output.batch.items[1]?.errorMessage ?? "", /adapter unavailable/i);
    assert.ok(events.indexOf("item:0:SUBMITTED:circle_tx_a") < events.indexOf("item:0:COMPLETED:circle_tx_a"));
  });

  it("resumes only pristine PENDING items and never retries an item with a transaction ID", async () => {
    const repository = memoryRepository();
    const batch = await repository.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "SUBMITTED",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      items: [
        {
          id: `${BATCH_ID}:0`,
          batchId: BATCH_ID,
          index: 0,
          recipient: RECIPIENT_A,
          amount: "1",
          purpose: "A",
          status: "SUBMITTED",
          transactionId: "circle_tx_existing",
          createdAt: fixedClock().toISOString(),
          updatedAt: fixedClock().toISOString(),
        },
        {
          id: `${BATCH_ID}:1`,
          batchId: BATCH_ID,
          index: 1,
          recipient: RECIPIENT_B,
          amount: "2",
          purpose: "B",
          status: "PENDING",
          createdAt: fixedClock().toISOString(),
          updatedAt: fixedClock().toISOString(),
        },
      ],
    });
    assert.equal(batch.items.length, 2);
    const transferred: string[] = [];
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async ({ recipient }) => {
          transferred.push(recipient);
          return completeTransaction("circle_tx_b", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [
        { recipient: RECIPIENT_A, amount: "1", purpose: "A" },
        { recipient: RECIPIENT_B, amount: "2", purpose: "B" },
      ],
    });

    assert.deepEqual(transferred, [RECIPIENT_B]);
    assert.equal(output.batch.items[0]?.transactionId, "circle_tx_existing");
    assert.equal(output.batch.items[1]?.status, "COMPLETED");
  });

  it("atomically claims each pending item so concurrent payouts transfer it once", async () => {
    const base = memoryRepository();
    await base.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "PENDING",
      items: [{
        id: `${BATCH_ID}:0`,
        batchId: BATCH_ID,
        index: 0,
        recipient: RECIPIENT_A,
        amount: "1",
        status: "PENDING",
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString(),
      }],
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    });
    let releaseInitialReads: (() => void) | undefined;
    const initialReadsReady = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let initialReads = 0;
    const repository: ArcPaymentRepository = {
      ...base,
      async getBatch(batchId) {
        const snapshot = await base.getBatch(batchId);
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) {
            releaseInitialReads?.();
          }
          await initialReadsReady;
        }
        return snapshot;
      },
    };
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("circle_tx_once", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });
    const input = {
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    };

    await Promise.all([handler(input), handler(input)]);

    const stored = await base.getBatch(BATCH_ID);
    assert.equal(transfers, 1);
    assert.equal(stored?.items[0]?.status, "COMPLETED");
    assert.equal(stored?.items[0]?.transactionId, "circle_tx_once");
  });

  it("never claims or transfers a hash-only ambiguous pending item", async () => {
    const repository = memoryRepository();
    await repository.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "PENDING",
      items: [{
        id: `${BATCH_ID}:0`,
        batchId: BATCH_ID,
        index: 0,
        recipient: RECIPIENT_A,
        amount: "1",
        status: "PENDING",
        transactionHash: TX_HASH_A,
        explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString(),
      }],
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    });
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const output = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    });

    assert.equal(transfers, 0);
    assert.equal(output.batch.items[0]?.transactionHash, TX_HASH_A);
    assert.equal(output.batch.items[0]?.status, "PENDING");
  });

  it("resumes by a matching batch idempotency key and rejects key reuse across batch IDs", async () => {
    const repository = memoryRepository();
    await repository.createBatch({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      walletAddress: WALLET,
      chain: "ARC-TESTNET",
      token: "USDC",
      status: "COMPLETED",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      items: [{
        id: `${BATCH_ID}:0`,
        batchId: BATCH_ID,
        index: 0,
        recipient: RECIPIENT_A,
        amount: "1",
        status: "COMPLETED",
        transactionId: "circle_tx_existing",
        transactionHash: TX_HASH_A,
        explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH_A}`,
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString(),
      }],
    });
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("unexpected", TX_HASH_B);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    const replay = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    });
    assert.equal(replay.status, "COMPLETED");

    await assert.rejects(
      () => handler({
        batchId: "c612a50c-89db-4de7-94ae-bc19ce2ff4a7",
        idempotencyKey: BATCH_KEY,
        payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
      }),
      /idempotency.*different|already bound/i,
    );
    assert.equal(transfers, 0);
  });

  it("fails closed when a submitted batch transaction identity cannot be persisted", async () => {
    const storedStatuses: string[] = [];
    const base = memoryRepository();
    let failTransactionIdentityWrite = true;
    const repository: ArcPaymentRepository = {
      ...base,
      async saveBatchItem(item) {
        storedStatuses.push(`${item.status}:${item.transactionId ?? "CLAIMED"}`);
        if (item.status === "SUBMITTED" && item.transactionId && failTransactionIdentityWrite) {
          failTransactionIdentityWrite = false;
          throw new Error("database unavailable");
        }
        return base.saveBatchItem(item);
      },
    };
    let transfers = 0;
    const handler = createBatchPayoutHandler({
      circleCli: fakeCircleCli({
        transfer: async () => {
          transfers += 1;
          return completeTransaction("circle_tx_unsafe_to_retry", TX_HASH_A);
        },
      }),
      payments: repository,
      clock: fixedClock,
    });

    await assert.rejects(
      () => handler({
        batchId: BATCH_ID,
        idempotencyKey: BATCH_KEY,
        payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
      }),
      /database unavailable/i,
    );
    const resumed = await handler({
      batchId: BATCH_ID,
      idempotencyKey: BATCH_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    });

    assert.equal(transfers, 1);
    assert.equal(resumed.batch.status, "SUBMITTED");
    assert.equal(resumed.batch.items[0]?.status, "SUBMITTED");
    assert.equal(resumed.batch.items[0]?.transactionId, undefined);
    assert.deepEqual(storedStatuses, ["SUBMITTED:circle_tx_unsafe_to_retry"]);
  });
});
