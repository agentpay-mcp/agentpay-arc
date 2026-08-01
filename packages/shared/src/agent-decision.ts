import { z } from "zod";

import { ARC_TESTNET } from "./arc.ts";
import { parseUsdcAtomic } from "./batch-payout.ts";

/**
 * The step that makes this an agent rather than a tool call.
 *
 * A fixed sequence that always pays proves nothing about judgement: the
 * interesting behaviour is refusing, for a stated reason, on a signal the agent
 * actually read. So this returns the reason and the observed signals alongside
 * the verdict — a decline nobody can re-check is indistinguishable from a
 * failure.
 *
 * Deliberately pure and offline. It reaches no network and holds no wallet, so
 * the same inputs always produce the same decision and a recorded demo trace
 * can be replayed and verified.
 */

export interface PurchaseObjective {
  readonly description: string;
  /** Inclusive: a service priced exactly at the ceiling is within budget. */
  readonly maxPriceUsdc: string;
  readonly minimumFeedbackCount: number;
  readonly minimumAverageScore: number;
  readonly requireVerifiedEndpoint: boolean;
}

export interface ObservedService {
  readonly id: string;
  readonly priceUsdc: string;
  readonly token: string;
  readonly chainId: number;
  readonly endpointDomainVerified: boolean;
  readonly feedbackCount: number;
  /** `null` when the service has no rating yet — not the same as a low one. */
  readonly averageScore: number | null;
}

export type PurchaseVerdict = "PAY" | "DECLINE";

export interface PurchaseDecision {
  readonly verdict: PurchaseVerdict;
  readonly reason: string;
  readonly observed: ObservedService;
}

const objectiveSchema = z.object({
  description: z.string().trim().min(1),
  maxPriceUsdc: z.string().trim().min(1),
  minimumFeedbackCount: z.number().int().min(0),
  minimumAverageScore: z.number().min(0).max(5),
  requireVerifiedEndpoint: z.boolean(),
});

/**
 * Each rule returns a reason when it refuses. Ordered deliberately: cheapest
 * and most decisive checks first, so the reported reason is the one a reader
 * would consider primary rather than whichever happened to be evaluated last.
 */
type Rule = (objective: PurchaseObjective, service: ObservedService) => string | null;

const RULES: readonly Rule[] = Object.freeze([
  (objective, service) => {
    // Parsed rather than compared as numbers: floating point must never decide
    // whether money moves. Both sides throw on a malformed amount instead of
    // coercing it to something spendable.
    const price = parseUsdcAtomic(service.priceUsdc);
    const ceiling = parseUsdcAtomic(objective.maxPriceUsdc);
    return price > ceiling
      ? `price ${service.priceUsdc} USDC exceeds the ${objective.maxPriceUsdc} USDC budget`
      : null;
  },
  (_objective, service) =>
    service.chainId !== ARC_TESTNET.chainId
      ? `service settles on chain ${service.chainId}, not Arc Testnet ${ARC_TESTNET.chainId}`
      : null,
  (_objective, service) =>
    service.token !== "USDC" ? `service prices in ${service.token}, not USDC` : null,
  (objective, service) =>
    objective.requireVerifiedEndpoint && !service.endpointDomainVerified
      ? "endpoint domain control is not verified"
      : null,
  (objective, service) =>
    service.feedbackCount < objective.minimumFeedbackCount
      ? `only ${service.feedbackCount} feedback entries, below the required ${objective.minimumFeedbackCount}`
      : null,
  (objective, service) => {
    // Absence is not a pass. An unrated service is unrated, and treating that
    // as acceptable is what makes a trust check decorative.
    if (service.averageScore === null) {
      return "no score yet, and an unrated service cannot clear a rating requirement";
    }
    return service.averageScore < objective.minimumAverageScore
      ? `average score ${service.averageScore} is below the required ${objective.minimumAverageScore}`
      : null;
  },
]);

export function decidePurchase(
  rawObjective: PurchaseObjective,
  service: ObservedService,
): PurchaseDecision {
  const objective = objectiveSchema.parse(rawObjective) as PurchaseObjective;

  for (const rule of RULES) {
    const refusal = rule(objective, service);
    if (refusal) {
      return { verdict: "DECLINE", reason: refusal, observed: service };
    }
  }

  return {
    verdict: "PAY",
    reason:
      `within budget at ${service.priceUsdc} of ${objective.maxPriceUsdc} USDC, `
      + `endpoint verified, ${service.feedbackCount} feedback entries scoring ${service.averageScore}`,
    observed: service,
  };
}
