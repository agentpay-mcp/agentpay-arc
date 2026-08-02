import {
  arcPaymentStatusSchema,
  decidePurchase,
  type ObservedService,
  type PurchaseObjective,
  type ArcPaymentStatus,
  type PurchaseVerdict,
} from "@agentpay-ai/shared-arc";

/**
 * One recordable run of the story the submission actually claims: observe real
 * signals, decide, refuse, pay, receive.
 *
 * Dependencies are injected rather than imported so the same code runs against
 * fixtures offline and against the live hosted MCP when the user authorises a
 * real payment. Nothing here reaches the network or holds a wallet on its own.
 */

/**
 * Taken from the payment domain rather than invented here. An earlier draft
 * accepted "COMPLETE"; receipts actually report "COMPLETED", so a real
 * successful payment would have been read as unresolved and the protected
 * result never fetched. The fixtures hid it by inventing the same wrong value.
 */
export type PaymentStatus = ArcPaymentStatus;

/** The only status that means the money moved and the result may be fetched. */
const TERMINAL_SUCCESS: ArcPaymentStatus = "COMPLETED";

export interface GoldenJourneyDependencies {
  /** Price and trust signals as observed, not as advertised by the seller. */
  observe(): Promise<readonly ObservedService[]>;
  pay(
    service: ObservedService,
    idempotencyKey: string,
  ): Promise<{ readonly transactionId: string; readonly status: PaymentStatus }>;
  fetchResult(service: ObservedService, transactionId: string): Promise<string>;
}

export interface GoldenJourneyStep {
  readonly serviceId: string;
  readonly verdict: PurchaseVerdict;
  readonly reason: string;
  readonly observed: ObservedService;
}

export type GoldenJourneyOutcome =
  | "PAID"
  | "NO_QUALIFYING_SERVICE"
  | "PAYMENT_UNRESOLVED";

export interface GoldenJourneyTrace {
  readonly objective: string;
  /** Every candidate considered, in order, including the refused ones. */
  readonly steps: readonly GoldenJourneyStep[];
  readonly outcome: GoldenJourneyOutcome;
  readonly transactionId?: string;
  readonly result?: string;
}

export async function runGoldenJourney(
  objective: PurchaseObjective,
  dependencies: GoldenJourneyDependencies,
  idempotencyKey: string,
): Promise<GoldenJourneyTrace> {
  const candidates = await dependencies.observe();
  const steps: GoldenJourneyStep[] = [];

  for (const candidate of candidates) {
    const decision = decidePurchase(objective, candidate);
    // Recorded before acting on it. A trace that keeps only the paid candidate
    // is indistinguishable from a fixed sequence that always pays, which is
    // exactly the claim this journey exists to answer.
    steps.push({
      serviceId: candidate.id,
      verdict: decision.verdict,
      reason: decision.reason,
      observed: decision.observed,
    });

    if (decision.verdict === "DECLINE") {
      continue;
    }

    // The caller's key is passed through untouched: minting one per attempt
    // here would turn a retry into a second payment.
    const payment = await dependencies.pay(candidate, idempotencyKey);

    // Validated rather than trusted: an unrecognised status would compare
    // unequal to the success value and be silently filed as unresolved, hiding
    // a contract change behind a plausible-looking outcome.
    const status = arcPaymentStatusSchema.parse(payment.status);

    if (status !== TERMINAL_SUCCESS) {
      // An ambiguous payment is not a paid payment. Fetching the protected
      // result on optimism is how a demo ends up showing something the agent
      // never actually bought.
      return {
        objective: objective.description,
        steps,
        outcome: "PAYMENT_UNRESOLVED",
        transactionId: payment.transactionId,
      };
    }

    const result = await dependencies.fetchResult(candidate, payment.transactionId);
    return {
      objective: objective.description,
      steps,
      outcome: "PAID",
      transactionId: payment.transactionId,
      result,
    };
  }

  // Refusing everything is a valid outcome, and a truthful one. Paying the
  // least bad candidate would defeat the objective it was given.
  return { objective: objective.description, steps, outcome: "NO_QUALIFYING_SERVICE" };
}
