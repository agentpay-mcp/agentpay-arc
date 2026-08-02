import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ObservedService, PurchaseObjective } from "@agentpay-ai/shared-arc";

import { runGoldenJourney, type GoldenJourneyDependencies } from "./arc-golden-journey.ts";

/**
 * The journey a judge is asked to believe: the agent observes real signals,
 * decides, refuses one service, pays another, receives the protected result,
 * and returns a receipt it could not have forged.
 *
 * Every test here is about what the agent must *not* do — pay something it
 * declined, pay twice, or claim a result it never received. A journey that only
 * proves the happy path proves the fixed-sequence demo we already had.
 */

const objective: PurchaseObjective = {
  description: "Summarise one page",
  maxPriceUsdc: "0.05",
  minimumFeedbackCount: 2,
  minimumAverageScore: 4,
  requireVerifiedEndpoint: true,
};

const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

function service(id: string, overrides: Partial<ObservedService> = {}): ObservedService {
  return {
    id,
    priceUsdc: "0.01",
    token: "USDC",
    chainId: 5042002,
    endpointDomainVerified: true,
    feedbackCount: 10,
    averageScore: 4.8,
    ...overrides,
  };
}

function deps(
  services: readonly ObservedService[],
  overrides: Partial<GoldenJourneyDependencies> = {},
): GoldenJourneyDependencies & { readonly paid: string[]; readonly fetched: string[] } {
  const paid: string[] = [];
  const fetched: string[] = [];
  return {
    paid,
    fetched,
    async observe() {
      return services;
    },
    async pay(target) {
      paid.push(target.id);
      return { transactionId: `tx-${target.id}`, status: "COMPLETED" as const };
    },
    async fetchResult(target) {
      fetched.push(target.id);
      return `result for ${target.id}`;
    },
    ...overrides,
  };
}

describe("runGoldenJourney", () => {
  it("declines the first candidate and pays the next, recording why", async () => {
    const context = deps([
      service("too-expensive", { priceUsdc: "0.90" }),
      service("acceptable"),
    ]);

    const trace = await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.deepEqual(
      context.paid,
      ["acceptable"],
      "only the qualifying service may be paid",
    );

    const declined = trace.steps.find((step) => step.verdict === "DECLINE");
    assert.ok(declined, "the trace must contain a real decline, not just a payment");
    assert.equal(declined.serviceId, "too-expensive");
    assert.match(declined.reason, /0\.90/, "the decline must say what it saw");

    assert.equal(trace.outcome, "PAID");
    assert.equal(trace.result, "result for acceptable");
  });

  it("never pays a service it declined", async () => {
    const context = deps([service("unverified", { endpointDomainVerified: false })]);

    const trace = await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.deepEqual(context.paid, [], "a declined service must not be paid");
    assert.deepEqual(context.fetched, [], "and its result must not be fetched");
    assert.equal(trace.outcome, "NO_QUALIFYING_SERVICE");
  });

  it("stops at the first qualifying service rather than paying every match", async () => {
    const context = deps([service("first"), service("second")]);

    await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.deepEqual(context.paid, ["first"]);
  });

  it("does not fetch the protected result unless the payment reached a terminal success", async () => {
    // An ambiguous payment is not a paid payment. Fetching on optimism is how a
    // demo ends up showing a result the agent never actually bought.
    const context = deps([service("acceptable")], {
      async pay() {
        return { transactionId: "tx-1", status: "RECONCILIATION_REQUIRED" as const };
      },
    });

    const trace = await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.deepEqual(context.fetched, []);
    assert.equal(trace.outcome, "PAYMENT_UNRESOLVED");
    assert.equal(trace.result, undefined);
  });

  it("passes the caller's idempotency key through unchanged", async () => {
    // Generating one per attempt inside the journey would turn a retry into a
    // second payment.
    let seen: string | undefined;
    const context = deps([service("acceptable")], {
      async pay(_target, idempotencyKey) {
        seen = idempotencyKey;
        return { transactionId: "tx-1", status: "COMPLETED" as const };
      },
    });

    await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.equal(seen, IDEMPOTENCY_KEY);
  });

  it("records every candidate it looked at, not only the one it paid", async () => {
    // The trace is the evidence. Dropping the rejected candidates would leave a
    // record indistinguishable from a fixed sequence that always pays.
    const context = deps([
      service("cheap-but-unrated", { averageScore: null }),
      service("wrong-chain", { chainId: 42220 }),
      service("acceptable"),
    ]);

    const trace = await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.equal(trace.steps.length, 3);
    assert.deepEqual(
      trace.steps.map((step) => step.verdict),
      ["DECLINE", "DECLINE", "PAY"],
    );
  });

  it("pays the object it validated, not the one the caller can still change", async () => {
    // The decision and the action must be about the same thing. A service that
    // mutates after approval -- a shared object, a lazy getter, a proxy --
    // would otherwise be approved at one price and paid at another.
    const mutable = { ...service("svc") } as ObservedService & { priceUsdc: string };
    let priceAtPayment = "";
    let priceAtFetch = "";

    const trace = await runGoldenJourney(
      objective,
      {
        async observe() {
          return [mutable];
        },
        async pay(target) {
          mutable.priceUsdc = "9.00";
          priceAtPayment = target.priceUsdc;
          return { transactionId: "tx-1", status: "COMPLETED" as const };
        },
        async fetchResult(target) {
          priceAtFetch = target.priceUsdc;
          return "result";
        },
      },
      IDEMPOTENCY_KEY,
    );

    assert.equal(trace.steps[0]?.observed.priceUsdc, "0.01");
    assert.equal(priceAtPayment, "0.01", "payment must receive the approved snapshot");
    assert.equal(priceAtFetch, "0.01", "so must result retrieval");
    assert.equal(trace.outcome, "PAID");
  });

  it("refuses a completed payment that carries no receipt identity", async () => {
    // "COMPLETED" with an empty transaction id is not evidence of anything:
    // there is nothing to bind the protected result to, and nothing to
    // reconcile against later.
    let fetched = false;
    await assert.rejects(() =>
      runGoldenJourney(
        objective,
        {
          async observe() {
            return [service("acceptable")];
          },
          async pay() {
            return { transactionId: "", status: "COMPLETED" as const };
          },
          async fetchResult() {
            fetched = true;
            return "result";
          },
        },
        IDEMPOTENCY_KEY,
      ),
    );

    assert.equal(fetched, false, "no result may be fetched against a missing receipt");
  });

  it("reports no qualifying service rather than paying the least bad one", async () => {
    const context = deps([
      service("a", { priceUsdc: "5.00" }),
      service("b", { feedbackCount: 0 }),
    ]);

    const trace = await runGoldenJourney(objective, context, IDEMPOTENCY_KEY);

    assert.equal(trace.outcome, "NO_QUALIFYING_SERVICE");
    assert.deepEqual(context.paid, []);
  });
});
