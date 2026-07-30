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
    return successResponse({ account: safeAccount(account) });
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
