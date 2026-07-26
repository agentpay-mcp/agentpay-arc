import {
  ARC_TESTNET,
  CIRCLE_ARC_CHAIN,
  arcBatchPayoutInputSchema,
  arcUsdcAmountSchema,
  circleAddressSchema,
  deterministicBatchItemId,
  parseUsdcAtomic,
  sumUsdcAmounts,
  uuidV4Schema,
  type ArcAgentActivityRecord,
  type ArcBatchPayoutInput,
  type ArcPaymentBatchItemRecord,
  type ArcPaymentBatchRecord,
  type ArcPaymentReceiptRecord,
  type CircleAgentWallet,
  type CircleTransactionResult,
  type CircleWalletBalance,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { CircleCli } from "../services/circle-cli.ts";

const ARC_EXPLORER_TRANSACTION_BASE_URL = "https://testnet.arcscan.app/tx/";
const completedCircleStates = new Set(["COMPLETE", "COMPLETED", "CONFIRMED"]);

const sendUsdcInputSchema = z
  .object({
    idempotencyKey: uuidV4Schema,
    walletAddress: circleAddressSchema.optional(),
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    chain: z.literal(CIRCLE_ARC_CHAIN).default(CIRCLE_ARC_CHAIN),
    token: z.literal("USDC").default("USDC"),
    purpose: z.string().trim().min(1).max(512),
  })
  .strict();

export type SendUsdcInput = z.input<typeof sendUsdcInputSchema>;

export interface ArcPaymentRepository {
  getReceiptByIdempotencyKey(idempotencyKey: string): Promise<ArcPaymentReceiptRecord | null>;
  saveReceipt(receipt: ArcPaymentReceiptRecord): Promise<ArcPaymentReceiptRecord>;
  appendActivity(activity: ArcAgentActivityRecord): Promise<void>;
  getBatch(batchId: string): Promise<ArcPaymentBatchRecord | null>;
  createBatch(batch: ArcPaymentBatchRecord): Promise<ArcPaymentBatchRecord>;
  saveBatchItem(item: ArcPaymentBatchItemRecord): Promise<ArcPaymentBatchItemRecord>;
  saveBatch(batch: ArcPaymentBatchRecord): Promise<ArcPaymentBatchRecord>;
}

export interface ArcPaymentDependencies {
  readonly circleCli: CircleCli;
  readonly payments: ArcPaymentRepository;
  readonly clock: () => Date;
}

export interface ArcPaymentExecutor {
  sendUsdc(input: SendUsdcInput): Promise<SendUsdcOutput>;
}

export interface SendUsdcOutput {
  readonly status: ArcPaymentReceiptRecord["status"];
  readonly receipt: ArcPaymentReceiptRecord;
}

export interface BatchPayoutOutput {
  readonly status: ArcPaymentBatchRecord["status"];
  readonly batch: ArcPaymentBatchRecord;
}

export async function sendUsdc(
  rawInput: unknown,
  dependencies: ArcPaymentDependencies,
): Promise<SendUsdcOutput> {
  const input = sendUsdcInputSchema.parse(rawInput);
  const existing = await dependencies.payments.getReceiptByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    assertReceiptMatches(existing, input);
    return { status: existing.status, receipt: cloneReceipt(existing) };
  }

  const wallet = selectWallet(
    await dependencies.circleCli.listAgentWallets(),
    input.walletAddress,
  );
  await assertSufficientBalance(
    dependencies.circleCli,
    wallet.address,
    parseUsdcAtomic(input.amount),
  );

  const now = dependencies.clock().toISOString();
  const pending: ArcPaymentReceiptRecord = {
    id: input.idempotencyKey,
    idempotencyKey: input.idempotencyKey,
    walletAddress: wallet.address,
    recipient: input.recipient,
    amount: input.amount,
    token: input.token,
    chain: input.chain,
    purpose: input.purpose,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
  await dependencies.payments.saveReceipt(pending);
  await appendActivity(dependencies, "PAYMENT", pending.status, pending.id, {
    recipient: pending.recipient,
    amount: pending.amount,
  });

  let transaction: CircleTransactionResult;
  try {
    transaction = await dependencies.circleCli.transfer({
      address: wallet.address,
      amount: input.amount,
      recipient: input.recipient,
    });
  } catch (error) {
    const failed = {
      ...pending,
      status: "FAILED" as const,
      errorMessage: safeErrorMessage(error),
      updatedAt: dependencies.clock().toISOString(),
    };
    await dependencies.payments.saveReceipt(failed);
    await appendActivity(dependencies, "PAYMENT", failed.status, failed.id, {
      errorMessage: failed.errorMessage,
    });
    throw error;
  }

  const submitted = withTransaction(pending, transaction, dependencies.clock().toISOString());
  await dependencies.payments.saveReceipt(submitted);
  await appendActivity(dependencies, "PAYMENT", submitted.status, submitted.id, {
    transactionId: transaction.id,
    ...(transaction.txHash ? { transactionHash: transaction.txHash } : {}),
  });

  const finalReceipt =
    completedCircleStates.has(transaction.state.toUpperCase()) && transaction.txHash
      ? { ...submitted, status: "COMPLETED" as const, updatedAt: dependencies.clock().toISOString() }
      : submitted;
  if (finalReceipt !== submitted) {
    await dependencies.payments.saveReceipt(finalReceipt);
    await appendActivity(dependencies, "PAYMENT", finalReceipt.status, finalReceipt.id, {
      transactionId: transaction.id,
      transactionHash: transaction.txHash,
    });
  }

  return { status: finalReceipt.status, receipt: cloneReceipt(finalReceipt) };
}

export async function batchPayout(
  rawInput: unknown,
  dependencies: ArcPaymentDependencies,
): Promise<BatchPayoutOutput> {
  const input = arcBatchPayoutInputSchema.parse(rawInput);
  const wallet = selectWallet(
    await dependencies.circleCli.listAgentWallets(),
    input.walletAddress,
  );
  const existing = await dependencies.payments.getBatch(input.batchId);
  let batch: ArcPaymentBatchRecord;

  if (existing) {
    assertBatchMatches(existing, input, wallet.address);
    batch = existing;
  } else {
    const now = dependencies.clock().toISOString();
    batch = await dependencies.payments.createBatch({
      batchId: input.batchId,
      idempotencyKey: input.idempotencyKey,
      walletAddress: wallet.address,
      chain: input.chain,
      token: input.token,
      status: "PENDING",
      items: input.payouts.map((payout, index) => ({
        id: deterministicBatchItemId(input.batchId, index),
        batchId: input.batchId,
        index,
        recipient: payout.recipient,
        amount: payout.amount,
        ...(payout.purpose ? { purpose: payout.purpose } : {}),
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    });
    await appendActivity(dependencies, "BATCH_PAYOUT", batch.status, batch.batchId, {
      itemCount: batch.items.length,
    });
  }

  const pendingItems = batch.items.filter(
    (item) => item.status === "PENDING" && item.transactionId === undefined,
  );
  if (pendingItems.length === 0) {
    const derivedStatus = deriveBatchStatus(batch.items);
    const normalized =
      derivedStatus === batch.status
        ? batch
        : await dependencies.payments.saveBatch({
            ...batch,
            status: derivedStatus,
            updatedAt: dependencies.clock().toISOString(),
          });
    const verified = await dependencies.payments.getBatch(batch.batchId);
    const latest = verified ?? normalized;
    return { status: latest.status, batch: cloneBatch(latest) };
  }
  await assertSufficientBalance(
    dependencies.circleCli,
    wallet.address,
    sumUsdcAmounts(pendingItems.map((item) => item.amount)),
  );

  for (const item of pendingItems) {
    await executeBatchItem(item, wallet.address, dependencies);
  }

  const stored = await dependencies.payments.getBatch(batch.batchId);
  if (!stored) {
    throw new Error("Arc payout batch disappeared after item persistence.");
  }
  const finalStatus = deriveBatchStatus(stored.items);
  const finalBatch = await dependencies.payments.saveBatch({
    ...stored,
    status: finalStatus,
    updatedAt: dependencies.clock().toISOString(),
  });
  await appendActivity(dependencies, "BATCH_PAYOUT", finalBatch.status, finalBatch.batchId, {
    itemCount: finalBatch.items.length,
  });
  const verified = await dependencies.payments.getBatch(batch.batchId);
  if (!verified) {
    throw new Error("Arc payout batch could not be verified after persistence.");
  }
  return { status: verified.status, batch: cloneBatch(verified) };
}

export function createSendUsdcHandler(dependencies: ArcPaymentDependencies) {
  return (input: unknown) => sendUsdc(input, dependencies);
}

export function createBatchPayoutHandler(dependencies: ArcPaymentDependencies) {
  return (input: unknown) => batchPayout(input, dependencies);
}

export function createArcPaymentExecutor(dependencies: ArcPaymentDependencies): ArcPaymentExecutor {
  return {
    sendUsdc: (input) => sendUsdc(input, dependencies),
  };
}

export const sendUsdcTool = {
  name: "send_usdc",
  description: "Send exact six-decimal USDC from a selected Circle Agent Wallet on Arc Testnet.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["idempotencyKey", "recipient", "amount", "purpose"],
    properties: {
      idempotencyKey: { type: "string", format: "uuid" },
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      amount: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
      chain: { type: "string", enum: [CIRCLE_ARC_CHAIN], default: CIRCLE_ARC_CHAIN },
      token: { type: "string", enum: ["USDC"], default: "USDC" },
      purpose: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

export const batchPayoutTool = {
  name: "batch_payout",
  description: "Send a resumable tenant-scoped batch of USDC payouts on Arc Testnet.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["batchId", "idempotencyKey", "payouts"],
    properties: {
      batchId: { type: "string", format: "uuid" },
      idempotencyKey: { type: "string", format: "uuid" },
      walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      chain: { type: "string", enum: [CIRCLE_ARC_CHAIN], default: CIRCLE_ARC_CHAIN },
      token: { type: "string", enum: ["USDC"], default: "USDC" },
      payouts: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["recipient", "amount"],
          properties: {
            recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
            amount: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
            purpose: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
    },
  },
} as const;

async function executeBatchItem(
  item: ArcPaymentBatchItemRecord,
  walletAddress: string,
  dependencies: ArcPaymentDependencies,
): Promise<void> {
  const claimed = await dependencies.payments.saveBatchItem({
    ...item,
    status: "SUBMITTED",
    updatedAt: dependencies.clock().toISOString(),
  });
  let transaction: CircleTransactionResult;
  try {
    transaction = await dependencies.circleCli.transfer({
      address: walletAddress,
      amount: claimed.amount,
      recipient: claimed.recipient,
    });
  } catch (error) {
    await dependencies.payments.saveBatchItem({
      ...claimed,
      status: "FAILED",
      errorMessage: safeErrorMessage(error),
      updatedAt: dependencies.clock().toISOString(),
    });
    return;
  }

  const submitted = withItemTransaction(claimed, transaction, dependencies.clock().toISOString());
  await dependencies.payments.saveBatchItem(submitted);
  if (completedCircleStates.has(transaction.state.toUpperCase()) && transaction.txHash) {
    await dependencies.payments.saveBatchItem({
      ...submitted,
      status: "COMPLETED",
      updatedAt: dependencies.clock().toISOString(),
    });
  }
}

function withTransaction(
  receipt: ArcPaymentReceiptRecord,
  transaction: CircleTransactionResult,
  updatedAt: string,
): ArcPaymentReceiptRecord {
  return {
    ...receipt,
    status: "SUBMITTED",
    transactionId: transaction.id,
    ...(transaction.txHash
      ? {
          transactionHash: transaction.txHash,
          explorerUrl: `${ARC_EXPLORER_TRANSACTION_BASE_URL}${transaction.txHash}`,
        }
      : {}),
    updatedAt,
  };
}

function withItemTransaction(
  item: ArcPaymentBatchItemRecord,
  transaction: CircleTransactionResult,
  updatedAt: string,
): ArcPaymentBatchItemRecord {
  return {
    ...item,
    status: "SUBMITTED",
    transactionId: transaction.id,
    ...(transaction.txHash
      ? {
          transactionHash: transaction.txHash,
          explorerUrl: `${ARC_EXPLORER_TRANSACTION_BASE_URL}${transaction.txHash}`,
        }
      : {}),
    updatedAt,
  };
}

async function assertSufficientBalance(
  circleCli: CircleCli,
  walletAddress: string,
  requiredAtomic: bigint,
): Promise<void> {
  const balance = canonicalUsdcAtomic(await circleCli.getBalance(walletAddress));
  if (balance < requiredAtomic) {
    throw new Error("Insufficient Arc Testnet USDC balance.");
  }
}

function canonicalUsdcAtomic(balance: CircleWalletBalance): bigint {
  const canonical = balance.balances.find(
    ({ token }) =>
      token.symbol.toUpperCase() === "USDC"
      && token.blockchain === CIRCLE_ARC_CHAIN
      && !token.isNative
      && token.decimals === ARC_TESTNET.usdcDecimals
      && token.tokenAddress?.toLowerCase() === ARC_TESTNET.usdcAddress.toLowerCase(),
  );
  const native = balance.balances.find(
    ({ token }) =>
      token.symbol.toUpperCase() === "USDC"
      && token.blockchain === CIRCLE_ARC_CHAIN
      && token.isNative,
  );
  const selected = canonical ?? native;
  if (!selected) {
    return 0n;
  }
  if (!selected.token.isNative) {
    return parseUsdcAtomicAllowZero(selected.amount);
  }
  return nativeUsdcAtomic(selected.amount, selected.token.decimals);
}

function parseUsdcAtomicAllowZero(amount: string): bigint {
  if (/^0(?:\.0{1,6})?$/.test(amount.trim())) {
    return 0n;
  }
  return parseUsdcAtomic(amount);
}

function nativeUsdcAtomic(amount: string, decimals: number): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new Error("Circle returned an invalid native Arc USDC balance.");
  }
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(6))) {
    throw new Error("Circle returned Arc USDC below six-decimal spending precision.");
  }
  return BigInt(match[1]!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
}

function selectWallet(
  wallets: readonly CircleAgentWallet[],
  requestedAddress: string | undefined,
): CircleAgentWallet {
  if (wallets.length === 0) {
    throw new Error("No authenticated Arc Circle Agent Wallet is available.");
  }
  if (requestedAddress) {
    const selected = wallets.find(
      (wallet) => wallet.address.toLowerCase() === requestedAddress.toLowerCase(),
    );
    if (!selected) {
      throw new Error("walletAddress must reference an authenticated Circle Agent Wallet.");
    }
    return selected;
  }
  if (wallets.length > 1) {
    throw new Error("walletAddress is required when multiple Circle Agent Wallets are available.");
  }
  return wallets[0]!;
}

function assertReceiptMatches(
  receipt: ArcPaymentReceiptRecord,
  input: z.output<typeof sendUsdcInputSchema>,
): void {
  if (
    receipt.recipient.toLowerCase() !== input.recipient.toLowerCase()
    || receipt.amount !== input.amount
    || receipt.token !== input.token
    || receipt.chain !== input.chain
    || receipt.purpose !== input.purpose
  ) {
    throw new Error("Idempotency key is already bound to a different Arc payment.");
  }
}

function assertBatchMatches(
  batch: ArcPaymentBatchRecord,
  input: z.output<typeof arcBatchPayoutInputSchema>,
  walletAddress: string,
): void {
  const matches =
    batch.idempotencyKey === input.idempotencyKey
    && batch.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    && batch.chain === input.chain
    && batch.token === input.token
    && batch.items.length === input.payouts.length
    && batch.items.every((item, index) => {
      const payout = input.payouts[index];
      return payout !== undefined
        && item.id === deterministicBatchItemId(input.batchId, index)
        && item.recipient.toLowerCase() === payout.recipient.toLowerCase()
        && item.amount === payout.amount
        && item.purpose === payout.purpose;
    });
  if (!matches) {
    throw new Error("Batch ID is already bound to a different Arc payout batch.");
  }
}

function deriveBatchStatus(
  items: readonly ArcPaymentBatchItemRecord[],
): ArcPaymentBatchRecord["status"] {
  if (items.every((item) => item.status === "COMPLETED")) {
    return "COMPLETED";
  }
  const failed = items.filter((item) => item.status === "FAILED").length;
  if (failed === items.length) {
    return "FAILED";
  }
  if (failed > 0) {
    return "PARTIAL";
  }
  if (items.some((item) => item.status === "SUBMITTED" || item.status === "COMPLETED")) {
    return "SUBMITTED";
  }
  return "PENDING";
}

async function appendActivity(
  dependencies: ArcPaymentDependencies,
  type: ArcAgentActivityRecord["type"],
  status: string,
  referenceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const createdAt = dependencies.clock().toISOString();
  const activity: ArcAgentActivityRecord = Object.freeze({
    id: `${referenceId}:${status}:${createdAt}`,
    type,
    status,
    referenceId,
    metadata: Object.freeze({ ...metadata }),
    createdAt,
  });
  await dependencies.payments.appendActivity(activity);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Arc payment failed.";
}

function cloneReceipt(receipt: ArcPaymentReceiptRecord): ArcPaymentReceiptRecord {
  return { ...receipt };
}

function cloneBatch(batch: ArcPaymentBatchRecord): ArcPaymentBatchRecord {
  return {
    ...batch,
    items: batch.items.map((item) => ({ ...item })),
  };
}
