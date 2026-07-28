import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION,
  ARC_ERC8183_JOB_STATES,
  ERC1967_IMPLEMENTATION_SLOT,
  arcAgentJobBudgetInputSchema,
  arcAgentJobCreateInputSchema,
  arcAgentJobFundInputSchema,
  arcAgentJobIdSchema,
  arcAgentJobProofSchema,
  arcAgentJobReadInputSchema,
  arcAgentJobRejectInputSchema,
  arcAgentJobCompleteInputSchema,
  arcAgentJobSubmitInputSchema,
  arcErc8183Bytes32Schema,
  assertArcAgentJobRole,
  assertArcAgentJobTransition,
  erc8183AgenticCommerceAbi,
  isArcAgentJobExpired,
  jobStateFromOnchainStatus,
} from "./erc8183.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const EVALUATOR = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;
const FUTURE = "4102444800"; // 2100-01-01

describe("ERC-8183 contract metadata", () => {
  it("pins the Arc Testnet AgenticCommerce address verified against deployed bytecode", () => {
    assert.equal(
      ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
      "0x0747EEf0706327138c69792bF28Cd525089e4583",
    );
  });

  it("pins the reverified ERC-1967 implementation metadata", () => {
    assert.equal(
      ERC1967_IMPLEMENTATION_SLOT,
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    );
    assert.equal(
      ARC_TESTNET_ERC8183_AGENTIC_COMMERCE_IMPLEMENTATION,
      "0xa316fd02827242d537f84730f8a37d0ba5fd351a",
    );
  });

  it("declares only signatures present in the deployed implementation", () => {
    // Verified 27 Jul 2026 against implementation 0xa316fd02827242d537f84730f8a37d0ba5fd351a.
    // fund(uint256,uint256) from the EIP interface draft is ABSENT on chain.
    const joined = erc8183AgenticCommerceAbi.join("\n");

    assert.match(joined, /function createJob\(address provider,address evaluator,uint256 expiredAt,string description,address hook\) returns \(uint256\)/);
    assert.match(joined, /function setProvider\(uint256 jobId,address provider\)/);
    assert.match(joined, /function setBudget\(uint256 jobId,uint256 amount,bytes optParams\)/);
    assert.match(joined, /function fund\(uint256 jobId,bytes optParams\)/);
    assert.match(joined, /function submit\(uint256 jobId,bytes32 deliverable,bytes optParams\)/);
    assert.match(joined, /function complete\(uint256 jobId,bytes32 reason,bytes optParams\)/);
    assert.match(joined, /function reject\(uint256 jobId,bytes32 reason,bytes optParams\)/);
    assert.match(joined, /function getJob\(uint256 jobId\) view returns/);

    assert.doesNotMatch(
      joined,
      /function fund\(uint256 jobId,uint256 expectedBudget\)/,
      "the deployed contract has no expectedBudget overload; declaring it would be fiction",
    );
  });

  it("orders job states exactly as the deployed status enum", () => {
    assert.deepEqual(ARC_ERC8183_JOB_STATES, [
      "Open",
      "Funded",
      "Submitted",
      "Completed",
      "Rejected",
      "Expired",
    ]);
    assert.equal(jobStateFromOnchainStatus(0), "Open");
    assert.equal(jobStateFromOnchainStatus(5), "Expired");
  });

  it("rejects an out-of-range onchain status rather than guessing", () => {
    assert.throws(() => jobStateFromOnchainStatus(6), /status/i);
    assert.throws(() => jobStateFromOnchainStatus(-1), /status/i);
  });
});

describe("ERC-8183 lifecycle transitions", () => {
  it("allows every transition the specification defines", () => {
    for (const [from, to] of [
      ["Open", "Funded"],
      ["Open", "Rejected"],
      ["Funded", "Submitted"],
      ["Funded", "Rejected"],
      ["Funded", "Expired"],
      ["Submitted", "Completed"],
      ["Submitted", "Rejected"],
      ["Submitted", "Expired"],
    ] as const) {
      assert.doesNotThrow(() => assertArcAgentJobTransition(from, to));
    }
  });

  it("rejects transitions out of terminal states", () => {
    for (const terminal of ["Completed", "Rejected", "Expired"] as const) {
      assert.throws(() => assertArcAgentJobTransition(terminal, "Funded"), /terminal/i);
    }
  });

  it("rejects skipping the funded state", () => {
    assert.throws(() => assertArcAgentJobTransition("Open", "Submitted"), /transition/i);
    assert.throws(() => assertArcAgentJobTransition("Open", "Completed"), /transition/i);
  });

  it("rejects reopening or self transitions", () => {
    assert.throws(() => assertArcAgentJobTransition("Funded", "Open"), /transition/i);
    assert.throws(() => assertArcAgentJobTransition("Funded", "Funded"), /transition/i);
  });
});

describe("ERC-8183 role enforcement", () => {
  const job = { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR } as const;

  it("binds each action to the role the deployed contract requires", () => {
    assert.doesNotThrow(() => assertArcAgentJobRole("fund", job, CLIENT, "Open"));
    assert.doesNotThrow(() => assertArcAgentJobRole("submit", job, PROVIDER, "Funded"));
    assert.doesNotThrow(() => assertArcAgentJobRole("complete", job, EVALUATOR, "Submitted"));
  });

  it("allows only the provider to set a budget, as the deployed contract enforces", () => {
    // The EIP's prose flow narrates "Client -> setBudget", but the reference
    // implementation reverts unless msg.sender == job.provider.
    assert.doesNotThrow(() => assertArcAgentJobRole("setBudget", job, PROVIDER, "Open"));
    assert.throws(() => assertArcAgentJobRole("setBudget", job, CLIENT, "Open"), /provider/i);
    assert.throws(() => assertArcAgentJobRole("setBudget", job, EVALUATOR, "Open"), /provider/i);
  });

  it("makes reject state-sensitive exactly as the deployed contract does", () => {
    // Open -> client only. Funded/Submitted -> evaluator only.
    assert.doesNotThrow(() => assertArcAgentJobRole("reject", job, CLIENT, "Open"));
    assert.throws(() => assertArcAgentJobRole("reject", job, EVALUATOR, "Open"), /client/i);

    for (const state of ["Funded", "Submitted"] as const) {
      assert.doesNotThrow(() => assertArcAgentJobRole("reject", job, EVALUATOR, state));
      assert.throws(
        () => assertArcAgentJobRole("reject", job, CLIENT, state),
        /evaluator/i,
        `client must not reject a ${state} job -- it reverts on chain`,
      );
    }
  });

  it("refuses an action from the wrong role", () => {
    assert.throws(() => assertArcAgentJobRole("fund", job, PROVIDER, "Open"), /client/i);
    assert.throws(() => assertArcAgentJobRole("submit", job, CLIENT, "Funded"), /provider/i);
    assert.throws(() => assertArcAgentJobRole("complete", job, PROVIDER, "Submitted"), /evaluator/i);
  });

  it("compares addresses case-insensitively without mutating canonical output", () => {
    assert.doesNotThrow(() =>
      assertArcAgentJobRole("fund", job, CLIENT.toUpperCase().replace("0X", "0x"), "Open"),
    );
  });

  it("never treats the zero address as a role holder", () => {
    const unassigned = { client: CLIENT, provider: ZERO, evaluator: EVALUATOR } as const;
    assert.throws(() => assertArcAgentJobRole("submit", unassigned, ZERO, "Funded"), /zero address/i);
  });
});

describe("ERC-8183 input schemas", () => {
  it("requires an expiry past the deployed 5-minute floor", () => {
    const base = { provider: PROVIDER, evaluator: EVALUATOR, description: "Ship" };
    const now = Math.floor(Date.now() / 1000);

    // The contract reverts ExpiryTooShort at or below now + 5 minutes.
    assert.throws(
      () => arcAgentJobCreateInputSchema.parse({ ...base, expiredAt: String(now + 240) }),
      /5 minutes/i,
    );
    assert.doesNotThrow(() =>
      arcAgentJobCreateInputSchema.parse({ ...base, expiredAt: String(now + 3_600) }),
    );
  });

  it("requires a provider, because this tool surface has no setProvider", () => {
    assert.throws(
      () =>
        arcAgentJobCreateInputSchema.parse({
          evaluator: EVALUATOR,
          expiredAt: FUTURE,
          description: "Ship",
        }),
      /provider/i,
    );
  });

  it("rejects an uppercase bytes32 hash the database would refuse", () => {
    assert.throws(() => arcErc8183Bytes32Schema.parse(`0x${"AB".repeat(32)}`), /lowercase/i);
  });

  it("requires a future expiry, a non-zero evaluator, and a bounded description", () => {
    const base = { provider: PROVIDER, evaluator: EVALUATOR, expiredAt: FUTURE, description: "Ship the report" };

    assert.doesNotThrow(() => arcAgentJobCreateInputSchema.parse(base));
    assert.throws(() => arcAgentJobCreateInputSchema.parse({ ...base, evaluator: ZERO }), /evaluator/i);
    assert.throws(() => arcAgentJobCreateInputSchema.parse({ ...base, expiredAt: "1" }), /future/i);
    assert.throws(
      () => arcAgentJobCreateInputSchema.parse({ ...base, description: "x".repeat(2049) }),
      /description/i,
    );
  });

  it("rejects a zero-address provider", () => {
    const base = { evaluator: EVALUATOR, expiredAt: FUTURE, description: "Ship" };

    assert.equal(arcAgentJobCreateInputSchema.parse({ ...base, provider: PROVIDER }).provider, PROVIDER);
    assert.throws(() => arcAgentJobCreateInputSchema.parse({ ...base, provider: ZERO }), /provider|zero/i);
  });

  it("enforces exact six-decimal USDC budgets", () => {
    const base = { jobId: "1", amount: "10.5" };

    assert.equal(arcAgentJobBudgetInputSchema.parse(base).amount, "10.5");
    assert.throws(() => arcAgentJobBudgetInputSchema.parse({ ...base, amount: "0" }), /positive/i);
    assert.throws(() => arcAgentJobBudgetInputSchema.parse({ ...base, amount: "-1" }), /decimal|positive/i);
    assert.throws(() => arcAgentJobBudgetInputSchema.parse({ ...base, amount: "1.0000001" }), /six decimal/i);
    assert.throws(() => arcAgentJobBudgetInputSchema.parse({ ...base, amount: "1e6" }), /decimal/i);
    assert.throws(() => arcAgentJobBudgetInputSchema.parse({ ...base, amount: " " }), /decimal|positive/i);
  });

  it("binds funding to an expected budget so a changed budget cannot be paid silently", () => {
    const parsed = arcAgentJobFundInputSchema.parse({ jobId: "7", expectedBudget: "25.000000" });

    assert.equal(parsed.expectedBudget, "25.000000");
    assert.throws(() => arcAgentJobFundInputSchema.parse({ jobId: "7" }), /expectedBudget/i);
  });

  it("requires canonical bytes32 deliverable and reason hashes", () => {
    assert.equal(arcErc8183Bytes32Schema.parse(HASH), HASH);
    assert.throws(() => arcErc8183Bytes32Schema.parse("0xabc"), /bytes32/i);
    assert.throws(() => arcErc8183Bytes32Schema.parse("deliverable text"), /bytes32/i);
    assert.throws(() => arcErc8183Bytes32Schema.parse(`0x${"zz".repeat(32)}`), /bytes32/i);

    assert.doesNotThrow(() => arcAgentJobSubmitInputSchema.parse({ jobId: "1", deliverable: HASH }));
    assert.doesNotThrow(() => arcAgentJobCompleteInputSchema.parse({ jobId: "1", reason: HASH }));
    assert.doesNotThrow(() => arcAgentJobRejectInputSchema.parse({ jobId: "1", reason: HASH }));
  });

  it("fails rather than throws on malformed expiry through the FULL create schema", () => {
    // Guarding expiredAtSchema alone is not enough: the object-level refine
    // runs its own BigInt() on the raw input.
    const base = { provider: PROVIDER, evaluator: EVALUATOR, description: "Ship" };

    for (const bad of ["not-a-uint256", "1e3", "0x1", "", " "]) {
      const result = arcAgentJobCreateInputSchema.safeParse({ ...base, expiredAt: bad });
      assert.equal(result.success, false, `${bad} must fail, not throw`);
    }
  });

  it("fails rather than throws on non-numeric text", () => {
    // zod runs refinements after a failed regex, so an unguarded BigInt() here
    // would throw instead of returning a parse failure.
    for (const bad of ["not-a-uint256", "0x1", "1e3", ""]) {
      const result = arcAgentJobIdSchema.safeParse(bad);
      assert.equal(result.success, false, `${bad} must fail, not throw`);
    }
  });

  it("accepts only canonical uint256 job ids", () => {
    assert.equal(arcAgentJobIdSchema.parse("0"), "0");
    assert.throws(() => arcAgentJobIdSchema.parse("01"), /job id/i);
    assert.throws(() => arcAgentJobIdSchema.parse("-1"), /job id/i);
    assert.throws(() => arcAgentJobIdSchema.parse((2n ** 256n).toString()), /uint256/i);
    assert.doesNotThrow(() => arcAgentJobReadInputSchema.parse({ jobId: "12345" }));
  });

  it("leaves caller input immutable", () => {
    const input = { jobId: "1", amount: "1.5" };
    const frozen = Object.freeze({ ...input });

    arcAgentJobBudgetInputSchema.parse(frozen);
    assert.deepEqual(frozen, input);
  });
});

describe("ERC-8183 proof shape", () => {
  const TX = `0x${"cd".repeat(32)}`;
  const UINT256_MAX = (1n << 256n) - 1n;

  it("bounds the block number to uint256, which is exactly numeric(78,0)", () => {
    assert.equal(UINT256_MAX.toString().length, 78);

    assert.equal(
      arcAgentJobProofSchema.safeParse({ transactionHash: TX, blockNumber: UINT256_MAX.toString() })
        .success,
      true,
    );

    for (const [label, blockNumber] of [
      ["79 digits", "9".repeat(79)],
      ["100 digits", "1".repeat(100)],
      ["UINT256_MAX + 1", (UINT256_MAX + 1n).toString()],
    ] as const) {
      assert.equal(
        arcAgentJobProofSchema.safeParse({ transactionHash: TX, blockNumber }).success,
        false,
        `${label} overflows numeric(78,0) and must be refused before persistence`,
      );
    }
  });

  it("requires a canonical lowercase transaction hash", () => {
    for (const bad of [`0x${"CD".repeat(32)}`, "not-a-hash", "0xabc"]) {
      assert.equal(
        arcAgentJobProofSchema.safeParse({ transactionHash: bad, blockNumber: "1" }).success,
        false,
      );
    }
  });
});

describe("ERC-8183 expiry", () => {
  it("treats expiry as reached only once the deadline has passed", () => {
    assert.equal(isArcAgentJobExpired("100", 99), false);
    assert.equal(isArcAgentJobExpired("100", 100), true);
    assert.equal(isArcAgentJobExpired("100", 101), true);
  });
});
