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
 * Every write this module builds must satisfy the real adapter schema. No
 * allowances: the bytes32-vs-private-key conflict that once forced one is
 * fixed, so anything the adapter rejects is now a genuine defect.
 */
function assertAdapterAccepts(input: Record<string, unknown>): void {
  circleContractExecutionInputSchema.parse(input);
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
  readonly proveMutation?: () => { transactionHash: string; blockNumber: string; jobId?: string };
  readonly hookWhitelisted?: boolean;
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
      isHookWhitelisted: async () => options.hookWhitelisted ?? true,
    },
    proofReader: {
      proveMutation: async () => options.proveMutation?.() ?? { transactionHash: TX_HASH, blockNumber: "42", jobId: "1" },
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
      handlers.createAgentJob({ provider: PROVIDER, evaluator: EVALUATOR, expiredAt: "1", description: "x" }),
      /future/i,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a zero evaluator before touching the wallet", async () => {
    const { dependencies, calls } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({ provider: PROVIDER, evaluator: ZERO, expiredAt: FUTURE, description: "x" }),
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

  it("accepts a bytes32 hash at a bytes32 position but still rejects one elsewhere", () => {
    const bytes32 = `0x${"ab".repeat(32)}`;

    assert.doesNotThrow(() =>
      circleContractExecutionInputSchema.parse({
        contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        address: CLIENT,
        functionSignature: "complete(uint256,bytes32,bytes)",
        parameters: ["1", bytes32, "0x"],
      }),
    );

    assert.throws(
      () =>
        circleContractExecutionInputSchema.parse({
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: CLIENT,
          functionSignature: "transfer(address,uint256)",
          parameters: [bytes32, "1"],
        }),
      /private key/i,
      "the guard must still fire where the signature does not declare bytes32",
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

describe("wallet selection", () => {
  it("refuses when no authenticated Agent Wallet exists", async () => {
    const { dependencies } = harness({ wallets: [] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(handlers.getAgentJob({ jobId: "1" }).then(() =>
      handlers.createAgentJob({ provider: PROVIDER, evaluator: EVALUATOR, expiredAt: FUTURE, description: "x" }),
    ), /no authenticated circle agent wallet/i);
  });

  it("requires an explicit wallet when several are authenticated", async () => {
    const { dependencies } = harness({ wallets: [CLIENT, PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({ provider: PROVIDER, evaluator: EVALUATOR, expiredAt: FUTURE, description: "x" }),
      /walletAddress is required/i,
    );
  });

  it("refuses a wallet that is not authenticated", async () => {
    const { dependencies } = harness({ wallets: [CLIENT] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({
        provider: PROVIDER,
        evaluator: EVALUATOR,
        expiredAt: FUTURE,
        description: "x",
        walletAddress: EVALUATOR,
      }),
      /not an authenticated circle agent wallet/i,
    );
  });
});

describe("set_agent_job_budget", () => {
  it("writes the exact atomic budget and records it", async () => {
    const { dependencies, calls, saved } = harness({ wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.setAgentJobBudget({
      jobId: "1",
      amount: "12.345678",
      walletAddress: PROVIDER,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.functionSignature, "setBudget(uint256,uint256,bytes)");
    assert.deepEqual(calls[0]!.parameters, ["1", "12345678", "0x"]);
    assert.equal(output.status, "SUBMITTED");
    assert.equal(saved[0]!.budget, "12.345678");
  });

  it("refuses to change the budget once the job has left Open", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Funded" }), wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.setAgentJobBudget({ jobId: "1", amount: "1.5", walletAddress: PROVIDER }),
      /only be set while the job is Open/i,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses to set a budget on an expired job", async () => {
    const { dependencies, calls } = harness({ record: job({ expiredAt: "1699999999" }), wallets: [PROVIDER] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.setAgentJobBudget({ jobId: "1", amount: "1.5", walletAddress: PROVIDER }),
      /expired/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("reject_agent_job", () => {
  it("lets the client reject while the job is still Open", async () => {
    const { dependencies, calls, events } = harness({ record: job({ state: "Open" }) });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.rejectAgentJob({ jobId: "1", reason: HASH });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.functionSignature, "reject(uint256,bytes32,bytes)");
    assert.equal(output.status, "SUBMITTED");
    assert.equal(events[0]!.toState, "Rejected");
    assert.equal(events[0]!.reasonHash, HASH);
  });

  it("records no resulting state when the write outcome is ambiguous", async () => {
    const { dependencies, events } = harness({
      record: job({ state: "Open" }),
      executeContract: async () => {
        throw new Error("timeout");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.rejectAgentJob({ jobId: "1", reason: HASH });

    assert.equal(output.status, "RECONCILIATION_REQUIRED");
    assert.equal(events[0]!.toState, null, "an ambiguous write must not claim a resulting state");
    assert.equal(events[0]!.transactionHash, undefined);
  });
});

describe("durable state only advances on proven writes", () => {
  it("does not persist a job row when the JobCreated id cannot be proven", async () => {
    const { dependencies, saved, events } = harness({
      proveMutation: () => {
        throw new Error("receipt unavailable");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.createAgentJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: FUTURE,
      description: "Ship",
    });

    assert.equal(output.status, "RECONCILIATION_REQUIRED");
    assert.equal(saved.length, 0, "an empty job id violates the schema and a guess could duplicate the job");
  });

  it("never writes an event with a non-numeric job id after an unresolved create", async () => {
    // arc_agent_job_events.job_id is numeric(78,0) NOT NULL. Writing "" would
    // throw after the Circle mutation, hiding the reconciliation response and
    // inviting a duplicate retry.
    const { dependencies, events } = harness({
      proveMutation: () => {
        throw new Error("receipt unavailable");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    await handlers.createAgentJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: FUTURE,
      description: "Ship",
    });

    for (const event of events) {
      assert.notEqual(event.jobId, "", "an unresolved create must not invent a job id");
      if (event.jobId !== undefined && event.jobId !== null) {
        assert.match(String(event.jobId), /^(?:0|[1-9][0-9]*)$/);
      }
    }
  });

  it("returns reconciliation when the receipt verifies but JobCreated is not decoded", async () => {
    const { dependencies, saved } = harness({
      proveMutation: () => ({ transactionHash: TX_HASH, blockNumber: "42" }),
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.createAgentJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: FUTURE,
      description: "Ship",
    });

    assert.equal(output.status, "RECONCILIATION_REQUIRED", "a create without its id is not a success");
    assert.equal(saved.length, 0);
  });

  it("persists the proven JobCreated id rather than an invented one", async () => {
    const { dependencies, saved } = harness({
      proveMutation: () => ({ transactionHash: TX_HASH, blockNumber: "42", jobId: "8183" }),
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.createAgentJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: FUTURE,
      description: "Ship",
    });

    assert.equal(output.jobId, "8183");
    assert.equal(saved[0]!.jobId, "8183");
    assert.equal(saved[0]!.description, "Ship", "Task 9 read model needs the description");
    assert.equal(saved[0]!.hook, ZERO);
  });

  it("treats a missing receipt as reconciliation, never as a state transition", async () => {
    const { dependencies, saved, events } = harness({
      record: job({ state: "Submitted" }),
      wallets: [EVALUATOR],
      proveMutation: () => {
        throw new Error("receipt unavailable");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.completeAgentJob({
      jobId: "1",
      reason: HASH,
      walletAddress: EVALUATOR,
    });

    assert.equal(output.status, "RECONCILIATION_REQUIRED");
    assert.equal(saved.length, 0, "unproven writes must not advance durable state");
    assert.equal(events[0]!.toState, null);
    assert.equal(events[0]!.transactionHash, undefined);
  });

  it("does not persist a new budget when the write outcome is ambiguous", async () => {
    const { dependencies, saved, events } = harness({
      wallets: [PROVIDER],
      executeContract: async () => {
        throw new Error("timeout");
      },
    });
    const handlers = createArcAgentJobHandlers(dependencies);

    const output = await handlers.setAgentJobBudget({
      jobId: "1",
      amount: "99.000000",
      walletAddress: PROVIDER,
    });

    assert.equal(output.status, "RECONCILIATION_REQUIRED");
    assert.equal(saved.length, 0, "an ambiguous setBudget must not be recorded as applied");
    assert.equal(events[0]!.toState, null);
  });

  it("propagates a definite pre-submission failure instead of calling it ambiguous", async () => {
    for (const code of ["INVALID_ARGUMENTS", "AUTH_REQUIRED", "TERMS_REQUIRED"]) {
      const { dependencies } = harness({
        record: job({ state: "Submitted" }),
        wallets: [EVALUATOR],
        executeContract: async () => {
          const error = new Error(`rejected: ${code}`) as Error & { code: string };
          error.code = code;
          throw error;
        },
      });
      const handlers = createArcAgentJobHandlers(dependencies);

      await assert.rejects(
        handlers.completeAgentJob({ jobId: "1", reason: HASH, walletAddress: EVALUATOR }),
        new RegExp(code),
        `${code} never reaches the chain, so it must not be reported as ambiguous`,
      );
    }
  });
});

describe("state-aware role guards reach the handlers", () => {
  it("refuses a client rejecting a Funded job, which reverts on chain", async () => {
    const { dependencies, calls } = harness({ record: job({ state: "Funded" }), wallets: [CLIENT] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.rejectAgentJob({ jobId: "1", reason: HASH, walletAddress: CLIENT }),
      /evaluator/i,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a client setting the budget, which reverts on chain", async () => {
    const { dependencies, calls } = harness({ wallets: [CLIENT] });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.setAgentJobBudget({ jobId: "1", amount: "1.5", walletAddress: CLIENT }),
      /provider/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("advertised MCP schema matches what the handlers accept", () => {
  it("marks provider required, since Zod and SQL both require it", () => {
    assert.ok(
      (createAgentJobTool.inputSchema as { required: string[] }).required.includes("provider"),
      "advertising provider as optional tells clients an input is valid that always fails",
    );
  });

  it("advertises lowercase-only bytes32, matching the shared schema and the migration", () => {
    for (const tool of [submitAgentDeliverableTool, completeAgentJobTool, rejectAgentJobTool]) {
      const properties = (tool.inputSchema as { properties: Record<string, { pattern?: string }> })
        .properties;
      const hashProperty = properties.deliverable ?? properties.reason;

      assert.equal(hashProperty!.pattern, "^0x[0-9a-f]{64}$", `${tool.name} advertises mixed case`);
    }
  });
});

describe("hook whitelist precheck", () => {
  it("refuses a hook the contract has not whitelisted, before any wallet write", async () => {
    const { dependencies, calls } = harness({ hookWhitelisted: false });
    const handlers = createArcAgentJobHandlers(dependencies);

    await assert.rejects(
      handlers.createAgentJob({
        provider: PROVIDER,
        evaluator: EVALUATOR,
        expiredAt: FUTURE,
        description: "Ship",
        hook: "0x4444444444444444444444444444444444444444",
      }),
      /HookNotWhitelisted/i,
    );
    assert.equal(calls.length, 0, "a known revert must not consume a wallet mutation");
  });

  it("allows the default zero hook, which is whitelisted on chain", async () => {
    const { dependencies, calls } = harness();
    const handlers = createArcAgentJobHandlers(dependencies);

    await handlers.createAgentJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: FUTURE,
      description: "Ship",
    });

    assert.equal(calls.length, 1);
  });
});
