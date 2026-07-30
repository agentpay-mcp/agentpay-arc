import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc/arc-hosted-auth";
import { z } from "zod";

const EvmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const SafeWalletInfoSchema = z.object({
  status: z.enum(["PENDING", "PROVISIONING", "LIVE", "FAILED", "CLOSED"]),
  address: EvmAddressSchema.optional(),
});
const SafeActivityItemSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(128),
  amount: z.string().min(1).max(128).optional(),
  status: z.string().min(1).max(64),
  timestamp: z.string().min(1).max(64),
});
const SafeAccountInfoSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "CLOSED"]),
  consentVersion: z.literal(ARC_AUTONOMY_CONSENT_VERSION),
  wallet: SafeWalletInfoSchema,
  balanceUsdc: z.string().min(1).max(128).optional(),
  activity: z.array(SafeActivityItemSchema).max(100).optional(),
});
const HostedAccountApiResponseSchema = z.object({
  success: z.literal(true),
  account: SafeAccountInfoSchema,
});
const ProvisionWalletApiResponseSchema = z.object({
  success: z.literal(true),
  wallet: z.object({
    address: EvmAddressSchema,
    status: z.literal("LIVE"),
  }),
});
const WithdrawalApiResponseSchema = z.object({
  success: z.literal(true),
  withdrawal: z.object({
    status: z.string().min(1).max(64),
    transactionId: z.string().min(1).max(128).optional(),
    transactionHash: z.string().min(1).max(128).optional(),
    reconciliationRequired: z.boolean(),
  }),
});

export type SafeWalletInfo = z.infer<typeof SafeWalletInfoSchema>;
export type SafeActivityItem = z.infer<typeof SafeActivityItemSchema>;
export type SafeAccountInfo = z.infer<typeof SafeAccountInfoSchema>;
export type HostedAccountApiResponse = z.infer<typeof HostedAccountApiResponseSchema>;
export type ProvisionWalletApiResponse = z.infer<typeof ProvisionWalletApiResponseSchema>;
export type WithdrawalApiResponse = z.infer<typeof WithdrawalApiResponseSchema>;

export class ArcApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(
  url: string,
  options: RequestInit & { accessToken: string; customFetch?: typeof fetch },
  responseSchema: z.ZodType<T>,
): Promise<T> {
  const { accessToken, customFetch, ...requestOptions } = options;
  const fetchImpl = customFetch || fetch;
  const headers = new Headers(requestOptions.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...requestOptions,
      headers,
    });
  } catch (err: unknown) {
    throw new ArcApiError(503, "Network error. Unable to reach Arc server.");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ArcApiError(res.status, "Invalid response from Arc server.");
  }

  const responseEnvelope = z.object({ success: z.boolean().optional() }).safeParse(body);
  if (!res.ok || (responseEnvelope.success && responseEnvelope.data.success === false)) {
    const message = res.status >= 500
      ? "The Arc server could not complete the request. Please try again."
      : "The Arc request could not be completed.";
    throw new ArcApiError(res.status, message);
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ArcApiError(res.status, "Invalid response from Arc server.");
  }
  return parsed.data;
}

export async function fetchHostedAccount(
  apiOrigin: string,
  accessToken: string,
  customFetch?: typeof fetch,
): Promise<HostedAccountApiResponse> {
  return requestJson<HostedAccountApiResponse>(`${apiOrigin}/api/account`, {
    method: "GET",
    accessToken,
    customFetch,
  }, HostedAccountApiResponseSchema);
}

export async function claimHostedAccount(
  apiOrigin: string,
  accessToken: string,
  customFetch?: typeof fetch,
): Promise<HostedAccountApiResponse> {
  return requestJson<HostedAccountApiResponse>(`${apiOrigin}/api/account/claim`, {
    method: "POST",
    body: JSON.stringify({ consentVersion: ARC_AUTONOMY_CONSENT_VERSION }),
    accessToken,
    customFetch,
  }, HostedAccountApiResponseSchema);
}

export async function provisionWallet(
  apiOrigin: string,
  accessToken: string,
  customFetch?: typeof fetch,
): Promise<ProvisionWalletApiResponse> {
  return requestJson<ProvisionWalletApiResponse>(`${apiOrigin}/api/wallet/provision`, {
    method: "POST",
    body: JSON.stringify({}),
    accessToken,
    customFetch,
  }, ProvisionWalletApiResponseSchema);
}

export async function pauseHostedAccount(
  apiOrigin: string,
  accessToken: string,
  customFetch?: typeof fetch,
): Promise<HostedAccountApiResponse> {
  return requestJson<HostedAccountApiResponse>(`${apiOrigin}/api/account/pause`, {
    method: "POST",
    body: JSON.stringify({}),
    accessToken,
    customFetch,
  }, HostedAccountApiResponseSchema);
}

export async function resumeHostedAccount(
  apiOrigin: string,
  accessToken: string,
  customFetch?: typeof fetch,
): Promise<HostedAccountApiResponse> {
  return requestJson<HostedAccountApiResponse>(`${apiOrigin}/api/account/resume`, {
    method: "POST",
    body: JSON.stringify({}),
    accessToken,
    customFetch,
  }, HostedAccountApiResponseSchema);
}

export async function withdrawHostedAccount(
  apiOrigin: string,
  accessToken: string,
  params: {
    destination: string;
    amount: string;
    idempotencyKey: string;
    confirmed: true;
  },
  customFetch?: typeof fetch,
): Promise<WithdrawalApiResponse> {
  return requestJson<WithdrawalApiResponse>(`${apiOrigin}/api/account/withdraw`, {
    method: "POST",
    body: JSON.stringify({
      destination: params.destination,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      confirmed: params.confirmed,
    }),
    accessToken,
    customFetch,
  }, WithdrawalApiResponseSchema);
}
