import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAgentPayEnv } from "./agentpay-runtime.js";
import { ARC_CHAIN_ID, validateProductionEnvironment } from "./production-readiness.js";

/**
 * Two independent validators gate the same hosted process.
 *
 * `startAgentPayHttpServer` calls `parseAgentPayEnv` to start, and `/readyz`
 * calls `validateProductionEnvironment`. Nothing has ever run both against one
 * environment, so they were free to drift apart -- and they did. Each is
 * internally consistent and covered by its own passing tests; the defect only
 * exists in the gap between them.
 *
 * These tests own that gap. They are deliberately written against the observable
 * contract (which value does each accept?) rather than against either
 * implementation, so they stay meaningful whichever way the conflict is
 * resolved.
 */

/** The single variable both validators claim authority over. */
const HOME_CHAIN_ID = "AGENTPAY_HOME_CHAIN_ID";

/**
 * Asks each validator, in isolation, which production home chain id it accepts.
 *
 * `parseAgentPayEnv` throws one aggregate error rather than returning a report,
 * and it fails on unrelated missing keys too, so the probe reads the specific
 * complaint about this variable instead of overall success. A minimal env is
 * enough: an accepted value never appears in the `invalid:` list.
 */
function rejectsHomeChainId(validator: "parser" | "readiness", value: string): boolean {
  const env: Record<string, string> = {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    [HOME_CHAIN_ID]: value,
  };

  if (validator === "readiness") {
    return validateProductionEnvironment(env).errors.some((error) => error.startsWith(`${HOME_CHAIN_ID}:`));
  }

  try {
    parseAgentPayEnv(env);
    return false;
  } catch (error) {
    // The aggregate message lists invalid names after an `invalid:` marker.
    // Missing-key noise is expected here and must not count as a rejection of
    // this specific value.
    const message = error instanceof Error ? error.message : String(error);
    const invalidSection = message.split("invalid:")[1] ?? "";
    return invalidSection.includes(HOME_CHAIN_ID);
  }
}

describe("production environment validator consistency", () => {
  it("does not let the startup parser and the readiness gate disagree about the home chain", () => {
    // Both validators run in one hosted process, so any value must be either
    // accepted by both or rejected by both. A value accepted by exactly one
    // produces a server that starts and can never become ready, or a server
    // that is ready by a standard it could not have started under.
    const candidates = [String(ARC_CHAIN_ID), "42220"];

    const split = candidates.filter(
      (value) => rejectsHomeChainId("parser", value) !== rejectsHomeChainId("readiness", value),
    );

    assert.deepEqual(
      split,
      [],
      `${HOME_CHAIN_ID} is accepted by one production validator and rejected by the other: ` +
        split
          .map(
            (value) =>
              `${value} (parser ${rejectsHomeChainId("parser", value) ? "rejects" : "accepts"}, ` +
              `readiness ${rejectsHomeChainId("readiness", value) ? "rejects" : "accepts"})`,
          )
          .join("; "),
    );
  });

  it("leaves at least one home chain id that both production validators accept", () => {
    // The weaker guarantee, stated separately: even if the two agree on every
    // value they were asked about, agreeing to reject everything would still
    // make the hosted production surface unusable.
    const accepted = [String(ARC_CHAIN_ID), "42220"].filter(
      (value) => !rejectsHomeChainId("parser", value) && !rejectsHomeChainId("readiness", value),
    );

    assert.notDeepEqual(accepted, [], `no ${HOME_CHAIN_ID} value satisfies both production validators`);
  });
});
