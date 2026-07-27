import {
  ARC_TESTNET,
  ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
  arcAgentJobBudgetInputSchema,
  arcAgentJobCompleteInputSchema,
  arcAgentJobCreateInputSchema,
  arcAgentJobFundInputSchema,
  arcAgentJobReadInputSchema,
  arcAgentJobRejectInputSchema,
  arcAgentJobSubmitInputSchema,
  assertArcAgentJobRole,
  assertArcAgentJobTransition,
  isArcAgentJobExpired,
  parseUsdcAtomic,
  type ArcAgentJobState,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";

const ARC_EXPLORER_TRANSACTION_BASE_URL = "https://testnet.arcscan.app/tx/";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_OPT_PARAMS = "0x";

/** The job tuple returned by `getJob`, already decoded and unit-normalised. */
export interface ArcAgentJobOnchainRecord {
  readonly id: string;
  readonly client: string;
  readonly provider: string;
  readonly evaluator: string;
  readonly description: string;
  /** Human-facing USDC, six decimals. Never the native 18-decimal view. */
  readonly budget: string;
  readonly expiredAt: string;
  readonly state: ArcAgentJobState;
  readonly hook: string;
}

export interface ArcAgentJobReader {
  getJob(jobId: string): Promise<ArcAgentJobOnchainRecord>;
  paymentToken(): Promise<string>;
  platformFeeBasisPoints(): Promise<number>;
  evaluatorFeeBasisPoints(): Promise<number>;
  /** Atomic units of the six-decimal USDC ERC-20 interface. */
  usdcAllowance(owner: string, spender: string): Promise<string>;
}

export interface ArcAgentJobProofReader {
  proveMutation(
    transactionId: string,
    expectation: { readonly contract: string; readonly jobId?: string },
  ): Promise<{ readonly transactionHash: string; readonly blockNumber: string }>;
}

export interface ArcAgentJobRecord {
  readonly jobId: string;
  readonly client: string;
  readonly provider: string;
  readonly evaluator: string;
  readonly budget: string;
  readonly expiredAt: string;
  readonly state: ArcAgentJobState;
  readonly contract: string;
  readonly chainId: number;
}

export interface ArcAgentJobLifecycleEvent {
  readonly jobId: string;
  readonly action: ArcAgentJobOperation;
  readonly fromState: ArcAgentJobState | null;
  readonly toState: ArcAgentJobState | null;
  readonly actor: string;
  readonly deliverableHash?: string;
  readonly reasonHash?: string;
  readonly circleTransactionId?: string;
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly explorerUrl?: string;
  readonly status: ArcAgentJobMutationStatus;
}

export interface ArcAgentJobRepository {
  saveJob(record: ArcAgentJobRecord): Promise<void>;
  appendEvent(event: ArcAgentJobLifecycleEvent): Promise<void>;
}

export interface ArcAgentJobDependencies {
  readonly circleCli: CircleCli;
  readonly reader: ArcAgentJobReader;
  readonly proofReader: ArcAgentJobProofReader;
  readonly repository: ArcAgentJobRepository;
  /** Injected clock, in unix seconds, so expiry tests stay deterministic. */
  readonly now: () => number;
}

export type ArcAgentJobOperation =
  | "CREATE"
  | "SET_BUDGET"
  | "FUND"
  | "SUBMIT"
  | "COMPLETE"
  | "REJECT";

export type ArcAgentJobMutationStatus = "SUBMITTED" | "RECONCILIATION_REQUIRED";

export interface ArcAgentJobMutationOutput {
  readonly status: ArcAgentJobMutationStatus;
  readonly operation: ArcAgentJobOperation;
  readonly jobId?: string;
  readonly circleTransactionId?: string;
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly explorerUrl?: string;
  readonly reconciliationRequired?: boolean;
  readonly reconciliationMessage?: string;
}

export interface ArcAgentJobReadOutput extends ArcAgentJobOnchainRecord {
  readonly contract: string;
  readonly chainId: number;
  readonly expired: boolean;
}

type ContractExecutionInput = Parameters<CircleCli["executeContract"]>[0];

function explorerUrl(transactionHash: string): string {
  return `${ARC_EXPLORER_TRANSACTION_BASE_URL}${transactionHash}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function selectWallet(circleCli: CircleCli, requested?: string): Promise<string> {
  const wallets = await circleCli.listAgentWallets();
  if (wallets.length === 0) {
    throw new Error("No authenticated Circle Agent Wallet is available.");
  }
  if (!requested && wallets.length > 1) {
    throw new Error("walletAddress is required when multiple Circle Agent Wallets exist.");
  }
  const selected = requested ?? wallets[0]?.address;
  const wallet = wallets.find((candidate) => sameAddress(candidate.address, selected ?? ""));
  if (!wallet) {
    throw new Error("walletAddress is not an authenticated Circle Agent Wallet.");
  }
  return wallet.address;
}

/**
 * Runs a mutating Circle CLI command exactly once. A thrown error means the
 * outcome is unknown, not that it failed — the command may already be on chain.
 * We never retry and never infer failure; we hand back a reconciliation state.
 */
async function submitOnce(
  dependencies: ArcAgentJobDependencies,
  operation: ArcAgentJobOperation,
  input: ContractExecutionInput,
  jobId?: string,
): Promise<ArcAgentJobMutationOutput> {
  let transaction;
  try {
    transaction = await dependencies.circleCli.executeContract(input);
  } catch {
    return {
      status: "RECONCILIATION_REQUIRED",
      operation,
      jobId,
      reconciliationRequired: true,
      reconciliationMessage:
        "The Circle CLI mutation outcome is ambiguous. Reconcile on Arcscan before any retry; the transaction may already be on chain.",
    };
  }

  let proof: { transactionHash: string; blockNumber: string } | undefined;
  try {
    proof = await dependencies.proofReader.proveMutation(transaction.id, {
      contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
      jobId,
    });
  } catch {
    proof = undefined;
  }

  const transactionHash = proof?.transactionHash ?? transaction.txHash;

  return {
    status: "SUBMITTED",
    operation,
    jobId,
    circleTransactionId: transaction.id,
    transactionHash,
    blockNumber: proof?.blockNumber,
    explorerUrl: transactionHash ? explorerUrl(transactionHash) : undefined,
  };
}

async function assertArcUsdcEscrow(dependencies: ArcAgentJobDependencies): Promise<string> {
  const token = await dependencies.reader.paymentToken();
  if (!sameAddress(token, ARC_TESTNET.usdcAddress)) {
    throw new Error(
      `The ERC-8183 escrow settles ${token}, not Arc Testnet USDC (${ARC_TESTNET.usdcAddress}). Refusing to fund.`,
    );
  }
  return token;
}

/**
 * Reads the job and enforces the guards every write shares: the chain state
 * must permit the transition, the job must not have expired, and the caller
 * must hold the required role.
 */
async function loadJobForWrite(
  dependencies: ArcAgentJobDependencies,
  jobId: string,
  wallet: string,
  action: Parameters<typeof assertArcAgentJobRole>[0],
  target: ArcAgentJobState,
): Promise<ArcAgentJobOnchainRecord> {
  const job = await dependencies.reader.getJob(jobId);

  assertArcAgentJobTransition(job.state, target);

  if (isArcAgentJobExpired(job.expiredAt, dependencies.now())) {
    throw new Error(
      `ERC-8183 job ${jobId} expired at ${job.expiredAt}; no further lifecycle write is valid.`,
    );
  }

  assertArcAgentJobRole(action, job, wallet);
  return job;
}

export function createArcAgentJobHandlers(dependencies: ArcAgentJobDependencies) {
  const record = async (
    job: ArcAgentJobOnchainRecord,
    state: ArcAgentJobState,
  ): Promise<void> => {
    await dependencies.repository.saveJob({
      jobId: job.id,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      budget: job.budget,
      expiredAt: job.expiredAt,
      state,
      contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
      chainId: ARC_TESTNET.chainId,
    });
  };

  const audit = async (
    event: Omit<ArcAgentJobLifecycleEvent, "status"> & { readonly status: ArcAgentJobMutationStatus },
  ): Promise<void> => {
    await dependencies.repository.appendEvent(event);
  };

  return {
    async createAgentJob(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobCreateInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);

      const output = await submitOnce(dependencies, "CREATE", {
        contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        address: wallet,
        functionSignature: "createJob(address,address,uint256,string,address)",
        parameters: [
          input.provider ?? ZERO_ADDRESS,
          input.evaluator,
          input.expiredAt,
          input.description,
          input.hook ?? ZERO_ADDRESS,
        ],
      } as ContractExecutionInput);

      await dependencies.repository.saveJob({
        // The job id is assigned on chain; it is recovered from the JobCreated
        // event during reconciliation rather than guessed here.
        jobId: output.jobId ?? "",
        client: wallet,
        provider: input.provider ?? ZERO_ADDRESS,
        evaluator: input.evaluator,
        budget: "0",
        expiredAt: input.expiredAt,
        state: "Open",
        contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        chainId: ARC_TESTNET.chainId,
      });

      await audit({
        jobId: output.jobId ?? "",
        action: "CREATE",
        fromState: null,
        toState: "Open",
        actor: wallet,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async setAgentJobBudget(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobBudgetInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);
      const job = await dependencies.reader.getJob(input.jobId);

      if (job.state !== "Open") {
        throw new Error(`A budget can only be set while the job is Open; job ${input.jobId} is ${job.state}.`);
      }
      if (isArcAgentJobExpired(job.expiredAt, dependencies.now())) {
        throw new Error(`ERC-8183 job ${input.jobId} expired at ${job.expiredAt}.`);
      }
      assertArcAgentJobRole("setBudget", job, wallet);

      const output = await submitOnce(
        dependencies,
        "SET_BUDGET",
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: wallet,
          functionSignature: "setBudget(uint256,uint256,bytes)",
          parameters: [input.jobId, parseUsdcAtomic(input.amount).toString(), EMPTY_OPT_PARAMS],
        } as ContractExecutionInput,
        input.jobId,
      );

      await record({ ...job, budget: input.amount }, job.state);
      await audit({
        jobId: input.jobId,
        action: "SET_BUDGET",
        fromState: job.state,
        toState: job.state,
        actor: wallet,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async fundAgentJob(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobFundInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);

      const token = await assertArcUsdcEscrow(dependencies);
      const job = await loadJobForWrite(dependencies, input.jobId, wallet, "fund", "Funded");

      if (sameAddress(job.provider, ZERO_ADDRESS)) {
        throw new Error(
          `ERC-8183 job ${input.jobId} has no provider assigned; assign one before funding escrow.`,
        );
      }

      // The deployed fund(uint256,bytes) takes no expectedBudget, so this guard
      // is read-compare-write and NOT atomic. A budget change landing between
      // this read and the write below would still be funded. Documented, not
      // hidden.
      if (job.budget !== input.expectedBudget) {
        throw new Error(
          `Budget changed: expected ${input.expectedBudget} USDC but the job now holds ${job.budget} USDC. Re-inspect before funding.`,
        );
      }

      const budgetAtomic = parseUsdcAtomic(input.expectedBudget);
      const allowance = BigInt(
        await dependencies.reader.usdcAllowance(wallet, ARC_TESTNET_ERC8183_AGENTIC_COMMERCE),
      );

      // Approve exactly the budget when short. Never an unlimited allowance.
      if (allowance < budgetAtomic) {
        const approval = await submitOnce(
          dependencies,
          "FUND",
          {
            contract: token,
            address: wallet,
            functionSignature: "approve(address,uint256)",
            parameters: [ARC_TESTNET_ERC8183_AGENTIC_COMMERCE, budgetAtomic.toString()],
          } as ContractExecutionInput,
          input.jobId,
        );

        if (approval.status === "RECONCILIATION_REQUIRED") return approval;
      }

      const output = await submitOnce(
        dependencies,
        "FUND",
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: wallet,
          functionSignature: "fund(uint256,bytes)",
          parameters: [input.jobId, EMPTY_OPT_PARAMS],
        } as ContractExecutionInput,
        input.jobId,
      );

      if (output.status === "SUBMITTED") await record(job, "Funded");
      await audit({
        jobId: input.jobId,
        action: "FUND",
        fromState: job.state,
        toState: output.status === "SUBMITTED" ? "Funded" : null,
        actor: wallet,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async submitAgentDeliverable(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobSubmitInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);
      const job = await loadJobForWrite(dependencies, input.jobId, wallet, "submit", "Submitted");

      const output = await submitOnce(
        dependencies,
        "SUBMIT",
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: wallet,
          functionSignature: "submit(uint256,bytes32,bytes)",
          parameters: [input.jobId, input.deliverable, EMPTY_OPT_PARAMS],
        } as ContractExecutionInput,
        input.jobId,
      );

      if (output.status === "SUBMITTED") await record(job, "Submitted");
      await audit({
        jobId: input.jobId,
        action: "SUBMIT",
        fromState: job.state,
        toState: output.status === "SUBMITTED" ? "Submitted" : null,
        actor: wallet,
        deliverableHash: input.deliverable,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async completeAgentJob(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobCompleteInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);
      const job = await loadJobForWrite(dependencies, input.jobId, wallet, "complete", "Completed");

      const output = await submitOnce(
        dependencies,
        "COMPLETE",
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: wallet,
          functionSignature: "complete(uint256,bytes32,bytes)",
          parameters: [input.jobId, input.reason, EMPTY_OPT_PARAMS],
        } as ContractExecutionInput,
        input.jobId,
      );

      if (output.status === "SUBMITTED") await record(job, "Completed");
      await audit({
        jobId: input.jobId,
        action: "COMPLETE",
        fromState: job.state,
        toState: output.status === "SUBMITTED" ? "Completed" : null,
        actor: wallet,
        reasonHash: input.reason,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async rejectAgentJob(rawInput: unknown): Promise<ArcAgentJobMutationOutput> {
      const input = arcAgentJobRejectInputSchema.parse(rawInput);
      const wallet = await selectWallet(dependencies.circleCli, input.walletAddress);
      const job = await loadJobForWrite(dependencies, input.jobId, wallet, "reject", "Rejected");

      const output = await submitOnce(
        dependencies,
        "REJECT",
        {
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          address: wallet,
          functionSignature: "reject(uint256,bytes32,bytes)",
          parameters: [input.jobId, input.reason, EMPTY_OPT_PARAMS],
        } as ContractExecutionInput,
        input.jobId,
      );

      if (output.status === "SUBMITTED") await record(job, "Rejected");
      await audit({
        jobId: input.jobId,
        action: "REJECT",
        fromState: job.state,
        toState: output.status === "SUBMITTED" ? "Rejected" : null,
        actor: wallet,
        reasonHash: input.reason,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
      });

      return output;
    },

    async getAgentJob(rawInput: unknown): Promise<ArcAgentJobReadOutput> {
      const input = arcAgentJobReadInputSchema.parse(rawInput);
      const job = await dependencies.reader.getJob(input.jobId);

      return {
        ...job,
        contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        chainId: ARC_TESTNET.chainId,
        // The chain state is reported verbatim; expiry is a derived flag so we
        // never claim a state the contract did not report.
        expired: isArcAgentJobExpired(job.expiredAt, dependencies.now()),
      };
    },
  };
}

const walletProperty = {
  walletAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
} as const;

const jobIdProperty = { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" } as const;
const hashProperty = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } as const;
const addressProperty = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required: [...required] };
}

export const createAgentJobTool = {
  name: "create_agent_job",
  description:
    "Create an ERC-8183 agent job on Arc Testnet with a required evaluator and future expiry.",
  inputSchema: objectSchema(
    {
      ...walletProperty,
      provider: addressProperty,
      evaluator: addressProperty,
      expiredAt: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
      description: { type: "string", minLength: 1, maxLength: 2_048 },
      hook: addressProperty,
    },
    ["evaluator", "expiredAt", "description"],
  ),
} as const;

export const setAgentJobBudgetTool = {
  name: "set_agent_job_budget",
  description: "Set the exact six-decimal Arc USDC budget of an Open ERC-8183 job.",
  inputSchema: objectSchema(
    {
      ...walletProperty,
      jobId: jobIdProperty,
      amount: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$" },
    },
    ["jobId", "amount"],
  ),
} as const;

export const fundAgentJobTool = {
  name: "fund_agent_job",
  description:
    "Fund an ERC-8183 job escrow in Arc USDC after confirming the on-chain budget still matches expectedBudget. The deployed contract offers no atomic expected-budget guard, so a race remains.",
  inputSchema: objectSchema(
    {
      ...walletProperty,
      jobId: jobIdProperty,
      expectedBudget: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$" },
    },
    ["jobId", "expectedBudget"],
  ),
} as const;

export const submitAgentDeliverableTool = {
  name: "submit_agent_deliverable",
  description: "Submit a canonical bytes32 deliverable hash for a Funded ERC-8183 job.",
  inputSchema: objectSchema(
    { ...walletProperty, jobId: jobIdProperty, deliverable: hashProperty },
    ["jobId", "deliverable"],
  ),
} as const;

export const completeAgentJobTool = {
  name: "complete_agent_job",
  description: "Complete a Submitted ERC-8183 job as the evaluator and release escrow.",
  inputSchema: objectSchema(
    { ...walletProperty, jobId: jobIdProperty, reason: hashProperty },
    ["jobId", "reason"],
  ),
} as const;

export const rejectAgentJobTool = {
  name: "reject_agent_job",
  description: "Reject an ERC-8183 job with a canonical bytes32 reason hash.",
  inputSchema: objectSchema(
    { ...walletProperty, jobId: jobIdProperty, reason: hashProperty },
    ["jobId", "reason"],
  ),
} as const;

export const getAgentJobTool = {
  name: "get_agent_job",
  description:
    "Read an ERC-8183 job's participants, budget, expiry, and lifecycle state from Arc Testnet.",
  inputSchema: objectSchema({ jobId: jobIdProperty }, ["jobId"]),
} as const;

export const arcAgentJobTools = Object.freeze([
  createAgentJobTool,
  setAgentJobBudgetTool,
  fundAgentJobTool,
  submitAgentDeliverableTool,
  completeAgentJobTool,
  rejectAgentJobTool,
  getAgentJobTool,
] as const);
