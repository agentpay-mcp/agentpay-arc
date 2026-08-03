import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PurchaseObjective } from "@agentpay-ai/shared-arc";

import {
  parseHostedArcJourneyEnv,
  runHostedArcJourney,
  type HostedArcJourneyMcpClient,
  type HostedArcJourneyOptions,
} from "./arc-hosted-journey.ts";

const OBJECTIVE: PurchaseObjective = {
  description: "Summarise one page",
  maxPriceUsdc: "0.05",
  minimumFeedbackCount: 2,
  minimumAverageScore: 4,
  requireVerifiedEndpoint: true,
};

const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const FIRST_RECIPIENT = "0x2222222222222222222222222222222222222222";
const SECOND_RECIPIENT = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"ab".repeat(32)}`;
const RETRIEVED_AT = "2026-08-03T08:00:00.000Z";

function offer(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    priceUsdc: "0.01",
    token: "USDC",
    chainId: 5042002,
    endpointDomainVerified: true,
    feedbackCount: 10,
    averageScore: 4.8,
    recipient: SECOND_RECIPIENT,
    resultUrl: `https://seller.example/${id}`,
    ...overrides,
  };
}

function feed(...offers: Record<string, unknown>[]) {
  return {
    observedAt: RETRIEVED_AT,
    offers,
  };
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function mcpClient(options: {
  readonly balanceBefore: string;
  readonly balanceAfter?: string;
  readonly send?: Record<string, unknown>;
  readonly receipt?: Record<string, unknown>;
}): HostedArcJourneyMcpClient & { readonly calls: Array<{ name: string; arguments: unknown }> } {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let budgetCalls = 0;
  return {
    calls,
    async callTool(input) {
      calls.push({ name: input.name, arguments: input.arguments });
      if (input.name === "get_agent_budget") {
        budgetCalls += 1;
        return {
          walletAddress: WALLET_ADDRESS,
          chain: "ARC-TESTNET",
          balances: [
            { symbol: "USDC", amount: budgetCalls === 1 ? options.balanceBefore : options.balanceAfter ?? options.balanceBefore },
          ],
        };
      }
      if (input.name === "send_usdc") {
        return options.send ?? { status: "SUBMITTED", transactionId: "tx-1" };
      }
      if (input.name === "get_payment_receipt") {
        return options.receipt ?? { transactionId: "tx-1", state: "COMPLETE", txHash: TX_HASH };
      }
      throw new Error(`unexpected tool ${input.name}`);
    },
  };
}

function journeyOptions(
  mcp: HostedArcJourneyMcpClient,
  fetcher: typeof fetch,
  overrides: Partial<HostedArcJourneyOptions> = {},
): HostedArcJourneyOptions {
  return {
    mcp,
    offersUrl: "https://catalogue.example/offers",
    objective: OBJECTIVE,
    idempotencyKey: IDEMPOTENCY_KEY,
    mode: "SIMULATED",
    allowedServiceOrigins: ["https://seller.example"],
    fetch: fetcher,
    clock: () => new Date(RETRIEVED_AT),
    ...overrides,
  };
}

describe("runHostedArcJourney", () => {
  it("declines one observed offer, pays the next, rechecks the receipt, and binds the result", async () => {
    const mcp = mcpClient({ balanceBefore: "1.00", balanceAfter: "0.99" });
    const requested: Array<{ url: string; headers: Headers }> = [];
    const fetcher = (async (input, init) => {
      const url = String(input);
      requested.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/offers")) {
        return response(feed(
          offer("too-expensive", { priceUsdc: "0.90", recipient: FIRST_RECIPIENT }),
          offer("acceptable"),
        ));
      }
      return response({
        serviceId: "acceptable",
        transactionId: "tx-1",
        content: "paid report",
      });
    }) as typeof fetch;

    const trace = await runHostedArcJourney(journeyOptions(mcp, fetcher));

    assert.equal(trace.mode, "SIMULATED");
    assert.equal(trace.outcome, "PAID");
    assert.deepEqual(trace.journey.steps.map((step) => step.verdict), ["DECLINE", "PAY"]);
    assert.equal(trace.journey.steps[0]?.serviceId, "too-expensive");
    assert.equal(trace.journey.transactionId, "tx-1");
    assert.equal(trace.journey.result, "paid report");
    assert.equal(trace.receipt?.status, "COMPLETED");
    assert.equal(trace.receipt?.transactionHash, TX_HASH);
    assert.equal(trace.receipt?.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH}`);
    assert.equal(trace.wallet.beforeUsdc, "1.00");
    assert.equal(trace.wallet.afterUsdc, "0.99");
    assert.match(trace.resultDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      mcp.calls.map(({ name }) => name),
      ["get_agent_budget", "send_usdc", "get_payment_receipt", "get_agent_budget"],
    );
    assert.deepEqual(
      requested.map(({ url }) => url),
      ["https://catalogue.example/offers", "https://seller.example/acceptable"],
    );
    assert.equal(requested[1]?.headers.get("authorization"), null);
    assert.equal(requested[1]?.headers.get("x-agentpay-transaction-id"), "tx-1");
  });

  it("declines every offer on insufficient observed balance without sending", async () => {
    const mcp = mcpClient({ balanceBefore: "0.005" });
    const fetcher = (async () =>
      response(feed(offer("one"), offer("two", { priceUsdc: "0.02" })))) as typeof fetch;

    const trace = await runHostedArcJourney(journeyOptions(mcp, fetcher));

    assert.equal(trace.outcome, "NO_QUALIFYING_SERVICE");
    assert.ok(trace.journey.steps.every((step) => step.verdict === "DECLINE"));
    assert.match(trace.journey.steps[0]?.reason ?? "", /available balance/i);
    assert.deepEqual(mcp.calls.map(({ name }) => name), ["get_agent_budget"]);
  });

  it("stops in reconciliation when the hosted receipt state is unknown", async () => {
    const mcp = mcpClient({
      balanceBefore: "1.00",
      receipt: { transactionId: "tx-1", state: "WAITING_FOR_INDEXER" },
    });
    const fetcher = (async (input) =>
      String(input).endsWith("/offers")
        ? response(feed(offer("acceptable"), offer("backup", { priceUsdc: "0.02" })))
        : response({ serviceId: "acceptable", transactionId: "tx-1", content: "must not fetch" })) as typeof fetch;

    const trace = await runHostedArcJourney(journeyOptions(mcp, fetcher));

    assert.equal(trace.outcome, "PAYMENT_UNRESOLVED");
    assert.equal(trace.journey.transactionId, "tx-1");
    assert.equal(trace.journey.result, undefined);
    assert.deepEqual(mcp.calls.map(({ name }) => name), ["get_agent_budget", "send_usdc", "get_payment_receipt"]);
  });

  it("does not release a completed payment without an on-chain transaction hash", async () => {
    const mcp = mcpClient({
      balanceBefore: "1.00",
      receipt: { transactionId: "tx-1", state: "COMPLETE" },
    });
    const requested: string[] = [];
    const fetcher = (async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("/offers")
        ? response(feed(offer("acceptable"), offer("backup", { priceUsdc: "0.02" })))
        : response({ serviceId: "acceptable", transactionId: "tx-1", content: "must not fetch" });
    }) as typeof fetch;

    const trace = await runHostedArcJourney(journeyOptions(mcp, fetcher));

    assert.equal(trace.outcome, "PAYMENT_UNRESOLVED");
    assert.equal(trace.receipt?.status, "RECONCILIATION_REQUIRED");
    assert.equal(trace.receipt?.transactionHash, undefined);
    assert.deepEqual(requested, ["https://catalogue.example/offers"]);
    assert.deepEqual(mcp.calls.map(({ name }) => name), ["get_agent_budget", "send_usdc", "get_payment_receipt"]);
  });

  it("requires transfer and receipt hashes to agree before recording proof", async () => {
    const mcp = mcpClient({
      balanceBefore: "1.00",
      send: { status: "SUBMITTED", transactionId: "tx-1", transactionHash: TX_HASH },
      receipt: {
        transactionId: "tx-1",
        state: "COMPLETE",
        txHash: `0x${"cd".repeat(32)}`,
      },
    });
    const requested: string[] = [];
    const fetcher = (async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("/offers")
        ? response(feed(offer("acceptable"), offer("backup", { priceUsdc: "0.02" })))
        : response({ serviceId: "acceptable", transactionId: "tx-1", content: "must not fetch" });
    }) as typeof fetch;

    const trace = await runHostedArcJourney(journeyOptions(mcp, fetcher));

    assert.equal(trace.outcome, "PAYMENT_UNRESOLVED");
    assert.equal(trace.receipt?.status, "RECONCILIATION_REQUIRED");
    assert.equal(trace.receipt?.transactionHash, undefined);
    assert.deepEqual(requested, ["https://catalogue.example/offers"]);
  });

  it("rejects a protected response bound to another service or transaction", async () => {
    const mcp = mcpClient({ balanceBefore: "1.00" });
    const fetcher = (async (input) =>
      String(input).endsWith("/offers")
        ? response(feed(offer("acceptable"), offer("backup", { priceUsdc: "0.02" })))
        : response({ serviceId: "other", transactionId: "tx-1", content: "forged" })) as typeof fetch;

    await assert.rejects(
      runHostedArcJourney(journeyOptions(mcp, fetcher)),
      /protected result binding/i,
    );
  });

  it("rejects an offer feed with fewer than two independently observed offers", async () => {
    const mcp = mcpClient({ balanceBefore: "1.00" });
    const fetcher = (async () => response(feed(offer("only-one")))) as typeof fetch;

    await assert.rejects(
      runHostedArcJourney(journeyOptions(mcp, fetcher)),
      /at least two offers/i,
    );
    assert.deepEqual(mcp.calls.map(({ name }) => name), ["get_agent_budget"]);
  });

  it("requires JSON content types for the independently served offer feed", async () => {
    const mcp = mcpClient({ balanceBefore: "1.00" });
    const fetcher = (async () =>
      new Response(
        JSON.stringify(feed(offer("one"), offer("two"))),
        { headers: { "content-type": "text/plain" } },
      )) as typeof fetch;

    await assert.rejects(
      runHostedArcJourney(journeyOptions(mcp, fetcher)),
      /must be JSON/i,
    );
    assert.deepEqual(mcp.calls.map(({ name }) => name), ["get_agent_budget"]);
  });

  it("requires the hosted health commit to match before a live mutation", async () => {
    const mcp = mcpClient({ balanceBefore: "1.00" });
    const fetcher = (async () =>
      response({
        ok: true,
        version: "0.1.11",
        releaseSha: "f".repeat(40),
      })) as typeof fetch;

    await assert.rejects(
      runHostedArcJourney(journeyOptions(mcp, fetcher, {
        mode: "LIVE",
        allowLivePayments: true,
        hostedMcpUrl: "https://mcp.example/mcp",
        releaseSha: "a".repeat(40),
      })),
      /does not match/i,
    );
    assert.deepEqual(mcp.calls, []);
  });
});

describe("parseHostedArcJourneyEnv", () => {
  const valid = {
    ARC_JOURNEY_LIVE: "1",
    ARC_JOURNEY_CONFIRM: "I_UNDERSTAND_ARC_TESTNET_PAYMENT",
    ARC_JOURNEY_MCP_URL: "https://mcp.example/mcp",
    ARC_JOURNEY_OFFERS_URL: "https://catalogue.example/offers",
    ARC_JOURNEY_ACCESS_TOKEN: "token-is-not-returned-in-the-trace",
    ARC_JOURNEY_IDEMPOTENCY_KEY: IDEMPOTENCY_KEY,
    ARC_RELEASE_SHA: "4e30dc4a9a5448a8b18a02ae10225d8f63870fcd",
  } as const;

  it("requires explicit live opt-in, confirmation, token, idempotency, and release binding", () => {
    assert.throws(
      () => parseHostedArcJourneyEnv({ ...valid, ARC_JOURNEY_LIVE: "0" }),
      /ARC_JOURNEY_LIVE=1/i,
    );
    assert.throws(
      () => parseHostedArcJourneyEnv({ ...valid, ARC_JOURNEY_CONFIRM: "no" }),
      /confirmation/i,
    );
    assert.throws(
      () => parseHostedArcJourneyEnv({ ...valid, ARC_JOURNEY_ACCESS_TOKEN: "" }),
      /access token|ARC_JOURNEY_ACCESS_TOKEN/i,
    );
    assert.throws(
      () => parseHostedArcJourneyEnv({ ...valid, ARC_JOURNEY_IDEMPOTENCY_KEY: "not-a-uuid" }),
      /idempotency/i,
    );

    const parsed = parseHostedArcJourneyEnv(valid);
    assert.equal(parsed.mode, "LIVE");
    assert.equal(parsed.releaseSha, valid.ARC_RELEASE_SHA);
    assert.equal(parsed.accessToken, valid.ARC_JOURNEY_ACCESS_TOKEN);
    assert.equal(parsed.releaseHealthUrl, "https://mcp.example/healthz");
  });
});
