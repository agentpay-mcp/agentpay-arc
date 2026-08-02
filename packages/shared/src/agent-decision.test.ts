import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decidePurchase, type ObservedService, type PurchaseObjective } from "./agent-decision.ts";

/**
 * The difference between an agent and a chatbot calling a fixed tool is that
 * the agent can say no, for a reason it can state.
 *
 * These tests are written against that: every case asserts the reason as well
 * as the verdict, because a decline whose reason nobody can check is
 * indistinguishable from a failure.
 */

const objective: PurchaseObjective = {
  description: "Summarise one page",
  maxPriceUsdc: "0.05",
  minimumFeedbackCount: 2,
  minimumAverageScore: 4,
  requireVerifiedEndpoint: true,
};

function service(overrides: Partial<ObservedService> = {}): ObservedService {
  return {
    id: "svc-1",
    priceUsdc: "0.01",
    token: "USDC",
    chainId: 5042002,
    endpointDomainVerified: true,
    feedbackCount: 10,
    averageScore: 4.8,
    ...overrides,
  };
}

describe("decidePurchase", () => {
  it("pays when every observed signal clears the objective", () => {
    const decision = decidePurchase(objective, service());

    assert.equal(decision.verdict, "PAY");
    assert.match(decision.reason, /within budget/i);
    // The signals it acted on are part of the decision, so a recorded trace can
    // be re-checked later rather than taken on trust.
    assert.deepEqual(decision.observed.priceUsdc, "0.01");
  });

  it("declines a service priced above the objective, and says by how much", () => {
    const decision = decidePurchase(objective, service({ priceUsdc: "0.06" }));

    assert.equal(decision.verdict, "DECLINE");
    assert.match(decision.reason, /0\.06/);
    assert.match(decision.reason, /0\.05/);
  });

  it("treats the budget as inclusive at its exact boundary", () => {
    // Exactly at budget is within budget. Off-by-one here would silently
    // decline the cheapest acceptable service.
    assert.equal(decidePurchase(objective, service({ priceUsdc: "0.05" })).verdict, "PAY");
  });

  it("compares price in atomic units, not as floating point", () => {
    // Chosen because Number() collapses these two to the same double: as
    // floats the price is *not* greater than the ceiling, so a float
    // comparison pays. In atomic units it is over by one unit and must
    // decline. Small decimals cannot show this — they compare identically
    // either way, which is how a test like this ends up proving nothing.
    const overByOneAtomicUnit = decidePurchase(
      { ...objective, maxPriceUsdc: "9007199254740.992" },
      service({ priceUsdc: "9007199254740.993" }),
    );

    assert.equal(overByOneAtomicUnit.verdict, "DECLINE");
    assert.match(overByOneAtomicUnit.reason, /exceeds/i);
  });

  it("declines an unverified endpoint even when it is cheap and well rated", () => {
    const decision = decidePurchase(objective, service({ endpointDomainVerified: false }));

    assert.equal(decision.verdict, "DECLINE");
    assert.match(decision.reason, /endpoint/i);
  });

  it("declines on too little reputation rather than assuming the best", () => {
    const thin = decidePurchase(objective, service({ feedbackCount: 1 }));
    assert.equal(thin.verdict, "DECLINE");
    assert.match(thin.reason, /feedback/i);

    const poor = decidePurchase(objective, service({ averageScore: 3.2 }));
    assert.equal(poor.verdict, "DECLINE");
    assert.match(poor.reason, /score/i);
  });

  it("declines when a signal is missing, instead of treating absence as a pass", () => {
    // An unrated service is not a good service. Absence must not read as
    // approval, which is the failure mode that makes a trust check decorative.
    const decision = decidePurchase(objective, service({ averageScore: null }));

    assert.equal(decision.verdict, "DECLINE");
    assert.match(decision.reason, /no score|unrated|missing/i);
  });

  it("declines anything off the objective's chain or token", () => {
    assert.equal(decidePurchase(objective, service({ chainId: 42220 })).verdict, "DECLINE");
    assert.equal(decidePurchase(objective, service({ token: "EURC" })).verdict, "DECLINE");
  });

  it("reports the first failed rule rather than a generic refusal", () => {
    // A decline that says only "did not qualify" cannot be acted on by the
    // person reading the trace.
    const decision = decidePurchase(
      objective,
      service({ priceUsdc: "9.00", endpointDomainVerified: false }),
    );

    assert.equal(decision.verdict, "DECLINE");
    assert.notEqual(decision.reason.trim(), "");
    assert.match(decision.reason, /price|budget/i);
  });

  it("refuses to decide on an observation it cannot trust", () => {
    // The worst failure this module can have: a missing or non-numeric signal
    // makes every comparison false, no rule refuses, and "nothing objected" is
    // read as approval. It paid on both of these before the observed service
    // was validated.
    const nonNumeric = { ...service(), feedbackCount: "many", averageScore: "good" };
    assert.throws(() => decidePurchase(objective, nonNumeric as unknown as ObservedService));

    const missingFields = {
      id: "s",
      priceUsdc: "0.01",
      token: "USDC",
      chainId: 5042002,
      endpointDomainVerified: true,
    };
    assert.throws(() => decidePurchase(objective, missingFields as unknown as ObservedService));

    // `null` stays a decision, not an error: unrated is a state the rules
    // understand. Absent is an incomplete observation, which is not.
    assert.equal(decidePurchase(objective, service({ averageScore: null })).verdict, "DECLINE");
  });

  it("rejects a malformed price instead of guessing at it", () => {
    assert.throws(() => decidePurchase(objective, service({ priceUsdc: "abc" })));
    assert.throws(() => decidePurchase(objective, service({ priceUsdc: "-0.01" })));
    assert.throws(() => decidePurchase(objective, service({ priceUsdc: "0.0000001" })));
  });
});
