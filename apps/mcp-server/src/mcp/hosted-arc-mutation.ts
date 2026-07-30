import {
  ARC_HOSTED_CHAIN,
  ArcEvmAddressSchema,
  ArcHostedAuthoritySchema,
  arcUsdcAmountSchema,
  parseUsdcAtomic,
  uuidV4Schema,
  type ArcHostedAuthority,
  type ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import { ARC_HOSTED_USDC_TOKEN_ADDRESS } from "../services/circle-developer-wallets.js";
import type { HostedArcWalletFacade } from "../runtime/hosted-arc-wallet-runtime.js";
import type { ArcPaymentRepository } from "../tools/arc-payments.js";

const hostedMutationInputSchema = z
  .object({
    destination: ArcEvmAddressSchema,
    amount: arcUsdcAmountSchema,
    idempotencyKey: uuidV4Schema,
    purpose: z.string().trim().min(1).max(512),
  })
  .strict();

export interface HostedArcMutationInput {
  readonly destination: string;
  readonly amount: string;
  readonly idempotencyKey: string;
  readonly purpose: string;
}

export interface HostedArcMutationOutput {
  readonly status: ArcPaymentReceiptRecord["status"];
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly reconciliationRequired: boolean;
}

export interface HostedArcMutationCoordinator {
  sendUsdc(
    authority: ArcHostedAuthority,
    input: HostedArcMutationInput,
  ): Promise<HostedArcMutationOutput>;
}

export interface HostedArcMutationCoordinatorOptions {
  readonly facade: HostedArcWalletFacade;
  readonly paymentsForTenant: (
    tenantId: string,
  ) => ArcPaymentRepository;
  readonly resolveFreshAuthority: (
    trustedAuthority: ArcHostedAuthority,
  ) => Promise<ArcHostedAuthority | null>;
  readonly hasConflictingUnresolvedMutation: (
    authority: ArcHostedAuthority,
    idempotencyKey: string,
  ) => Promise<boolean>;
  readonly clock?: () => Date;
  readonly transferTimeoutMs?: number;
  readonly maxActiveUsers?: number;
  readonly maxQueuedPerUser?: number;
}

interface QueueState {
  readonly tail: Promise<void>;
  readonly queued: number;
}

export function createHostedArcMutationCoordinator(
  options: HostedArcMutationCoordinatorOptions,
): HostedArcMutationCoordinator {
  const clock = options.clock ?? (() => new Date());
  const transferTimeoutMs = positiveInteger(
    options.transferTimeoutMs ?? 15_000,
    "transferTimeoutMs",
  );
  const maxActiveUsers = positiveInteger(
    options.maxActiveUsers ?? 128,
    "maxActiveUsers",
  );
  const maxQueuedPerUser = positiveInteger(
    options.maxQueuedPerUser ?? 8,
    "maxQueuedPerUser",
  );
  const queues = new Map<string, QueueState>();

  const coordinator: HostedArcMutationCoordinator = {
    async sendUsdc(
      rawAuthority: ArcHostedAuthority,
      rawInput: HostedArcMutationInput,
    ) {
      const authority = Object.freeze(
        ArcHostedAuthoritySchema.parse(rawAuthority),
      );
      if (authority.accountStatus !== "ACTIVE") {
        throw new Error("Hosted account is not active");
      }
      const input = hostedMutationInputSchema.parse(rawInput);
      return enqueue(authority.authUserId, async () => {
        const freshAuthority =
          await resolveFreshAuthority(authority);
        await assertNoConflictingUnresolvedMutation(
          freshAuthority,
          input.idempotencyKey,
        );
        return executeMutation(freshAuthority, input);
      });
    },
  };
  return Object.freeze(coordinator);

  async function resolveFreshAuthority(
    trustedAuthority: ArcHostedAuthority,
  ): Promise<ArcHostedAuthority> {
    let resolved: ArcHostedAuthority | null;
    try {
      const rawResolved =
        await options.resolveFreshAuthority(trustedAuthority);
      resolved = rawResolved
        ? ArcHostedAuthoritySchema.parse(rawResolved)
        : null;
    } catch {
      throw new Error(
        "Hosted authority is stale, inactive, or unavailable",
      );
    }
    if (
      !resolved
      || resolved.accountStatus !== "ACTIVE"
      || resolved.authUserId !== trustedAuthority.authUserId
      || resolved.tenantId !== trustedAuthority.tenantId
      || resolved.walletAddress !== trustedAuthority.walletAddress
      || resolved.oauthClientId !== trustedAuthority.oauthClientId
      || resolved.authEpoch !== trustedAuthority.authEpoch
    ) {
      throw new Error(
        "Hosted authority is stale, inactive, or unavailable",
      );
    }
    return Object.freeze({ ...resolved });
  }

  async function assertNoConflictingUnresolvedMutation(
    authority: ArcHostedAuthority,
    idempotencyKey: string,
  ): Promise<void> {
    let blocked: boolean;
    try {
      blocked =
        await options.hasConflictingUnresolvedMutation(
          authority,
          idempotencyKey,
        );
    } catch {
      throw new Error(
        "Hosted mutation reconciliation gate is unavailable",
      );
    }
    if (blocked) {
      throw new Error(
        "Hosted mutations are blocked pending durable reconciliation",
      );
    }
  }

  async function executeMutation(
    authority: ArcHostedAuthority,
    input: z.output<typeof hostedMutationInputSchema>,
  ): Promise<HostedArcMutationOutput> {
    const payments = options.paymentsForTenant(authority.tenantId);
    const claimedAt = clock().toISOString();
    const claim = await payments.claimReceipt({
      id: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      walletAddress: authority.walletAddress,
      recipient: input.destination,
      amount: input.amount,
      token: "USDC",
      chain: ARC_HOSTED_CHAIN,
      purpose: input.purpose,
      status: "SUBMITTING",
      createdAt: claimedAt,
      updatedAt: claimedAt,
    });
    if (!claim.claimed) {
      return replayOutput(claim.receipt);
    }
    assertClaimedReceipt(claim.receipt);

    try {
      await assertCanonicalBalance(
        options.facade,
        authority,
        input.amount,
      );
    } catch {
      const failed = await transitionSafely(
        payments,
        {
          ...claim.receipt,
          status: "FAILED",
          errorMessage: "Canonical USDC balance preflight failed",
          updatedAt: clock().toISOString(),
        },
        "SUBMITTING",
      );
      if (!failed) {
        return reconciliationOutput(claim.receipt);
      }
      throw new Error("Canonical USDC balance preflight failed");
    }

    let transfer:
      | { readonly transactionId: string; readonly state: string }
      | undefined;
    try {
      transfer = await withTimeout(
        options.facade.transferTokens(authority, {
          toAddress: input.destination,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
        }),
        transferTimeoutMs,
      );
    } catch {
      const reconciled = await transitionSafely(
        payments,
        {
          ...claim.receipt,
          status: "RECONCILIATION_REQUIRED",
          errorMessage: "Transfer outcome requires reconciliation",
          updatedAt: clock().toISOString(),
        },
        "SUBMITTING",
      );
      if (!reconciled) {
        throw new UndurableAmbiguityError();
      }
      return reconciliationOutput(reconciled);
    }

    const submitted = await transitionSafely(
      payments,
      {
        ...claim.receipt,
        status: "SUBMITTED",
        transactionId: transfer.transactionId,
        updatedAt: clock().toISOString(),
      },
      "SUBMITTING",
    );
    if (!submitted) {
      throw new UndurableAmbiguityError();
    }
    return outputFromReceipt(submitted);
  }

  async function enqueue<T>(
    authUserId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(authUserId);
    if (!previous && queues.size >= maxActiveUsers) {
      throw new Error("Hosted mutation capacity is unavailable");
    }
    if (previous && previous.queued >= maxQueuedPerUser) {
      throw new Error("Hosted mutation queue is full");
    }

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessor = previous?.tail ?? Promise.resolve();
    const tail = predecessor.then(() => gate);
    queues.set(authUserId, {
      tail,
      queued: (previous?.queued ?? 0) + 1,
    });

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      const latest = queues.get(authUserId);
      if (latest?.tail === tail) {
        queues.delete(authUserId);
      } else if (latest) {
        queues.set(authUserId, {
          ...latest,
          queued: Math.max(0, latest.queued - 1),
        });
      }
    }
  }
}

async function assertCanonicalBalance(
  facade: HostedArcWalletFacade,
  authority: ArcHostedAuthority,
  requiredAmount: string,
): Promise<void> {
  const balances = await facade.getBalances(authority);
  const canonical = balances.filter(
    (balance) =>
      balance.symbol === "USDC"
      && balance.address?.toLowerCase()
        === ARC_HOSTED_USDC_TOKEN_ADDRESS.toLowerCase(),
  );
  if (
    canonical.length !== 1
    || parseUsdcAtomic(canonical[0].amount)
      < parseUsdcAtomic(requiredAmount)
  ) {
    throw new Error("Insufficient canonical USDC balance");
  }
}

function assertClaimedReceipt(receipt: ArcPaymentReceiptRecord): void {
  if (
    receipt.status !== "SUBMITTING"
    || receipt.transactionId !== undefined
    || receipt.transactionHash !== undefined
  ) {
    throw new Error("Atomic receipt claim returned an unsafe state");
  }
}

function replayOutput(
  receipt: ArcPaymentReceiptRecord,
): HostedArcMutationOutput {
  if (
    receipt.status === "SUBMITTING"
    || receipt.status === "PENDING"
    || (
      receipt.status === "SUBMITTED"
      && receipt.transactionId === undefined
    )
  ) {
    return reconciliationOutput(receipt);
  }
  return outputFromReceipt(receipt);
}

function reconciliationOutput(
  receipt: ArcPaymentReceiptRecord,
): HostedArcMutationOutput {
  return {
    status: "RECONCILIATION_REQUIRED",
    ...(receipt.transactionId
      ? { transactionId: receipt.transactionId }
      : {}),
    ...(receipt.transactionHash
      ? { transactionHash: receipt.transactionHash }
      : {}),
    reconciliationRequired: true,
  };
}

function outputFromReceipt(
  receipt: ArcPaymentReceiptRecord,
): HostedArcMutationOutput {
  return {
    status: receipt.status,
    ...(receipt.transactionId
      ? { transactionId: receipt.transactionId }
      : {}),
    ...(receipt.transactionHash
      ? { transactionHash: receipt.transactionHash }
      : {}),
    reconciliationRequired:
      receipt.status === "RECONCILIATION_REQUIRED",
  };
}

async function transitionSafely(
  payments: ArcPaymentRepository,
  receipt: ArcPaymentReceiptRecord,
  expectedStatus: ArcPaymentReceiptRecord["status"],
): Promise<ArcPaymentReceiptRecord | null> {
  try {
    return await payments.transitionReceipt(receipt, expectedStatus);
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Hosted mutation timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

class UndurableAmbiguityError extends Error {
  constructor() {
    super(
      "Transfer outcome could not be recorded durably; hosted mutations are blocked",
    );
  }
}
