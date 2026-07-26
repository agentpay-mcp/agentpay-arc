import { z } from "zod";

import {
  CIRCLE_ARC_CHAIN,
  circleAddressSchema,
} from "./circle.ts";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV4Schema = z
  .string()
  .trim()
  .regex(uuidV4Pattern, "Expected a UUID version 4");

export const arcUsdcAmountSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/,
    "Expected USDC with at most six decimal places",
  )
  .refine((amount) => /[1-9]/.test(amount), "Expected a positive USDC amount");

export const arcPaymentStatusSchema = z.enum([
  "PENDING",
  "SUBMITTING",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
]);

export const arcBatchStatusSchema = z.enum([
  "PENDING",
  "SUBMITTED",
  "PARTIAL",
  "COMPLETED",
  "FAILED",
]);

export const arcBatchPayoutItemInputSchema = z
  .object({
    recipient: circleAddressSchema,
    amount: arcUsdcAmountSchema,
    purpose: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const arcBatchPayoutInputSchema = z
  .object({
    batchId: uuidV4Schema,
    idempotencyKey: uuidV4Schema,
    walletAddress: circleAddressSchema.optional(),
    chain: z.literal(CIRCLE_ARC_CHAIN).default(CIRCLE_ARC_CHAIN),
    token: z.literal("USDC").default("USDC"),
    payouts: z.array(arcBatchPayoutItemInputSchema).min(1).max(100),
  })
  .strict()
  .superRefine((input, context) => {
    const recipients = new Set<string>();
    input.payouts.forEach((payout, index) => {
      const normalized = payout.recipient.toLowerCase();
      if (recipients.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: ["payouts", index, "recipient"],
          message: "Duplicate recipient in Arc payout batch",
        });
      }
      recipients.add(normalized);
    });
  });

export interface ArcPaymentReceiptRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly paymentRequestId?: string;
  readonly walletAddress: string;
  readonly recipient: string;
  readonly amount: string;
  readonly token: "USDC";
  readonly chain: typeof CIRCLE_ARC_CHAIN;
  readonly purpose: string;
  readonly status: z.output<typeof arcPaymentStatusSchema>;
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly explorerUrl?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcPaymentBatchItemRecord {
  readonly id: string;
  readonly batchId: string;
  readonly index: number;
  readonly recipient: string;
  readonly amount: string;
  readonly purpose?: string;
  readonly status: z.output<typeof arcPaymentStatusSchema>;
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly explorerUrl?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcPaymentBatchRecord {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly walletAddress: string;
  readonly chain: typeof CIRCLE_ARC_CHAIN;
  readonly token: "USDC";
  readonly status: z.output<typeof arcBatchStatusSchema>;
  readonly items: readonly ArcPaymentBatchItemRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcAgentActivityRecord {
  readonly id: string;
  readonly type: "PAYMENT" | "BATCH_PAYOUT" | "PAYMENT_REQUEST";
  readonly status: string;
  readonly referenceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type ArcBatchPayoutInput = z.input<typeof arcBatchPayoutInputSchema>;
export type ParsedArcBatchPayoutInput = z.output<typeof arcBatchPayoutInputSchema>;

export function parseUsdcAtomic(amount: string): bigint {
  const parsed = arcUsdcAmountSchema.parse(amount);
  const [whole, fraction = ""] = parsed.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdcAtomic(amount: bigint): string {
  if (amount < 0n) {
    throw new Error("USDC atomic amount cannot be negative.");
  }
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function sumUsdcAmounts(amounts: readonly string[]): bigint {
  return amounts.reduce((total, amount) => total + parseUsdcAtomic(amount), 0n);
}

export function deterministicBatchItemId(batchId: string, index: number): string {
  const parsedBatchId = uuidV4Schema.parse(batchId);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Batch item index must be a non-negative safe integer.");
  }
  return `${parsedBatchId}:${index}`;
}
