import {
  ARC_AUTONOMY_CONSENT_VERSION,
  ArcEvmAddressSchema,
  arcUsdcAmountSchema,
  uuidV4Schema,
  type ArcHostedAccount,
  type ArcHostedAuthority,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.js";
import type {
  HostedArcMutationCoordinator,
  HostedArcMutationOutput,
} from "./hosted-arc-mutation.js";

const emptyBodySchema = z.object({}).strict();
const consentBodySchema = z
  .object({
    consentVersion: z.literal(ARC_AUTONOMY_CONSENT_VERSION),
  })
  .strict();
const withdrawalBodySchema = z
  .object({
    destination: ArcEvmAddressSchema,
    amount: arcUsdcAmountSchema,
    idempotencyKey: uuidV4Schema,
    confirmed: z.literal(true),
  })
  .strict();
const withdrawalStatusBodySchema = z
  .object({
    idempotencyKey: uuidV4Schema,
    transactionId: z.string().trim().min(1).max(256),
  })
  .strict();
const accountProjectionSchema = z
  .object({
    balanceUsdc: z.string().trim().min(1).max(128),
    activity: z.array(z.object({
      id: z.string().trim().min(1).max(128),
      type: z.string().trim().min(1).max(128),
      amount: z.string().trim().min(1).max(128).optional(),
      status: z.string().trim().min(1).max(64),
      timestamp: z.string().datetime({ offset: true }),
    }).strict()).max(100),
  })
  .strict();

export type HostedArcAccountProjection = z.output<
  typeof accountProjectionSchema
>;
export interface HostedArcWithdrawalStatusInput {
  readonly idempotencyKey: string;
  readonly transactionId: string;
}

export class HostedArcApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ExecuteHostedArcApiOptions {
  readonly pathname: string;
  readonly authUserId: string;
  readonly body?: unknown;
  readonly repository: ArcHostedAccountRepository;
  readonly provisionWallet: (
    authUserId: string,
  ) => Promise<{ readonly walletAddress: string; readonly status: "LIVE" }>;
  readonly resolveAuthority: () => Promise<ArcHostedAuthority>;
  readonly mutationCoordinator: HostedArcMutationCoordinator;
  readonly projectAccount?: (
    authority: ArcHostedAuthority,
  ) => Promise<HostedArcAccountProjection>;
  readonly reportProjectionError?: (error: unknown) => void;
  readonly reconcileWithdrawal?: (
    authority: ArcHostedAuthority,
    input: HostedArcWithdrawalStatusInput,
  ) => Promise<HostedArcMutationOutput>;
}

export interface HostedArcApiResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function executeHostedArcApi(
  options: ExecuteHostedArcApiOptions,
): Promise<HostedArcApiResponse> {
  if (options.pathname === "/api/account") {
    const account = await options.repository.getHostedAccount(
      options.authUserId,
    );
    if (!account) {
      throw new HostedArcApiError(404, "Hosted account not found");
    }
    let projection: HostedArcAccountProjection | undefined;
    if (
      options.projectAccount
      && account.accountStatus === "ACTIVE"
      && account.walletStatus === "LIVE"
    ) {
      const authority = await options.resolveAuthority();
      try {
        projection = accountProjectionSchema.parse(
          await options.projectAccount(authority),
        );
      } catch (error: unknown) {
        options.reportProjectionError?.(error);
      }
    }
    return successResponse({
      account: {
        ...safeAccount(account),
        ...projection,
      },
    });
  }

  if (options.pathname === "/api/account/claim") {
    const input = consentBodySchema.parse(options.body);
    const account = await options.repository.claimHostedAccount({
      authUserId: options.authUserId,
      consentVersion: input.consentVersion,
    });
    return successResponse({ account: safeAccount(account) });
  }

  const account = await options.repository.getHostedAccount(
    options.authUserId,
  );
  if (!account) {
    throw new HostedArcApiError(404, "Hosted account not found");
  }

  if (options.pathname === "/api/wallet/provision") {
    emptyBodySchema.parse(options.body);
    assertAccountCanMutate(account);
    const wallet = await options.provisionWallet(options.authUserId);
    return successResponse({
      wallet: {
        address: ArcEvmAddressSchema.parse(wallet.walletAddress),
        status: wallet.status,
      },
    });
  }
  if (options.pathname === "/api/account/pause") {
    emptyBodySchema.parse(options.body);
    if (account.accountStatus === "CLOSED") {
      throw new HostedArcApiError(
        409,
        "Closed account cannot be paused",
      );
    }
    await options.repository.setAccountStatus({
      authUserId: options.authUserId,
      status: "PAUSED",
    });
    return successResponse({
      account: {
        ...safeAccount(account),
        status: "PAUSED",
      },
    });
  }
  if (options.pathname === "/api/account/resume") {
    emptyBodySchema.parse(options.body);
    if (account.accountStatus === "CLOSED") {
      throw new HostedArcApiError(
        409,
        "Closed account cannot be resumed",
      );
    }
    await options.repository.setAccountStatus({
      authUserId: options.authUserId,
      status: "ACTIVE",
    });
    return successResponse({
      account: {
        ...safeAccount(account),
        status: "ACTIVE",
      },
    });
  }
  if (options.pathname === "/api/account/withdraw") {
    const input = withdrawalBodySchema.parse(options.body);
    const authority = await options.resolveAuthority();
    const mutation = await options.mutationCoordinator.sendUsdc(
      authority,
      {
        destination: input.destination,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        purpose: "Hosted account withdrawal",
      },
    );
    return {
      status: mutation.reconciliationRequired ? 202 : 200,
      body: {
        success: true,
        withdrawal: safeMutation(mutation),
      },
    };
  }
  if (options.pathname === "/api/account/withdraw/status") {
    const input = withdrawalStatusBodySchema.parse(options.body);
    if (!options.reconcileWithdrawal) {
      throw new HostedArcApiError(
        503,
        "Withdrawal reconciliation is unavailable",
      );
    }
    const authority = await options.resolveAuthority();
    const mutation = await options.reconcileWithdrawal(
      authority,
      input,
    );
    return {
      status: mutation.reconciliationRequired ? 202 : 200,
      body: {
        success: true,
        withdrawal: safeMutation(mutation),
      },
    };
  }
  throw new HostedArcApiError(404, "Route not found");
}

function successResponse(
  body: Readonly<Record<string, unknown>>,
): HostedArcApiResponse {
  return {
    status: 200,
    body: {
      success: true,
      ...body,
    },
  };
}

function safeAccount(account: ArcHostedAccount) {
  return {
    status: account.accountStatus,
    consentVersion: account.consentVersion,
    wallet: {
      status: account.walletStatus,
      ...(account.walletAddress
        ? { address: account.walletAddress }
        : {}),
    },
  };
}

function assertAccountCanMutate(account: ArcHostedAccount): void {
  if (account.accountStatus !== "ACTIVE") {
    throw new HostedArcApiError(
      409,
      "Hosted account must be active",
    );
  }
}

function safeMutation(mutation: HostedArcMutationOutput) {
  return {
    status: mutation.status,
    ...(mutation.transactionId
      ? { transactionId: mutation.transactionId }
      : {}),
    ...(mutation.transactionHash
      ? { transactionHash: mutation.transactionHash }
      : {}),
    reconciliationRequired: mutation.reconciliationRequired,
  };
}
