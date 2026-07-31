import {
  ArcHostedAuthoritySchema,
  uuidV4Schema,
  type ArcHostedAuthority,
  type ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { HostedArcWalletFacade } from "../runtime/hosted-arc-wallet-runtime.js";
import { ARC_HOSTED_USDC_TOKEN_ADDRESS } from "../services/circle-developer-wallets.js";
import type { ArcPaymentRepository } from "../tools/arc-payments.js";
import type {
  HostedArcAccountProjection,
  HostedArcWithdrawalStatusInput,
} from "./hosted-arc-http-api.js";
import type { HostedArcMutationOutput } from "./hosted-arc-mutation.js";

const withdrawalStatusInputSchema = z.object({
  idempotencyKey: uuidV4Schema,
  transactionId: z.string().trim().min(1).max(256),
}).strict();

export interface HostedArcObservabilityOptions {
  readonly facade: HostedArcWalletFacade;
  readonly paymentsForTenant: (
    tenantId: string,
  ) => ArcPaymentRepository;
  readonly listReceiptsForTenant: (
    tenantId: string,
    limit: number,
  ) => Promise<readonly ArcPaymentReceiptRecord[]>;
  readonly clock?: () => Date;
}

export interface HostedArcObservability {
  projectAccount(
    authority: ArcHostedAuthority,
  ): Promise<HostedArcAccountProjection>;
  reconcileWithdrawal(
    authority: ArcHostedAuthority,
    input: HostedArcWithdrawalStatusInput,
  ): Promise<HostedArcMutationOutput>;
}

export function createHostedArcObservability(
  options: HostedArcObservabilityOptions,
): HostedArcObservability {
  const clock = options.clock ?? (() => new Date());

  const observability: HostedArcObservability = {
    async projectAccount(rawAuthority) {
      const authority = ArcHostedAuthoritySchema.parse(rawAuthority);
      const [balances, receipts] = await Promise.all([
        options.facade.getBalances(authority),
        options.listReceiptsForTenant(authority.tenantId, 20),
      ]);
      const canonical = balances.filter(
        (balance) =>
          balance.symbol === "USDC"
          && balance.address?.toLowerCase()
            === ARC_HOSTED_USDC_TOKEN_ADDRESS.toLowerCase(),
      );
      if (canonical.length !== 1) {
        throw new Error("Canonical USDC balance projection is unavailable");
      }
      return {
        balanceUsdc: canonical[0]!.amount,
        activity: receipts.slice(0, 20).map((receipt) => ({
          id: receipt.id,
          type:
            receipt.purpose === "Hosted account withdrawal"
              ? "Withdrawal"
              : "Payment",
          amount: receipt.amount,
          status: receipt.status,
          timestamp: receipt.updatedAt,
        })),
      };
    },

    async reconcileWithdrawal(rawAuthority, rawInput) {
      const authority = ArcHostedAuthoritySchema.parse(rawAuthority);
      const input = withdrawalStatusInputSchema.parse(rawInput);
      const payments = options.paymentsForTenant(authority.tenantId);
      const receipt = await payments.getReceiptByIdempotencyKey(
        input.idempotencyKey,
      );
      if (
        !receipt
        || receipt.walletAddress.toLowerCase()
          !== authority.walletAddress.toLowerCase()
        || receipt.purpose !== "Hosted account withdrawal"
        || receipt.transactionId !== input.transactionId
      ) {
        throw new Error("Hosted withdrawal receipt not found");
      }
      if (receipt.status === "COMPLETED" || receipt.status === "FAILED") {
        return mutationOutput(receipt, false);
      }
      if (
        receipt.status !== "SUBMITTED"
        && receipt.status !== "RECONCILIATION_REQUIRED"
      ) {
        return mutationOutput(receipt, true);
      }

      const transaction = await options.facade.getTransactionStatus(
        authority,
        input.transactionId,
      );
      if (transaction.transactionId !== input.transactionId) {
        throw new Error("Circle transaction identity mismatch");
      }
      const state = transaction.state.toUpperCase();
      const nextStatus: ArcPaymentReceiptRecord["status"] | undefined = successfulStates.has(state)
        ? "COMPLETED"
        : failedStates.has(state) && receipt.status === "SUBMITTED"
          ? "RECONCILIATION_REQUIRED"
          : undefined;
      if (!nextStatus) {
        return {
          status: receipt.status,
          transactionId: receipt.transactionId,
          ...(transaction.txHash
            ? { transactionHash: transaction.txHash }
            : receipt.transactionHash
              ? { transactionHash: receipt.transactionHash }
              : {}),
          reconciliationRequired: true,
        };
      }

      try {
        const { errorMessage: _priorError, ...receiptWithoutError } = receipt;
        const nextReceipt = {
          ...(nextStatus === "COMPLETED" ? receiptWithoutError : receipt),
          status: nextStatus,
          ...(transaction.txHash
            ? { transactionHash: transaction.txHash }
            : {}),
          ...(nextStatus === "RECONCILIATION_REQUIRED"
            ? { errorMessage: "Circle transaction failed" }
            : {}),
          updatedAt: clock().toISOString(),
        };
        const persisted = await payments.transitionReceipt(
          nextReceipt,
          receipt.status,
        );
        return mutationOutput(
          persisted,
          persisted.status === "RECONCILIATION_REQUIRED",
        );
      } catch {
        return mutationOutput(receipt, true);
      }
    },
  };
  return Object.freeze(observability);
}

const successfulStates = new Set(["COMPLETE", "COMPLETED", "CONFIRMED"]);
const failedStates = new Set(["FAILED", "CANCELLED", "DENIED"]);

function mutationOutput(
  receipt: ArcPaymentReceiptRecord,
  reconciliationRequired: boolean,
): HostedArcMutationOutput {
  return {
    status: receipt.status,
    ...(receipt.transactionId
      ? { transactionId: receipt.transactionId }
      : {}),
    ...(receipt.transactionHash
      ? { transactionHash: receipt.transactionHash }
      : {}),
    reconciliationRequired,
  };
}
