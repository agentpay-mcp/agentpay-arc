import {
  ArcEvmAddressSchema,
} from "@agentpay-ai/shared-arc/arc-hosted-auth";
import {
  arcUsdcAmountSchema,
  uuidV4Schema,
} from "@agentpay-ai/shared-arc/batch-payout";

export interface PreparedWithdrawal {
  readonly destination: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

export function prepareWithdrawal(
  destination: string,
  amount: string,
  randomUuid: () => string = () => crypto.randomUUID(),
): PreparedWithdrawal {
  const parsedDestination = ArcEvmAddressSchema.safeParse(destination);
  if (!parsedDestination.success) {
    throw new Error("Enter a valid EVM destination address.");
  }

  const parsedAmount = arcUsdcAmountSchema.safeParse(amount);
  if (!parsedAmount.success) {
    throw new Error("Enter a positive USDC amount with at most six decimal places.");
  }

  const parsedIdempotencyKey = uuidV4Schema.safeParse(randomUuid());
  if (!parsedIdempotencyKey.success) {
    throw new Error("Unable to prepare a safe withdrawal. Please try again.");
  }

  return {
    destination: parsedDestination.data,
    amount: parsedAmount.data,
    idempotencyKey: parsedIdempotencyKey.data,
  };
}
