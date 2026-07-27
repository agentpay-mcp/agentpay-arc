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
  /**
   * `createJob` reverts HookNotWhitelisted for an unlisted hook. Verified on
   * chain that the zero address IS whitelisted, so the default path is safe.
   */
  isHookWhitelisted(hook: string): Promise<boolean>;
}

export interface ArcAgentJobProofReader {
  /**
   * Resolves only when a receipt is verified. For a create, `jobId` carries the
   * id decoded from the `JobCreated` event — the only place it exists, since
   * `createJob` assigns it on chain.
   */
  proveMutation(
    transactionId: string,
    expectation: { readonly contract: string; readonly jobId?: string },
  ): Promise<{
    readonly transactionHash: string;
    readonly blockNumber: string;
    readonly jobId?: string;
  }>;
}

export interface ArcAgentJobRecord {
  readonly jobId: string;
  readonly description: string;
  readonly hook: string;
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
 * Errors that prove the command never reached the chain. The adapter validates
 * arguments and session state before it spawns anything, so these are definite
 * failures — reporting them as ambiguous would send the user to Arcscan to look
 * for a transaction that cannot exist.
 */
const DEFINITE_NO_SUBMISSION_CODES = new Set(["INVALID_ARGUMENTS", "AUTH_REQUIRED", "TERMS_REQUIRED"]);

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Runs a mutating Circle CLI command exactly once, then proves it landed.
 *
 * Three outcomes, deliberately distinct:
 *  - the adapter refused before submitting  -> throw, nothing happened
 *  - submitted and proven                   -> SUBMITTED, safe to advance state
 *  - submitted but unproven, or unknown     -> RECONCILIATION_REQUIRED
 *
 * A missing proof is NOT success. Without a verified receipt we cannot say the
 * transaction landed, so durable state must not advance on it.
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
  } catch (error) {
    if (DEFINITE_NO_SUBMISSION_CODES.has(errorCodeOf(error) ?? "")) throw error;

    return {
      status: "RECONCILIATION_REQUIRED",
      operation,
      jobId,
      reconciliationRequired: true,
      reconciliationMessage:
        "The Circle CLI mutation outcome is ambiguous. Reconcile on Arcscan before any retry; the transaction may already be on chain.",
    };
  }

  try {
    const proof = await dependencies.proofReader.proveMutation(transaction.id, {
      contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
      jobId,
    });

    return {
      status: "SUBMITTED",
      operation,
      jobId: proof.jobId ?? jobId,
      circleTransactionId: transaction.id,
      transactionHash: proof.transactionHash,
      blockNumber: proof.blockNumber,
      explorerUrl: explorerUrl(proof.transactionHash),
    };
  } catch {
    return {
      status: "RECONCILIATION_REQUIRED",
      operation,
      jobId,
      circleTransactionId: transaction.id,
      reconciliationRequired: true,
      reconciliationMessage:
        "The transaction was submitted but no receipt could be verified. Confirm it on Arcscan before treating the job state as advanced.",
    };
  }
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

  assertArcAgentJobRole(action, job, wallet, job.state);
  return job;
}

export function createArcAgentJobHandlers(dependencies: ArcAgentJobDependencies) {
  const record = async (
    job: ArcAgentJobOnchainRecord,
    state: ArcAgentJobState,
  ): Promise<void> => {
    await dependencies.repository.saveJob({
      jobId: job.id,
      description: job.description,
      hook: job.hook,
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
      const hook = input.hook ?? ZERO_ADDRESS;

      // A non-whitelisted hook is a known revert. Refuse before spending a
      // wallet mutation on a call that cannot succeed.
      if (!(await dependencies.reader.isHookWhitelisted(hook))) {
        throw new Error(
          `Hook ${hook} is not whitelisted by the ERC-8183 contract; createJob would revert HookNotWhitelisted.`,
        );
      }

      const submitted = await submitOnce(dependencies, "CREATE", {
        contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
        address: wallet,
        functionSignature: "createJob(address,address,uint256,string,address)",
        parameters: [
          input.provider,
          input.evaluator,
          input.expiredAt,
          input.description,
          hook,
        ],
      } as ContractExecutionInput);

      // The id exists only in JobCreated. A receipt that verifies without
      // decoding it is still not a usable create: both SQL tables require a
      // numeric job_id, so persisting "" would throw AFTER the onchain
      // mutation, hide the reconciliation response, and invite a duplicate
      // retry. Downgrade to reconciliation instead.
      const output: ArcAgentJobMutationOutput =
        submitted.status === "SUBMITTED" && !submitted.jobId
          ? {
              ...submitted,
              status: "RECONCILIATION_REQUIRED",
              reconciliationRequired: true,
              reconciliationMessage:
                "The create transaction was verified but its JobCreated id could not be decoded. Recover the job id from Arcscan before retrying; retrying blind would create a second job.",
            }
          : submitted;

      if (output.status === "SUBMITTED" && output.jobId) {
        await dependencies.repository.saveJob({
          jobId: output.jobId,
          description: input.description,
          hook,
          client: wallet,
          provider: input.provider,
          evaluator: input.evaluator,
          budget: "0",
          expiredAt: input.expiredAt,
          state: "Open",
          contract: ARC_TESTNET_ERC8183_AGENTIC_COMMERCE,
          chainId: ARC_TESTNET.chainId,
        });
      }

      // Only audit a create once its numeric id is known. An unresolved create
      // is surfaced through the returned reconciliation message, never through
      // an event row the repository cannot accept.
      if (output.jobId) {
        await audit({
        jobId: output.jobId,
        action: "CREATE",
        fromState: null,
        toState: output.status === "SUBMITTED" ? "Open" : null,
        actor: wallet,
        circleTransactionId: output.circleTransactionId,
        transactionHash: output.transactionHash,
        blockNumber: output.blockNumber,
        explorerUrl: output.explorerUrl,
        status: output.status,
        });
      }

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
      assertArcAgentJobRole("setBudget", job, wallet, job.state);

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

      if (output.status === "SUBMITTED") await record({ ...job, budget: input.amount }, job.state);
      await audit({
        jobId: input.jobId,
        action: "SET_BUDGET",
        fromState: job.state,
        toState: output.status === "SUBMITTED" ? job.state : null,
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
// Lowercase only: the shared schema and the SQL constraint both reject mixed case.
const hashProperty = { type: "string", pattern: "^0x[0-9a-f]{64}$" } as const;
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
    // provider is required: this surface has no setProvider, so a job without
    // one can never be funded. Advertising it as optional would tell clients an
    // input is valid that the handler always rejects.
    ["provider", "evaluator", "expiredAt", "description"],
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
