import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc";

export interface SafeWalletInfo {
  readonly status: "PENDING" | "PROVISIONING" | "LIVE" | "FAILED" | "CLOSED";
  readonly address?: string;
}

export interface SafeAccountInfo {
  readonly status: "ACTIVE" | "PAUSED" | "CLOSED";
  readonly consentVersion: typeof ARC_AUTONOMY_CONSENT_VERSION;
  readonly wallet: SafeWalletInfo;
}

export interface HostedAccountApiResponse {
  readonly success: boolean;
  readonly account: SafeAccountInfo;
}

export interface ProvisionWalletApiResponse {
  readonly success: boolean;
  readonly wallet: {
    readonly address: string;
    readonly status: "LIVE";
  };
}

export interface WithdrawalApiResponse {
  readonly success: boolean;
  readonly withdrawal: {
    readonly status: string;
    readonly transactionId?: string;
    readonly transactionHash?: string;
    readonly reconciliationRequired: boolean;
  };
}

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
): Promise<T> {
  const fetchImpl = options.customFetch || fetch;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${options.accessToken}`);
  headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...options,
      headers,
    });
  } catch (err: unknown) {
    throw new ArcApiError(503, "Network error. Unable to reach Arc server.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ArcApiError(res.status, "Invalid response from Arc server.");
  }

  if (!res.ok || body.success === false) {
    const errorMsg = typeof body.error === "string" ? body.error : `Request failed with status ${res.status}`;
    throw new ArcApiError(res.status, errorMsg);
  }

  return body as unknown as T;
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
  });
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
  });
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
  });
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
  });
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
  });
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
  });
}
