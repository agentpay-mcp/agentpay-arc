import { z } from "zod";

/**
 * ERC-8183 Agentic Commerce on Arc Testnet.
 *
 * The address below is the AgenticCommerce reference implementation named in
 * Arc's own tutorial. It is an ERC-1967 proxy; the implementation behind it was
 * 0xa316fd02827242d537f84730f8a37d0ba5fd351a when this ABI was verified on
 * 27 July 2026. Because the proxy is upgradeable, re-resolve the implementation
 * slot before trusting a cached ABI.
 *
 * Every signature in `erc8183AgenticCommerceAbi` was confirmed present in the
 * deployed implementation bytecode by selector. Two deviations matter:
 *
 *  1. The EIP draft's `IAgenticCommerce` declares
 *     `fund(uint256 jobId, uint256 expectedBudget)`. That overload does NOT
 *     exist on chain — selector 0xa65e2cfd is absent. The deployed contract
 *     exposes only `fund(uint256,bytes)`, so there is no atomic on-chain guard
 *     binding a caller's expected budget to the funded amount. Callers must
 *     read the budget, compare, then write, and must not describe that as
 *     atomic: a TOCTOU window remains.
 *  2. `getJob` does not return the deliverable hash. Index the `Submitted`
 *     event to recover it.
 */
export const ARC_TESTNET_ERC8183_AGENTIC_COMMERCE =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;

export const erc8183AgenticCommerceAbi = Object.freeze([
  "function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)",
  "function setProvider(uint256 jobId,address provider)",
  "function setBudget(uint256 jobId,uint256 amount,bytes optParams)",
  "function fund(uint256 jobId,bytes optParams)",
  "function submit(uint256 jobId,bytes32 deliverable,bytes optParams)",
  "function complete(uint256 jobId,bytes32 reason,bytes optParams)",
  "function reject(uint256 jobId,bytes32 reason,bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook)",
  "function paymentToken() view returns (address)",
  "function platformFeeBP() view returns (uint256)",
  "function evaluatorFeeBP() view returns (uint256)",
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
] as const);

/** Index order is the deployed `status` uint8. Do not reorder. */
export const ARC_ERC8183_JOB_STATES = Object.freeze([
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Expired",
] as const);

export type ArcAgentJobState = (typeof ARC_ERC8183_JOB_STATES)[number];

export const arcAgentJobStateSchema = z.enum(ARC_ERC8183_JOB_STATES);

const TERMINAL_STATES: readonly ArcAgentJobState[] = ["Completed", "Rejected", "Expired"];

const ALLOWED_TRANSITIONS: Readonly<Record<ArcAgentJobState, readonly ArcAgentJobState[]>> =
  Object.freeze({
    Open: ["Funded", "Rejected"],
    Funded: ["Submitted", "Rejected", "Expired"],
    Submitted: ["Completed", "Rejected", "Expired"],
    Completed: [],
    Rejected: [],
    Expired: [],
  });

export function jobStateFromOnchainStatus(status: number): ArcAgentJobState {
  if (!Number.isInteger(status) || status < 0 || status >= ARC_ERC8183_JOB_STATES.length) {
    throw new Error(`Unknown ERC-8183 job status: ${status}.`);
  }
  return ARC_ERC8183_JOB_STATES[status]!;
}

export function assertArcAgentJobTransition(
  from: ArcAgentJobState,
  to: ArcAgentJobState,
): void {
  if (TERMINAL_STATES.includes(from)) {
    throw new Error(`ERC-8183 job state ${from} is terminal; no transition to ${to} is possible.`);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ERC-8183 job transition ${from} -> ${to}.`);
  }
}

export type ArcAgentJobAction =
  | "setProvider"
  | "setBudget"
  | "fund"
  | "submit"
  | "complete"
  | "reject";

export interface ArcAgentJobParticipants {
  readonly client: string;
  readonly provider: string;
  readonly evaluator: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The deployed contract reverts ExpiryTooShort at or below this margin. */
export const ARC_ERC8183_MINIMUM_EXPIRY_SECONDS = 300;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Roles as the DEPLOYED reference implementation enforces them, not as the
 * EIP's illustrative flow narrates them. The prose example shows
 * "Client -> setBudget", but the reference implementation reverts unless
 * `msg.sender == job.provider`. Deployed behaviour wins.
 *
 * `reject` is state-sensitive on chain:
 *   Open              -> client only
 *   Funded, Submitted -> evaluator only
 *   otherwise         -> WrongStatus
 *
 * A role table that ignores state would accept calls that are certain to
 * revert, so callers must pass the job's current state.
 */
type RoleResolver = (state: ArcAgentJobState) => readonly (keyof ArcAgentJobParticipants)[];

const ACTION_ROLES: Readonly<Record<ArcAgentJobAction, RoleResolver>> = Object.freeze({
  setProvider: () => ["client"],
  setBudget: () => ["provider"],
  fund: () => ["client"],
  submit: () => ["provider"],
  complete: () => ["evaluator"],
  reject: (state: ArcAgentJobState) => (state === "Open" ? ["client"] : ["evaluator"]),
} satisfies Record<ArcAgentJobAction, RoleResolver>);

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function assertArcAgentJobRole(
  action: ArcAgentJobAction,
  participants: ArcAgentJobParticipants,
  caller: string,
  state: ArcAgentJobState,
): void {
  const normalizedCaller = normalizeAddress(caller);

  if (!ADDRESS_PATTERN.test(normalizedCaller)) {
    throw new Error(`Caller ${caller} is not a valid Arc address.`);
  }
  if (normalizedCaller === ZERO_ADDRESS) {
    throw new Error("The zero address can never hold an ERC-8183 job role.");
  }

  const roles = ACTION_ROLES[action](state);
  const matched = roles.some((role) => {
    const holder = normalizeAddress(participants[role]);
    return holder !== ZERO_ADDRESS && holder === normalizedCaller;
  });

  if (!matched) {
    throw new Error(
      `ERC-8183 action ${action} on a ${state} job requires the ${roles.join(" or ")} role; caller ${caller} does not hold it.`,
    );
  }
}

export function isArcAgentJobExpired(expiredAt: string, nowSeconds: number): boolean {
  return BigInt(nowSeconds) >= BigInt(expiredAt);
}

export const arcAgentJobIdSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)$/, "Expected a canonical uint256 job id")
  .refine((value) => BigInt(value) <= UINT256_MAX, "Job id exceeds uint256");

/**
 * Lowercase only. The persistence layer constrains these columns to
 * `^0x[0-9a-f]{64}$`, so accepting mixed case here would let a write pass
 * validation and then fail at the database.
 */
export const arcErc8183Bytes32Schema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-f]{64}$/, "Expected a canonical lowercase bytes32 hash");

const arcAddressSchema = z
  .string()
  .trim()
  .regex(ADDRESS_PATTERN, "Expected an Arc address")
  .refine((value) => normalizeAddress(value) !== ZERO_ADDRESS, "Address must not be the zero address");

/**
 * Budgets reuse the exact six-decimal USDC grammar. Arc's native 18-decimal gas
 * view is never accepted here: ERC-8183 settles through the 6-decimal ERC-20
 * interface.
 */
export const arcAgentJobBudgetAmountSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/,
    "Expected USDC with at most six decimal places",
  )
  .refine((amount) => /[1-9]/.test(amount), "Expected a positive USDC amount");

const expiredAtSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)$/, "Expected a unix timestamp in seconds")
  .refine((value) => BigInt(value) <= UINT256_MAX, "Expiry exceeds uint256");

export const arcAgentJobCreateInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    /**
     * Required, not optional. This seven-tool surface exposes no `setProvider`,
     * so a job created without one can never be funded — a dead end in the
     * product rather than a state the user can recover from.
     */
    provider: arcAddressSchema,
    evaluator: arcAddressSchema,
    expiredAt: expiredAtSchema,
    description: z.string().trim().min(1).max(2_048, "Description must be at most 2048 characters"),
    hook: arcAddressSchema.optional(),
  })
  .strict()
  .refine(
    // The deployed contract reverts with ExpiryTooShort unless
    // expiredAt > block.timestamp + 5 minutes. Rejecting locally keeps a
    // guaranteed revert from ever reaching the wallet.
    (input) => BigInt(input.expiredAt) > BigInt(Math.floor(Date.now() / 1000) + ARC_ERC8183_MINIMUM_EXPIRY_SECONDS),
    {
      message: "Expiry must be more than 5 minutes in the future",
      path: ["expiredAt"],
    },
  );

export const arcAgentJobBudgetInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    jobId: arcAgentJobIdSchema,
    amount: arcAgentJobBudgetAmountSchema,
  })
  .strict();

export const arcAgentJobFundInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    jobId: arcAgentJobIdSchema,
    /**
     * Bound client-side against the current on-chain budget before writing.
     * The deployed contract accepts no expectedBudget parameter, so this is a
     * read-compare-write guard and not an atomic one.
     */
    expectedBudget: arcAgentJobBudgetAmountSchema,
  })
  .strict();

export const arcAgentJobSubmitInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    jobId: arcAgentJobIdSchema,
    deliverable: arcErc8183Bytes32Schema,
  })
  .strict();

export const arcAgentJobCompleteInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    jobId: arcAgentJobIdSchema,
    reason: arcErc8183Bytes32Schema,
  })
  .strict();

export const arcAgentJobRejectInputSchema = z
  .object({
    walletAddress: arcAddressSchema.optional(),
    jobId: arcAgentJobIdSchema,
    reason: arcErc8183Bytes32Schema,
  })
  .strict();

export const arcAgentJobReadInputSchema = z
  .object({ jobId: arcAgentJobIdSchema })
  .strict();

export type ArcAgentJobCreateInput = z.output<typeof arcAgentJobCreateInputSchema>;
export type ArcAgentJobBudgetInput = z.output<typeof arcAgentJobBudgetInputSchema>;
export type ArcAgentJobFundInput = z.output<typeof arcAgentJobFundInputSchema>;
export type ArcAgentJobSubmitInput = z.output<typeof arcAgentJobSubmitInputSchema>;
export type ArcAgentJobCompleteInput = z.output<typeof arcAgentJobCompleteInputSchema>;
export type ArcAgentJobRejectInput = z.output<typeof arcAgentJobRejectInputSchema>;
