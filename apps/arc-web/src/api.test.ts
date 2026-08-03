import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHostedClients,
  fetchHostedAccount,
  claimHostedAccount,
  provisionWallet,
  pauseHostedAccount,
  resumeHostedAccount,
  withdrawHostedAccount,
  fetchWithdrawalStatus,
  ArcApiError,
} from "./api.ts";
import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc/arc-hosted-auth";

const API_ORIGIN = "https://mcp.arc.agentpay.site";
const MOCK_ACCESS_TOKEN = "mock_access_token_value_for_testing";

test("fetchHostedAccount retrieves safe account info", async () => {
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account`);
    assert.equal((init?.headers as Headers).get("Authorization"), `Bearer ${MOCK_ACCESS_TOKEN}`);
    assert.equal("accessToken" in (init ?? {}), false);
    assert.equal("customFetch" in (init ?? {}), false);
    return new Response(
      JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal(res.account.status, "ACTIVE");
  assert.equal(res.account.wallet.address, "0x1111111111111111111111111111111111111111");
});

test("claimHostedAccount posts consent version", async () => {
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account/claim`);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.consentVersion, ARC_AUTONOMY_CONSENT_VERSION);
    return new Response(
      JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          wallet: { status: "PENDING" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await claimHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal(res.account.wallet.status, "PENDING");
});

test("provisionWallet posts to /api/wallet/provision", async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/wallet/provision`);
    return new Response(
      JSON.stringify({
        success: true,
        wallet: { address: "0x1111111111111111111111111111111111111111", status: "LIVE" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await provisionWallet(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal(res.wallet.status, "LIVE");
  assert.equal(res.wallet.address, "0x1111111111111111111111111111111111111111");
});

test("pauseHostedAccount posts to /api/account/pause", async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account/pause`);
    return new Response(
      JSON.stringify({
        success: true,
        account: { status: "PAUSED", consentVersion: ARC_AUTONOMY_CONSENT_VERSION, wallet: { status: "LIVE" } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await pauseHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal(res.account.status, "PAUSED");
});

test("resumeHostedAccount posts to /api/account/resume", async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account/resume`);
    return new Response(
      JSON.stringify({
        success: true,
        account: { status: "ACTIVE", consentVersion: ARC_AUTONOMY_CONSENT_VERSION, wallet: { status: "LIVE" } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await resumeHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal(res.account.status, "ACTIVE");
});

test("withdrawHostedAccount sends withdrawal parameters and handles status 200", async () => {
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account/withdraw`);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.destination, "0x2222222222222222222222222222222222222222");
    assert.equal(body.amount, "10.50");
    assert.equal(body.confirmed, true);
    return new Response(
      JSON.stringify({
        success: true,
        withdrawal: {
          status: "COMPLETED",
          transactionHash: "0xabc",
          reconciliationRequired: false,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const res = await withdrawHostedAccount(
    API_ORIGIN,
    MOCK_ACCESS_TOKEN,
    {
      destination: "0x2222222222222222222222222222222222222222",
      amount: "10.50",
      idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
      confirmed: true,
    },
    mockFetch,
  );

  assert.equal(res.withdrawal.status, "COMPLETED");
  assert.equal(res.withdrawal.transactionHash, "0xabc");
});

test("fetchWithdrawalStatus polls by tenant-bound opaque identifiers without resubmitting", async () => {
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), `${API_ORIGIN}/api/account/withdraw/status`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(init?.body as string), {
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      transactionId: "circle-tx-1",
    });
    return new Response(JSON.stringify({
      success: true,
      withdrawal: {
        status: "COMPLETED",
        transactionId: "circle-tx-1",
        transactionHash: `0x${"a".repeat(64)}`,
        reconciliationRequired: false,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const response = await fetchWithdrawalStatus(
    API_ORIGIN,
    MOCK_ACCESS_TOKEN,
    {
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      transactionId: "circle-tx-1",
    },
    mockFetch,
  );

  assert.equal(response.withdrawal.status, "COMPLETED");
});

test("handles non-json response error", async () => {
  const mockFetch = (async () => {
    return new Response("<html>Server Error</html>", { status: 500 });
  }) as typeof fetch;

  await assert.rejects(
    async () => {
      await fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
    },
    (err: unknown) => {
      assert(err instanceof ArcApiError);
      assert.equal(err.status, 500);
      assert.equal(err.message, "Invalid response from Arc server.");
      return true;
    },
  );
});

test("handles error response without explicit error message", async () => {
  const mockFetch = (async () => {
    return new Response(JSON.stringify({ success: false }), { status: 400 });
  }) as typeof fetch;

  await assert.rejects(
    async () => {
      await fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
    },
    (err: unknown) => {
      assert(err instanceof ArcApiError);
      assert.equal(err.status, 400);
      assert.equal(err.message, "The Arc request could not be completed.");
      return true;
    },
  );
});

test("never exposes an upstream error message to the browser", async () => {
  const rawError = 'relation "private.circle_wallets" does not exist; service_role=secret';
  const mockFetch = (async () =>
    new Response(JSON.stringify({ success: false, error: rawError }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    () => fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch),
    (err: unknown) => {
      assert(err instanceof ArcApiError);
      assert.equal(err.status, 500);
      assert.equal(err.message, "The Arc server could not complete the request. Please try again.");
      assert.equal(err.message.includes(rawError), false);
      return true;
    },
  );
});

test("rejects malformed success payloads instead of trusting TypeScript casts", async () => {
  const mockFetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          wallet: { status: "LIVE", address: "not-an-evm-address" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  await assert.rejects(
    () => fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch),
    (err: unknown) => {
      assert(err instanceof ArcApiError);
      assert.equal(err.status, 200);
      assert.equal(err.message, "Invalid response from Arc server.");
      return true;
    },
  );
});

test("strips unexpected success fields from safe browser projections", async () => {
  const mockFetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
          wallet: {
            status: "LIVE",
            address: "0x1111111111111111111111111111111111111111",
            walletId: "must-not-reach-browser-state",
          },
          tenantId: "must-not-reach-browser-state",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const response = await fetchHostedAccount(API_ORIGIN, MOCK_ACCESS_TOKEN, mockFetch);
  assert.equal("tenantId" in response.account, false);
  assert.equal("walletId" in response.account.wallet, false);
});
