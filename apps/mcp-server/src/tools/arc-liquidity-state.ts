import type { CircleSwapResult } from "@agentpay-ai/shared-arc";

import type { ArcAppKitService } from "../services/arc-app-kit.ts";
import type { CircleCli } from "../services/circle-cli.ts";

export type ArcLiquidityOperationStatus =
  | "SUBMITTING"
  | "SUBMITTED"
  | "SWAP_VERIFIED"
  | "PAYING"
  | "COMPLETED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export interface ArcLiquidityStep {
  readonly name: "BRIDGE" | "SWAP" | "VERIFY_SWAP" | "PAY";
  readonly status: ArcLiquidityOperationStatus;
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly burnTransactionHash?: string;
  readonly forwardTransactionHash?: string;
  readonly arcscanUrl?: string;
  readonly traceId?: string;
  readonly transferId?: string;
  readonly fees?: readonly Readonly<Record<string, unknown>>[];
  readonly actualReceivedAtomic?: string;
  readonly blockNumber?: string;
}

export interface ArcLiquidityOperation {
  readonly id: string;
  readonly kind: "BRIDGE" | "SWAP" | "SWAP_AND_PAY";
  readonly inputFingerprint: string;
  readonly status: ArcLiquidityOperationStatus;
  readonly walletAddress: string;
  readonly quoteExpiresAt: string;
  readonly steps: readonly ArcLiquidityStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode?: "EXECUTION_AMBIGUOUS" | "PROOF_UNAVAILABLE" | "RECEIVED_BELOW_MINIMUM";
}

export interface ArcLiquidityToolOutput {
  readonly status: ArcLiquidityOperationStatus;
  readonly operation: ArcLiquidityOperation;
  readonly reconciliationRequired: boolean;
  readonly reconciliationPersistenceFailed?: boolean;
  readonly reconciliationMessage?: string;
}

export interface ArcLiquidityRepository {
  get(idempotencyKey: string): Promise<ArcLiquidityOperation | null>;
  claim(operation: ArcLiquidityOperation): Promise<{
    readonly claimed: boolean;
    readonly operation: ArcLiquidityOperation;
  }>;
  transition(
    operation: ArcLiquidityOperation,
    expectedStatuses: readonly ArcLiquidityOperationStatus[],
  ): Promise<ArcLiquidityOperation>;
}

export interface SwapSettlementProof {
  readonly status: "MINED" | "PENDING" | "UNAVAILABLE";
  readonly transactionHash?: string;
  readonly actualReceivedAtomic?: string;
  readonly blockNumber?: string;
}

export interface SwapSettlementVerifier {
  verify(input: {
    readonly walletAddress: string;
    readonly buyToken: "USDC" | "EURC";
    readonly transactions: CircleSwapResult["transactions"];
  }): Promise<SwapSettlementProof>;
}

export interface SwapPaymentExecutor {
  pay(input: {
    readonly idempotencyKey: string;
    readonly walletAddress: string;
    readonly recipient: string;
    readonly amount: string;
    readonly token: "USDC";
    readonly purpose: string;
  }): Promise<{ readonly transactionHash?: string; readonly transactionId?: string }>;
}

export interface ArcLiquidityDependencies {
  readonly circleCli: CircleCli;
  readonly appKit: ArcAppKitService;
  readonly operations: ArcLiquidityRepository;
  readonly settlementVerifier?: SwapSettlementVerifier;
  readonly paymentExecutor: SwapPaymentExecutor;
  readonly clock?: () => Date;
}

export function createUnavailableSwapSettlementVerifier(): SwapSettlementVerifier {
  return { verify: async () => ({ status: "UNAVAILABLE" }) };
}

export function createInMemoryArcLiquidityRepository(): ArcLiquidityRepository {
  const records = new Map<string, ArcLiquidityOperation>();
  return {
    async get(id) {
      return cloneArcLiquidityOperation(records.get(id) ?? null);
    },
    async claim(operation) {
      const existing = records.get(operation.id);
      if (existing) {
        return { claimed: false, operation: cloneArcLiquidityOperation(existing)! };
      }
      records.set(operation.id, cloneArcLiquidityOperation(operation)!);
      return { claimed: true, operation: cloneArcLiquidityOperation(operation)! };
    },
    async transition(operation, expectedStatuses) {
      const existing = records.get(operation.id);
      if (!existing || !expectedStatuses.includes(existing.status)) {
        throw new Error("Arc liquidity operation transition conflict.");
      }
      if (
        existing.kind !== operation.kind
        || existing.inputFingerprint !== operation.inputFingerprint
        || existing.walletAddress.toLowerCase() !== operation.walletAddress.toLowerCase()
      ) {
        throw new Error("Arc liquidity operation transition data conflict.");
      }
      records.set(operation.id, cloneArcLiquidityOperation(operation)!);
      return cloneArcLiquidityOperation(operation)!;
    },
  };
}

export function cloneArcLiquidityOperation(
  operation: ArcLiquidityOperation | null,
): ArcLiquidityOperation | null {
  if (!operation) return null;
  return {
    ...operation,
    steps: operation.steps.map((step) => ({
      ...step,
      ...(step.fees ? { fees: step.fees.map((fee) => ({ ...fee })) } : {}),
    })),
  };
}
