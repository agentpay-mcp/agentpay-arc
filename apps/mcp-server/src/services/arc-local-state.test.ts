import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createArcLocalStateRepositories,
} from "./arc-local-state.ts";

const createdAt = "2026-07-28T00:00:00.000Z";
const updatedAt = "2026-07-28T00:01:00.000Z";
const wallet = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";
const transactionHash = `0x${"a".repeat(64)}`;

async function tempFile(name: string): Promise<string> {
  const directory = join(
    tmpdir(),
    `agentpay-arc-local-${process.pid}-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  return join(directory, name);
}

function receipt() {
  return {
    id,
    idempotencyKey: id,
    walletAddress: wallet,
    recipient,
    amount: "1.25",
    token: "USDC" as const,
    chain: "ARC-TESTNET" as const,
    purpose: "Pay local agent",
    status: "SUBMITTING" as const,
    createdAt,
    updatedAt: createdAt,
  };
}

function liquidityOperation() {
  return {
    id: secondId,
    kind: "SWAP" as const,
    inputFingerprint: "b".repeat(64),
    status: "SUBMITTING" as const,
    walletAddress: wallet,
    quoteExpiresAt: "2026-07-28T00:05:00.000Z",
    steps: [],
    createdAt,
    updatedAt: createdAt,
  };
}

describe("Arc process-local durable state", () => {
  it("persists payment, request, activity, and receipt state across factories with immutable reads", async () => {
    const filePath = await tempFile("state.json");
    const first = createArcLocalStateRepositories({ filePath });

    assert.equal((await first.payments.claimReceipt(receipt())).claimed, true);
    await first.paymentRequests.save({
      id: secondId,
      idempotencyKey: secondId,
      recipient,
      amount: "2",
      token: "USDC",
      chain: "ARC-TESTNET",
      purpose: "Invoice",
      status: "OPEN",
      expiresAt: "2026-07-29T00:00:00.000Z",
      createdAt,
      updatedAt: createdAt,
    });
    await first.payments.appendActivity({
      id: "activity-1",
      type: "PAYMENT",
      status: "SUBMITTING",
      referenceId: id,
      metadata: { amount: "1.25" },
      createdAt,
    });

    const second = createArcLocalStateRepositories({ filePath });
    const stored = await second.receipts.getPaymentReceipt(id);
    assert.equal(stored?.purpose, "Pay local agent");
    assert.equal((await second.paymentRequests.getById(secondId))?.status, "OPEN");
    assert.equal((await second.activity.listAgentActivity({ limit: 10 })).length, 2);

    (stored as { purpose: string }).purpose = "mutated";
    assert.equal(
      (await second.receipts.getPaymentReceipt(id))?.purpose,
      "Pay local agent",
    );
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
  });

  it("serializes receipt claims across factories and enforces transition conflicts", async () => {
    const filePath = await tempFile("state.json");
    const left = createArcLocalStateRepositories({ filePath });
    const right = createArcLocalStateRepositories({ filePath });

    const claims = await Promise.all([
      left.payments.claimReceipt(receipt()),
      right.payments.claimReceipt(receipt()),
    ]);
    assert.equal(claims.filter(({ claimed }) => claimed).length, 1);
    const claimedActivity = await left.activity.listAgentActivity({ limit: 10 });
    assert.equal(claimedActivity.length, 1);
    assert.equal(claimedActivity[0]?.metadata.event, "PAYMENT_CLAIMED");

    await assert.rejects(
      left.payments.claimReceipt({ ...receipt(), amount: "9" }),
      /conflict/i,
    );
    const submitted = await left.payments.transitionReceipt(
      {
        ...receipt(),
        status: "SUBMITTED",
        transactionId: "circle-tx-1",
        transactionHash,
        updatedAt,
      },
      "SUBMITTING",
    );
    assert.equal(submitted.status, "SUBMITTED");
    const transitionedActivity = await left.activity.listAgentActivity({ limit: 10 });
    assert.equal(transitionedActivity.length, 2);
    assert.equal(
      transitionedActivity[0]?.metadata.event,
      "PAYMENT_TRANSITIONED",
    );
    assert.equal(transitionedActivity[0]?.metadata.previousStatus, "SUBMITTING");
    await assert.rejects(
      right.payments.transitionReceipt(
        { ...submitted, status: "FAILED", updatedAt },
        "SUBMITTING",
      ),
      /transition conflict/i,
    );
  });

  it("waits for the cross-process lock before claiming a mutation", async () => {
    const filePath = await tempFile("state.json");
    const lockPath = `${filePath}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }));
    await lock.sync();
    const repositories = createArcLocalStateRepositories({ filePath });
    let settled = false;
    const claim = repositories.payments.claimReceipt(receipt()).then((result) => {
      settled = true;
      return result;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        settled,
        false,
        "a process-local queue must not bypass an existing filesystem lock",
      );
    } finally {
      await lock.close();
      await unlink(lockPath);
    }

    assert.equal((await claim).claimed, true);
  });

  it("recovers a stale lock only after its owner process is gone", async () => {
    const filePath = await tempFile("state.json");
    const lockPath = `${filePath}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: crypto.randomUUID(),
      createdAt: "2020-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const stale = new Date("2020-01-01T00:00:00.000Z");
    await utimes(lockPath, stale, stale);

    const repositories = createArcLocalStateRepositories({ filePath });
    assert.equal((await repositories.payments.claimReceipt(receipt())).claimed, true);
    await assert.rejects(lstat(lockPath), /ENOENT/);
  });

  it("recovers malformed stale locks but preserves a live stale owner", async () => {
    const malformedPath = await tempFile("malformed-state.json");
    const malformedLockPath = `${malformedPath}.lock`;
    await writeFile(malformedLockPath, "not-json", { mode: 0o600 });
    const stale = new Date("2020-01-01T00:00:00.000Z");
    await utimes(malformedLockPath, stale, stale);
    assert.equal(
      (await createArcLocalStateRepositories({ filePath: malformedPath })
        .payments.claimReceipt(receipt())).claimed,
      true,
    );

    const livePath = await tempFile("live-state.json");
    const liveLockPath = `${livePath}.lock`;
    const liveLock = await open(liveLockPath, "wx", 0o600);
    await liveLock.writeFile(JSON.stringify({
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    await liveLock.sync();
    await utimes(liveLockPath, stale, stale);
    let settled = false;
    const claim = createArcLocalStateRepositories({ filePath: livePath })
      .payments.claimReceipt({ ...receipt(), id: secondId, idempotencyKey: secondId })
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false);
    } finally {
      await liveLock.close();
      await unlink(liveLockPath);
    }
    assert.equal((await claim).claimed, true);
  });

  it("refuses a symbolic mutation lock and invalid state bounds", async () => {
    const filePath = await tempFile("state.json");
    const lockTarget = `${filePath}.lock-target`;
    await writeFile(lockTarget, "not a lock");
    await symlink(lockTarget, `${filePath}.lock`);
    await assert.rejects(
      createArcLocalStateRepositories({ filePath })
        .payments.claimReceipt(receipt()),
      /mutation lock.*regular file/i,
    );
    for (const maxFileBytes of [0, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createArcLocalStateRepositories({ filePath, maxFileBytes }),
        /positive safe integer/i,
      );
    }
    const directoryPath = await tempFile("state-directory");
    await mkdir(directoryPath);
    await assert.rejects(
      createArcLocalStateRepositories({ filePath: directoryPath })
        .payments.getReceiptByIdempotencyKey(id),
      /regular file/i,
    );
  });

  it("treats equivalent EVM address casing as the same idempotent payment", async () => {
    const filePath = await tempFile("state.json");
    const repositories = createArcLocalStateRepositories({ filePath });
    const mixedCaseReceipt = {
      ...receipt(),
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabce",
    };
    assert.equal(
      (await repositories.payments.claimReceipt(mixedCaseReceipt)).claimed,
      true,
    );
    assert.equal(
      (await repositories.payments.claimReceipt({
        ...mixedCaseReceipt,
        walletAddress: mixedCaseReceipt.walletAddress.toUpperCase().replace("0X", "0x"),
        recipient: mixedCaseReceipt.recipient.toUpperCase().replace("0X", "0x"),
      })).claimed,
      false,
    );
  });

  it("binds payment-request receipt ids only during the OPEN to PAID transition", async () => {
    const filePath = await tempFile("state.json");
    const repositories = createArcLocalStateRepositories({ filePath });
    const request = {
      id: secondId,
      idempotencyKey: secondId,
      recipient,
      amount: "2",
      token: "USDC" as const,
      chain: "ARC-TESTNET" as const,
      purpose: "Invoice",
      status: "OPEN" as const,
      expiresAt: "2026-07-29T00:00:00.000Z",
      createdAt,
      updatedAt: createdAt,
    };
    await repositories.paymentRequests.save(request);

    await assert.rejects(
      repositories.paymentRequests.save({
        ...request,
        receiptId: id,
        updatedAt,
      }),
      /transition conflict/i,
    );
    const paid = await repositories.paymentRequests.save({
      ...request,
      status: "PAID",
      receiptId: id,
      updatedAt,
    });
    assert.equal(paid.receiptId, id);
    await assert.rejects(
      repositories.paymentRequests.save({
        ...paid,
        status: "OPEN",
      }),
      /transition conflict/i,
    );
  });

  it("resumes a durable batch through claim, item completion, and batch completion", async () => {
    const filePath = await tempFile("state.json");
    const repositories = createArcLocalStateRepositories({ filePath });
    const item = {
      id: `${thirdId}:0`,
      batchId: thirdId,
      index: 0,
      recipient,
      amount: "3",
      purpose: "Batch item",
      status: "PENDING" as const,
      createdAt,
      updatedAt: createdAt,
    };
    const batch = {
      batchId: thirdId,
      idempotencyKey: thirdId,
      walletAddress: wallet,
      chain: "ARC-TESTNET" as const,
      token: "USDC" as const,
      status: "PENDING" as const,
      items: [item],
      createdAt,
      updatedAt: createdAt,
    };
    await assert.rejects(
      repositories.payments.claimBatchItem({
        ...item,
        status: "SUBMITTED",
        updatedAt,
      }),
      /batch was not found/i,
    );
    assert.equal((await repositories.payments.createBatch(batch)).status, "PENDING");
    assert.equal(
      (await repositories.payments.getBatchByIdempotencyKey(thirdId))?.batchId,
      thirdId,
    );
    assert.equal((await repositories.payments.createBatch(batch)).batchId, thirdId);

    const claimed = await repositories.payments.claimBatchItem({
      ...item,
      status: "SUBMITTED",
      updatedAt,
    });
    assert.equal(claimed?.status, "SUBMITTED");
    assert.equal(await repositories.payments.claimBatchItem({
      ...item,
      status: "SUBMITTED",
      updatedAt,
    }), null);
    const submitted = await repositories.payments.saveBatchItem({
      ...claimed!,
      transactionId: "circle-batch-1",
      transactionHash,
    });
    await repositories.payments.saveBatchItem({
      ...submitted,
      status: "COMPLETED",
    });
    const persisted = await repositories.payments.getBatch(thirdId);
    assert.equal(persisted?.items[0]?.status, "COMPLETED");
    const completed = await repositories.payments.saveBatch({
      ...persisted!,
      status: "COMPLETED",
      updatedAt,
    });
    assert.equal(completed.status, "COMPLETED");
  });

  it("persists commerce, liquidity, identity, jobs, and compliance with replay guards", async () => {
    const filePath = await tempFile("state.json");
    const repositories = createArcLocalStateRepositories({ filePath });
    const commerceReceipt = {
      idempotencyKey: id,
      buyerAgentId: "buyer",
      sellerAgentId: "seller",
      serviceUrl: "https://service.example/pay",
      requestHash: `0x${"b".repeat(64)}`,
      quoteHash: `0x${"c".repeat(64)}`,
      inspectedAmountAtomic: "1000000",
      maxAmount: "1",
      walletAddress: wallet,
      paymentIdentifier: "agentpay-11111111111141118111111111111111",
      status: "CLAIMED" as const,
      createdAt,
      updatedAt: createdAt,
    };
    assert.equal((await repositories.commerce.claim(commerceReceipt)).claimed, true);
    assert.equal((await repositories.commerce.claim(commerceReceipt)).claimed, false);
    const settled = await repositories.commerce.complete(
      {
        ...commerceReceipt,
        status: "SETTLED",
        settlementResult: { status: "settled" },
        proof: {
          network: "eip155:5042002",
          scheme: "exact",
          seller: recipient,
          transaction: transactionHash,
          payer: wallet,
        },
        updatedAt,
      },
      "CLAIMED",
    );
    assert.equal(settled.status, "SETTLED");

    assert.equal(
      (await repositories.liquidity.claim(liquidityOperation())).claimed,
      true,
    );
    await repositories.liquidity.transition(
      {
        ...liquidityOperation(),
        status: "SUBMITTED",
        steps: [{
          name: "SWAP",
          status: "SUBMITTED",
          transactionId: "circle-swap-1",
        }],
        updatedAt,
      },
      ["SUBMITTING"],
    );

    const fingerprint = "d".repeat(64);
    assert.equal((await repositories.identity.claim({
      key: `register:${id}`,
      fingerprint,
      status: "CLAIMED",
    })).claimed, true);
    await assert.rejects(
      repositories.identity.claim({
        key: `register:${id}`,
        fingerprint: "e".repeat(64),
        status: "CLAIMED",
      }),
      /conflict/i,
    );
    await repositories.identity.complete(`register:${id}`, fingerprint, {
      status: "CONFIRMED",
      operation: "REGISTER",
      transactionId: "circle-register-1",
      transactionHash,
      arcscanUrl: `https://testnet.arcscan.app/tx/${transactionHash}`,
      blockNumber: "42",
      agentId: "7",
      reconciliationRequired: false,
    });

    await repositories.jobs.saveJob({
      jobId: "7",
      description: "Review invoice",
      hook: "0x0000000000000000000000000000000000000000",
      client: wallet,
      provider: recipient,
      evaluator: "0x3333333333333333333333333333333333333333",
      budget: "1",
      expiredAt: "1785283200",
      state: "Open",
      contract: "0x4444444444444444444444444444444444444444",
      chainId: 5_042_002,
    });
    await repositories.jobs.appendEvent({
      jobId: "7",
      action: "CREATE",
      fromState: null,
      toState: "Open",
      actor: wallet,
      circleTransactionId: "circle-job-1",
      transactionHash,
      blockNumber: "42",
      explorerUrl: `https://testnet.arcscan.app/tx/${transactionHash}`,
      status: "SUBMITTED",
    });

    const evidence = {
      evidenceKey: `${id}:agent-wallet`,
      operationId: id,
      address: recipient,
      direction: "SEND" as const,
      channel: "AGENT_WALLET_TRANSFER" as const,
      evidenceType: "CIRCLE_AGENT_WALLET_BUILT_IN" as const,
      status: "DECLARED_RUNTIME_CONTROL" as const,
      createdAt,
    };
    assert.deepEqual(await repositories.compliance.record(evidence), evidence);
    assert.equal((await repositories.compliance.list(id)).length, 1);

    const reloaded = createArcLocalStateRepositories({ filePath });
    assert.equal(
      (await reloaded.commerce.getByIdempotencyKey(id))?.status,
      "SETTLED",
    );
    assert.equal((await reloaded.liquidity.get(secondId))?.status, "SUBMITTED");
    assert.equal((await reloaded.compliance.list(id)).length, 1);
    assert.match(await readFile(filePath, "utf8"), /"jobId":"7"/);
  });

  it("rejects secret-shaped metadata before it reaches disk", async () => {
    const filePath = await tempFile("state.json");
    const repositories = createArcLocalStateRepositories({ filePath });

    await assert.rejects(
      repositories.payments.appendActivity({
        id: "activity-secret",
        type: "PAYMENT",
        status: "FAILED",
        referenceId: id,
        metadata: { privateKey: `0x${"f".repeat(64)}` },
        createdAt,
      }),
      /secret|sensitive/i,
    );
    await assert.rejects(
      repositories.payments.appendActivity({
        id: "activity-secret-value",
        type: "PAYMENT",
        status: "FAILED",
        referenceId: id,
        metadata: { note: "authorization=secret-api-key" },
        createdAt,
      }),
      /secret|sensitive/i,
    );
    await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);
  });

  it("rejects symlink targets, malformed state, and oversized files", async () => {
    const symlinkPath = await tempFile("state-link.json");
    const symlinkTarget = `${symlinkPath}.target`;
    await writeFile(symlinkTarget, "{}");
    await symlink(symlinkTarget, symlinkPath);
    const symlinkRepositories = createArcLocalStateRepositories({
      filePath: symlinkPath,
    });
    await assert.rejects(
      symlinkRepositories.payments.claimReceipt(receipt()),
      /symbolic link/i,
    );

    const malformedPath = await tempFile("state.json");
    await writeFile(malformedPath, JSON.stringify({ version: 1, privateKey: "nope" }));
    await chmod(malformedPath, 0o600);
    await assert.rejects(
      createArcLocalStateRepositories({
        filePath: malformedPath,
      }).payments.getReceiptByIdempotencyKey(id),
      /invalid/i,
    );

    const oversizedPath = await tempFile("state.json");
    await writeFile(oversizedPath, "x".repeat(1_025));
    await assert.rejects(
      createArcLocalStateRepositories({
        filePath: oversizedPath,
        maxFileBytes: 1_024,
      }).payments.getReceiptByIdempotencyKey(id),
      /size|large/i,
    );
  });
});
