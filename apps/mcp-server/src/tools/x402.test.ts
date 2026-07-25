import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseX402PaymentRequired } from "@agentpay-ai/shared-arc";

import {
  createPinnedX402HttpClient,
  parseX402PaymentRequiredForAgent,
  retryX402Request,
} from "./x402.ts";

const basePaymentRequired = {
  x402Version: 2 as const,
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Premium market data",
    serviceName: "Market API",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    },
  ],
};

const originalRetryRequest = {
  method: "GET" as const,
  headers: {
    Accept: "application/json",
    Authorization: "Bearer must-not-leave-agentpay",
    Cookie: "session=must-not-leave-agentpay",
  },
};

const completedX402Intent = {
  id: "pay_x402",
  accountAddress: "0x3333333333333333333333333333333333333333",
  ownerAddress: "0x2222222222222222222222222222222222222222",
  status: "COMPLETED" as const,
  paymentType: "X402_PAYMENT" as const,
  sourceChainId: 196,
  destinationChainId: 8453,
  sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  sourceTokenSymbol: "USDC",
  destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  destinationTokenSymbol: "USDC",
  recipientAddress: "0x1111111111111111111111111111111111111111",
  amountOut: "0.01",
  maxAmountIn: "0.011",
  maxNativeFee: "0",
  routeProvider: "LI.FI" as const,
  routeTarget: "0x7777777777777777777777777777777777777777",
  routeCalldata: "0x1234",
  routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
  routeSummary: "Route to Base.",
  nonce: "42",
  deadline: "2026-07-03T12:15:00.000Z",
  purpose: parseX402PaymentRequired({
    paymentRequired: basePaymentRequired,
    request: originalRetryRequest,
  }).paymentInput.purpose,
  approvalPhrase: "APPROVE pay_x402",
  sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  createdAt: "2026-07-03T12:00:00.000Z",
  completedAt: "2026-07-03T12:02:00.000Z",
};

describe("parseX402PaymentRequiredForAgent", () => {
  it("returns normalized payment fields and x402 protocol details", async () => {
    const paymentRequired = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: {
          url: "https://api.example.com/premium-data",
          description: "Premium market data",
          serviceName: "Market API",
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "10000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      "utf8",
    ).toString("base64");

    const output = await parseX402PaymentRequiredForAgent({ paymentRequired });

    assert.deepEqual(output, {
      status: "PARSED",
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
        mimeType: undefined,
      },
      selectedRequirement: {
        scheme: "exact",
        network: "eip155:8453",
        chainId: 8453,
        chain: "Base",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        payTo: "0x1111111111111111111111111111111111111111",
        amountAtomic: "10000",
        amount: "0.01",
        maxTimeoutSeconds: 60,
      },
      paymentInput: {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationChain: "Base",
        destinationTokenSymbol: "USDC",
        amountOut: "0.01",
        purpose: "x402 payment for Market API: Premium market data [x402-request:0x6883a5441c9fbe43f06d78857957414b515c003f7ba89a4bde6a9ef665874dbe]",
        sourceTokenSymbol: "USDC",
        paymentType: "X402_PAYMENT",
      },
      standardX402SignatureRequired: true,
      instructionToAgent:
        "Review the x402 requirement and bound request with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, send the owner to Review & Sign for the EIP-712 authorization, execute with the verified signature, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response, exact same request, and paymentIntentId.",
    });
  });

  it("rejects unsafe resource URLs before returning payment fields", async () => {
    for (const url of [
      "http://api.example.com/private",
      "https://127.0.0.1/admin",
      "https://[::1]/admin",
      "https://metadata.google.internal/computeMetadata/v1",
    ]) {
      await assert.rejects(
        () => parseX402PaymentRequiredForAgent({
          paymentRequired: {
            ...basePaymentRequired,
            resource: { ...basePaymentRequired.resource, url },
          },
        }),
        /safe public HTTPS URL/i,
      );
    }
  });
});

describe("retryX402Request", () => {
  it("retries the protected resource with AgentPay x402 proof headers after payment completion", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

    const output = await retryX402Request(
      {
        paymentRequired: basePaymentRequired,
        paymentIntentId: "pay_x402",
        request: originalRetryRequest,
      },
      {
        paymentIntents: {
          async getPaymentIntent(paymentIntentId) {
            assert.equal(paymentIntentId, "pay_x402");
            return completedX402Intent;
          },
        },
        httpClient: {
          async request(url, init) {
            fetchCalls.push({ url: String(url), init });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "payment-response": "settled-v2",
                "x-payment-response": "settled-legacy",
              },
            });
          },
        },
      },
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://api.example.com/premium-data");
    assert.equal(fetchCalls[0]?.init.method, "GET");
    const requestHeaders = fetchCalls[0]?.init.headers as Record<string, string>;
    assert.equal(requestHeaders["X-PAYMENT"], requestHeaders["PAYMENT-SIGNATURE"]);
    assert.equal(requestHeaders.accept, "application/json");
    assert.equal(requestHeaders.Authorization, undefined);
    assert.equal(requestHeaders.Cookie, undefined);
    assert.equal(requestHeaders["Access-Control-Expose-Headers"], undefined);
    assert.equal(fetchCalls[0]?.init.redirect, "manual");
    assert.equal(output.status, "RESOURCE_FETCHED");
    assert.equal(output.proofScheme, "agentpay-receipt");
    assert.equal(output.httpStatus, 200);
    assert.equal(output.paymentResponse, "settled-v2");
    assert.equal(output.bodyText, "{\"ok\":true}");
    assert.equal("paymentHeader" in output, false);
    assert.match(output.instructionToAgent, /retry succeeded/i);
  });

  it("binds retry to the exact x402 requirement recorded in the signed payment purpose", async () => {
    const original = parseX402PaymentRequired({ paymentRequired: basePaymentRequired });
    const changedPaymentRequired = {
      ...basePaymentRequired,
      resource: {
        ...basePaymentRequired.resource,
        url: "https://unrelated.example.com/private",
      },
    };
    let fetchCalls = 0;

    await assert.rejects(
      () => retryX402Request(
        {
          paymentRequired: changedPaymentRequired,
          paymentIntentId: "pay_x402",
        },
        {
          paymentIntents: {
            async getPaymentIntent() {
              return { ...completedX402Intent, purpose: original.paymentInput.purpose };
            },
          },
          httpClient: {
            async request() {
              fetchCalls += 1;
              return new Response("unexpected");
            },
          },
        },
      ),
      /original x402 request/i,
    );

    assert.equal(fetchCalls, 0);
  });

  it("rejects non-HTTPS and private x402 destinations before fetch", async () => {
    for (const url of [
      "http://api.example.com/private",
      "https://127.0.0.1/admin",
      "https://[::1]/admin",
      "https://[::ffff:127.0.0.1]/admin",
      "https://metadata.google.internal/computeMetadata/v1",
    ]) {
      const paymentRequired = {
        ...basePaymentRequired,
        resource: { ...basePaymentRequired.resource, url },
      };
      const parsed = parseX402PaymentRequired({ paymentRequired });
      let fetchCalls = 0;

      await assert.rejects(
        () => retryX402Request(
          { paymentRequired, paymentIntentId: "pay_x402" },
          {
            paymentIntents: {
              async getPaymentIntent() {
                return { ...completedX402Intent, purpose: parsed.paymentInput.purpose };
              },
            },
            httpClient: {
              async request() {
                fetchCalls += 1;
                return new Response("unexpected");
              },
            },
          },
        ),
        /safe public HTTPS URL/i,
      );

      assert.equal(fetchCalls, 0);
    }
  });

  it("binds the signed x402 purpose to the original HTTP method and body", async () => {
    const originalRequest = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: "{\"symbol\":\"CELO\"}",
    };
    const original = parseX402PaymentRequired({
      paymentRequired: basePaymentRequired,
      request: originalRequest,
    });

    for (const request of [
      { ...originalRequest, method: "DELETE" as const },
      { ...originalRequest, body: "{\"symbol\":\"USDC\"}" },
    ]) {
      let requests = 0;

      await assert.rejects(
        () => retryX402Request(
          { paymentRequired: basePaymentRequired, paymentIntentId: "pay_x402", request },
          {
            paymentIntents: {
              async getPaymentIntent() {
                return { ...completedX402Intent, purpose: original.paymentInput.purpose };
              },
            },
            httpClient: {
              async request() {
                requests += 1;
                return new Response("unexpected");
              },
            },
          },
        ),
        /original x402 request/i,
      );

      assert.equal(requests, 0);
    }
  });

  it("rejects DNS rebinding targets inside the socket lookup hook", async () => {
    for (const address of ["127.0.0.1", "64:ff9b::a00:1", "2002:0a00:0001::1"]) {
      const client = createPinnedX402HttpClient({
        async resolveHostname(hostname) {
          assert.equal(hostname, "rebind.example.com");
          return [address];
        },
        timeoutMs: 100,
      });

      await assert.rejects(
        () => client.request("https://rebind.example.com/protected", {
          method: "GET",
          headers: {},
          redirect: "manual",
        }),
        /safe public HTTPS URL/i,
      );
    }
  });

  it("refuses to retry when the AgentPay payment is not completed", async () => {
    await assert.rejects(
      () =>
        retryX402Request(
          {
            paymentRequired: {
              x402Version: 2,
              resource: {
                url: "https://api.example.com/premium-data",
              },
              accepts: [
                {
                  scheme: "exact",
                  network: "eip155:8453",
                  amount: "10000",
                  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  payTo: "0x1111111111111111111111111111111111111111",
                  maxTimeoutSeconds: 60,
                },
              ],
            },
            paymentIntentId: "pay_x402",
          },
          {
            paymentIntents: {
              async getPaymentIntent() {
                return {
                  ...completedX402Intent,
                  status: "EXECUTING",
                };
              },
            },
            httpClient: {
              async request() {
                throw new Error("request should not be called.");
              },
            },
          },
        ),
      /must be COMPLETED/,
    );
  });
});
