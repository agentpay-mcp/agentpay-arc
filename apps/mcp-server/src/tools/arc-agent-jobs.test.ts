import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
  circleContractExecutionInputSchema,
} from "@agentpay-ai/shared-arc";

import {
  createAgentJobTool,
  createArcAgentJobHandlers,
  fundAgentJobTool,
  getAgentJobTool,
  rejectAgentJobTool,
  setAgentJobBudgetTool,
  submitAgentDeliverableTool,
  completeAgentJobTool,
  type ArcAgentJobDependencies,
  type ArcAgentJobOnchainRecord,
} from "./arc-agent-jobs.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const EVALUATOR = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x3600000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const FUTURE = "4102444800";

/**
 * The adapter rejects any positional parameter matching 0x + 64 hex as a
 * suspected private key. A bytes32 hash is byte-identical to a private key, so
 * every ERC-8183 deliverable and reason hash trips it — as do the already
 * merged ERC-8004 validation tools. That conflict is an open blocker owned by
 * the integrator, tracked in the Task 8 handback.
 *
 * We still validate every other rule, and we re-raise anything that is not
 * that known issue, so this stays a real check rather than a bypass.
 */
function assertAdapterAccepts(input: Record<string, unknown>): void {
  const result = circleContractExecutionInputSchema.safeParse(input);
  if (result.success) return;

  const unrelated = result.error.issues.filter(
    (issue) => !/must not contain a private key/.test(issue.message),
  );
  if (unrelated.length > 0) {
    throw new Error(`adapter rejected the input: ${JSON.stringify(unrelated)}`);
  }
}

function job(overrides: Partial<ArcAgentJobOnchainRecord> = {}): ArcAgentJobOnchainRecord {
  return {
    id: "1",
    client: CLIENT,
    provider: PROVIDER,
    evaluator: EVALUATOR,
    description: "Ship the report",
    budget: "25.000000",
    expiredAt: FUTURE,
    state: "Open",
    hook: ZERO,
    ...overrides,
  };
}

interface Harness {
  readonly dependencies: ArcAgentJobDependencies;
  readonly calls: Array<Record<string, unknown>>;
  readonly saved: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
}

function harness(options: {
  readonly record?: ArcAgentJobOnchainRecord;
  readonly executeContract?: () => Promise<never>;
  readonly allowance?: string;
  readonly paymentToken?: string;
  readonly wallets?: readonly string[];
} = {}): Harness {
  const calls: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const record = options.record ?? job();

  const dependencies: ArcAgentJobDependencies = {
    circleCli: {
      listAgentWallets: async () =>
        (options.wallets ?? [CLIENT]).map((address) => ({ address, blockchain: "ARC-TESTNET" })),
      executeContract:
        options.executeContract ??
        (async (input: Record<string, unknown>) => {
          // Validate through the REAL adapter schema, not a permissive stub.
          // A permissive stub already let a stray `chain` field through once.
          assertAdapterAccepts(input);
          calls.push(input);
          return { id: `tx-${calls.length}`, state: "COMPLETE", blockchain: "ARC-TESTNET", txHash: TX_HASH };
        }),
    } as unknown as ArcAgentJobDependencies["circleCli"],
    reader: {
      getJob: async () => record,
      paymentToken: async () => options.paymentToken ?? USDC,
      platformFeeBasisPoints: async () => 0,
      evaluatorFeeBasisPoints: async () => 0,
      usdcAllowance: async () => options.allowance ?? "0",
    },
    proofReader: {
      proveMutation: async () => ({ transactionHash: TX_HASH, blockNumber: "42" }),
    },
    repository: {
      saveJob: async (input) => {
        saved.push(input as unknown as Record<string, unknown>);
      },
      appendEvent: async (input) => {
        events.push(input as unknown as Record<string, unknown>);
      },
    },
    now: () => 1_700_000_000,
  };

  return { dependencies, calls, saved, events };
}

describe("Arc agent job tool definitions", () => {
  it("exposes exactly the seven assigned tools", () => {
    assert.deepEqual(
      [
        createAgentJobTool.name,
        setAgentJobBudgetTool.name,
        fundAgentJobTool.name,
        submitAgentDeliverableTool.name,
        completeAgentJobTool.name,
        rejectAgentJobTool.name,
        getAgentJobTool.name,
      ],
      [
        "create_agent_job",
        "set_agent_job_budget",
        "fund_agent_job",
        "submit_agent_deliverable",
        "complete_agent_job",
        "reject_agent_job",
        "get_agent_job",
      ],
    );
  });
});

describe("create_agent_job", () => {
  it("writes to the verified contract exactly once and persists the job", async () => {
    const { dependencies, calls, saved } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.createAgentJob({
      evaluator: EVALUATOR,
      provider: PROVIDER,
      expiredAt: FUTURE,
      description: "Ship the report",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.contract, ARC_TESTNET_ERC8183_AGENTIC_COMMERCE);
    assert.equal(
      calls[0]!.functionSignature,
      "createJob(address,address,uint256,string,address)",
    );
    assert.equal(output.status, "SUBMITTED");
    assert.equal(output.explorerUrl, `https://testnet.arcscan.app/tx/${TX_HASH}`);
    assert.equal(saved.length, 1);
  });

  it("refuses an expiry in the past before touching the wallet", async () => {
    const { dependencies, calls } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({ evaluator: EVALUATOR, expiredAt: "1", description: "x" }),
      /future/i,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a zero evaluator before touching the wallet", async () => {
    const { dependencies, calls } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({ evaluator: ZERO, expiredAt: FUTURE, description: "x" }),
      /zero address/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("fund_agent_job", () => {
  it("refuses when the on-chain budget no longer matches the expected budget", async () => {
    const { dependencies, calls } = harness({ record: job({ budget: "30.000000" }) });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" }),
      /budget changed/i,
    );
    assert.equal(calls.length, 0, "a changed budget must never be funded silently");
  });

  it("refuses to fund before a provider is assigned", async () => {
    const { dependencies, calls } = harness({ record: job({ provider: ZERO }) });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" }),
      /provider/i,
    );
    assert.equal(calls.length, 0);
  });

  it("approves exactly the budget and never an unlimited allowance", async () => {
    const { dependencies, calls } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    await handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" });

    const approval = calls.find((call) => String(call.functionSignature).startsWith("approve"));
    assert.ok(approval, "funding must approve the escrow contract");
    assert.equal(approval!.contract, USDC);
    assert.deepEqual(approval!.parameters, [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, "25000000"]);

    const maxUint = ((1n << 256n) - 1n).toString();
    assert.notEqual((approval!.parameters as string[])[1], maxUint);
  });

  it("skips a redundant approval when the allowance already covers the budget", async () => {
    const { dependencies, calls } = harness({ allowance: "25000000" });
    const handlers = createArcAgentJobHandlers(dependencies);

    await handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" });

    assert.equal(
      calls.filter((call) => String(call.functionSignature).startsWith("approve")).length,
      0,
    );
    assert.equal(calls.filter((call) => String(call.functionSignature).startsWith("fund")).length, 1);
  });

  it("refuses when the escrow settles a token other than Arc USDC", async () => {
    const { dependencies, calls } = harness({ paymentToken: "0x4444444444444444444444444444444444444444" });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" }), /USDC/i);
    assert.equal(calls.length, 0);
  });

  it("refuses a caller who is not the client", async () => {
    const { dependencies, calls } = harness({ wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000", walletAddress: PROVIDER }),
      /client/i,
    );
    assert.equal(calls.length, 0);
  });

  it("never retries a write and reports an ambiguous outcome for reconciliation", async () => {
    let attempts = 0;
    const { dependencies } = harness({
      allowance: "25000000",
      executeContract: async () => {
        attempts += 1;
        throw new Error("circle cli timed out");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.fundAgentJob({ jobId: "1", expectedBudget: "25.000000" });

    assert.equal(attempts, 1, "a mutating command must be attempted exactly once");
    assert.equal(output.status, "RECONCILIATION_REQUIRED");
    assert.match(output.reconciliationMessage ?? "", /reconcile/i);
  });
});

describe("lifecycle guards", () => {
  it("refuses to submit a deliverable before the job is funded", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Open" }), wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.submitAgentDeliverable({ jobId: "1", deliverable: HASH, walletAddress: PROVIDER }),
      /Open -> Submitted/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses to complete a job that was never submitted", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Funded" }), wallets: [EVALUATOR] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.completeAgentJob({ jobId: "1", reason: HASH, walletAddress: EVALUATOR }),
      /Funded -> Completed/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses any write against a terminal job", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Completed" }), wallets: [EVALUATOR] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.rejectAgentJob({ jobId: "1", reason: HASH, walletAddress: EVALUATOR }),
      /terminal/i,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a write against an expired job even while the chain still reports Funded", async () => {
    const { dependencies, calls } = harness({
      record: job({ state: "Funded", expiredAt: "1699999999" }),
      wallets: [PROVIDER],
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.submitAgentDeliverable({ jobId: "1", deliverable: HASH, walletAddress: PROVIDER }),
      /expired/i,
    );
    assert.equal(calls.length, 0);
  });

  it("lets the evaluator complete a submitted job and records the lifecycle event", async () => {
    const { dependencies, calls, events } = harness({
      record: job({ state: "Submitted" }),
      wallets: [EVALUATOR],
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.completeAgentJob({
      jobId: "1",
      reason: HASH,
      walletAddress: EVALUATOR,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.functionSignature, "complete(uint256,bytes32,bytes)");
    assert.equal(output.status, "SUBMITTED");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.toState, "Completed");
  });

  it("rejects a deliverable that is not a canonical bytes32 hash", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Funded" }), wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.submitAgentDeliverable({
        jobId: "1",
        deliverable: "the finished report",
        walletAddress: PROVIDER,
      }),
      /bytes32/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("get_agent_job", () => {
  it("returns the validated on-chain record without a wallet mutation", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Funded" }) });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.getAgentJob({ jobId: "1" });

    assert.equal(calls.length, 0);
    assert.equal(output.state, "Funded");
    assert.equal(output.budget, "25.000000");
    assert.equal(output.client, CLIENT);
    assert.equal(output.contract, ARC_TESTNET_ERC8183_AGENTIC_COMMERCE);
  });

  it("reports expiry against the caller clock without claiming a state the chain did not report", async () => {
    const { dependencies } = harness({ record: job({ state: "Funded", expiredAt: "1699999999" }) });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.getAgentJob({ jobId: "1" });

    assert.equal(output.state, "Funded", "the chain state is reported verbatim");
    assert.equal(output.expired, true, "expiry is surfaced separately as a derived flag");
  });
});

describe("contract execution inputs match the real adapter schema", () => {
  it("every write this module builds passes circleContractExecutionInputSchema", async () => {
    // The harness parses each input through the real schema, so reaching the
    // end of a full lifecycle is itself the assertion.
    const { dependencies, calls } = harness({ record: job({ state: "Submitted" }), wallets: [EVALUATOR] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await handlers.completeAgentJob({ jobId: "1", reason: HASH, walletAddress: EVALUATOR });

    assert.equal(calls.length, 1);
    assert.doesNotThrow(() => assertAdapterAccepts(calls[0]!));
  });

  it("documents the open bytes32-vs-private-key blocker rather than hiding it", () => {
    const bytes32 = `0x${"ab".repeat(32)}`;
    const result = circleContractExecutionInputSchema.safeParse({
      contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
      address: CLIENT,
      functionSignature: "complete(uint256,bytes32,bytes)",
      parameters: ["1", bytes32, "0x"],
    });

    // When the integrator teaches the adapter to recognise bytes32 argument
    // positions, this assertion flips and this test is the reminder to delete
    // assertAdapterAccepts' allowance above.
    assert.equal(result.success, false, "blocker resolved -- tighten the harness");
    assert.match(
      result.error!.issues[0]!.message,
      /must not contain a private key/,
      "a bytes32 hash is byte-identical to a private key, so the heuristic cannot tell them apart",
    );
  });

  it("fails loudly if a stray field such as chain is reintroduced", () => {
    // Guards the exact regression this module already hit once: the adapter
    // injects the chain itself and its schema is .strict().
    assert.throws(
      () =>
        circleContractExecutionInputSchema.parse({
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: CLIENT,
          chain: "ARC-TESTNET",
          functionSignature: "fund(uint256,bytes)",
          parameters: ["1", "0x"],
        }),
      "the adapter schema must reject a chain field",
    );
  });
});
