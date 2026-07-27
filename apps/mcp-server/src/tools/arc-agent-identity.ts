import { createHash } from "node:crypto";

import {
  ARC_TESTNET_ERC8004_AGENT_REGISTRY,
  ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
  ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
  ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
  CIRCLE_ARC_CHAIN,
  arcErc8004FeedbackInputSchema,
  arcErc8004IdentityInputSchema,
  arcErc8004RegistrationInputSchema,
  arcErc8004TrustInputSchema,
  arcErc8004ValidationRequestInputSchema,
  arcErc8004ValidationResponseInputSchema,
  type CircleTransactionResult,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";

const ARC_EXPLORER_TRANSACTION_BASE_URL = "https://testnet.arcscan.app/tx/";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ArcErc8004Reader {
  ownerOf(agentId: string): Promise<string>;
  tokenURI(agentId: string): Promise<string>;
  getAgentWallet(agentId: string): Promise<string>;
  getApproved(agentId: string): Promise<string>;
  isApprovedForAll(owner: string, operator: string): Promise<boolean>;
  getValidationStatus(requestHash: string): Promise<{
    readonly exists: boolean;
    readonly validatorAddress: string;
    readonly agentId: string;
    readonly response: number;
    readonly responseHash: string;
    readonly tag: string;
    readonly lastUpdate: string;
    readonly hasResponse: boolean;
  }>;
  getReputationSummary(
    agentId: string,
    clientAddresses: readonly string[],
    tag1: string,
    tag2: string,
  ): Promise<{
    readonly count: string;
    readonly summaryValue: string;
    readonly summaryValueDecimals: number;
  }>;
  getValidationSummary(
    agentId: string,
    validatorAddresses: readonly string[],
    tag: string,
  ): Promise<{
    readonly count: string;
    readonly averageResponse: number;
  }>;
}

export interface ArcErc8004ProofReader {
  proveMutation(
    transaction: CircleTransactionResult,
    expectation: ArcErc8004MutationExpectation,
  ): Promise<{
    readonly transactionHash: string;
    readonly blockNumber: string;
    readonly agentId?: string;
  }>;
}

export type ArcErc8004MutationExpectation =
  | {
      readonly registry: string;
      readonly event: "Registered";
      readonly expectedArgs: {
        readonly owner: string;
        readonly agentURI: string;
      };
    }
  | {
      readonly registry: string;
      readonly event: "NewFeedback";
      readonly expectedArgs: {
        readonly agentId: string;
        readonly clientAddress: string;
        readonly value: string;
        readonly valueDecimals: string;
        readonly tag1: string;
        readonly tag2: string;
        readonly endpoint: string;
        readonly feedbackURI: string;
        readonly feedbackHash: string;
      };
    }
  | {
      readonly registry: string;
      readonly event: "ValidationRequest";
      readonly expectedArgs: {
        readonly validatorAddress: string;
        readonly agentId: string;
        readonly requestURI: string;
        readonly requestHash: string;
      };
    }
  | {
      readonly registry: string;
      readonly event: "ValidationResponse";
      readonly expectedArgs: {
        readonly validatorAddress: string;
        readonly agentId: string;
        readonly requestHash: string;
        readonly response: string;
        readonly responseURI: string;
        readonly responseHash: string;
        readonly tag: string;
      };
    };

export interface ArcErc8004MutationOutput {
  readonly status: "CONFIRMED" | "RECONCILIATION_REQUIRED";
  readonly operation: "REGISTER" | "FEEDBACK" | "VALIDATION_REQUEST" | "VALIDATION_RESPONSE";
  readonly transactionId?: string;
  readonly transactionHash?: string;
  readonly arcscanUrl?: string;
  readonly blockNumber?: string;
  readonly agentId?: string;
  readonly reconciliationRequired: boolean;
  readonly reconciliationMessage?: string;
}

export interface ArcErc8004MutationRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly status: "CLAIMED" | "COMPLETED";
  readonly output?: ArcErc8004MutationOutput;
}

export interface ArcErc8004EvidenceRepository {
  claim(record: ArcErc8004MutationRecord): Promise<{
    readonly claimed: boolean;
    readonly record: ArcErc8004MutationRecord;
  }>;
  complete(
    key: string,
    fingerprint: string,
    output: ArcErc8004MutationOutput,
  ): Promise<ArcErc8004MutationRecord>;
}

export interface ArcErc8004Dependencies {
  readonly circleCli: CircleCli;
  readonly reader: ArcErc8004Reader;
  readonly proofReader: ArcErc8004ProofReader;
  readonly evidence: ArcErc8004EvidenceRepository;
}

type MutationExpectation = Parameters<ArcErc8004ProofReader["proveMutation"]>[1];
type ContractExecutionInput = Parameters<CircleCli["executeContract"]>[0];

export function createArcAgentIdentityHandlers(dependencies: ArcErc8004Dependencies) {
  const inFlight = new Map<string, Promise<ArcErc8004MutationOutput>>();

  const execute = async (
    key: string,
    fingerprintInput: unknown,
    operation: ArcErc8004MutationOutput["operation"],
    contractInput: ContractExecutionInput,
    expectation: MutationExpectation,
  ): Promise<ArcErc8004MutationOutput> => {
    const fingerprint = stableFingerprint(fingerprintInput);
    const claimed = await dependencies.evidence.claim({
      key,
      fingerprint,
      status: "CLAIMED",
    });
    if (!claimed.claimed) {
      if (claimed.record.fingerprint !== fingerprint) {
        throw new Error("ERC-8004 replay key is bound to different evidence (conflict).");
      }
      if (claimed.record.output) return clone(claimed.record.output);
      const pending = inFlight.get(key);
      if (pending) return clone(await pending);
      throw new Error("ERC-8004 mutation is already claimed and requires reconciliation.");
    }

    const work = submitMutation(
      dependencies,
      operation,
      contractInput,
      expectation,
    ).then(async (output) => {
      const completed = await dependencies.evidence.complete(key, fingerprint, output);
      return clone(completed.output ?? output);
    });
    inFlight.set(key, work);
    try {
      return await work;
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    async registerAgentIdentity(rawInput: unknown) {
      const input = arcErc8004RegistrationInputSchema.parse(rawInput);
      const wallet = await selectCircleWallet(dependencies.circleCli, input.walletAddress);
      return await execute(
        `register:${input.idempotencyKey}`,
        input,
        "REGISTER",
        {
          address: wallet,
          contract: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          functionSignature: "register(string)",
          parameters: [input.agentURI],
        },
        {
          registry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
          event: "Registered",
          expectedArgs: {
            owner: wallet,
            agentURI: input.agentURI,
          },
        },
      );
    },

    async getAgentIdentity(rawInput: unknown) {
      const input = arcErc8004IdentityInputSchema.parse(rawInput);
      const identity = await readIdentity(dependencies.reader, input.agentId);
      return {
        chain: CIRCLE_ARC_CHAIN,
        agentRegistry: ARC_TESTNET_ERC8004_AGENT_REGISTRY,
        agentId: input.agentId,
        ...identity,
        identityRegistry: ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
      };
    },

    async giveAgentFeedback(rawInput: unknown) {
      const input = arcErc8004FeedbackInputSchema.parse(rawInput);
      const wallet = await selectCircleWallet(dependencies.circleCli, input.walletAddress);
      const identity = await readIdentity(dependencies.reader, input.agentId);
      await assertNotSelfFeedback(dependencies.reader, identity, wallet, input.agentId);
      return await execute(
        `feedback:${input.evidenceId}`,
        input,
        "FEEDBACK",
        {
          address: wallet,
          contract: ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
          functionSignature:
            "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
          parameters: [
            input.agentId,
            input.value,
            String(input.valueDecimals),
            input.tag1,
            input.tag2,
            input.endpoint,
            input.feedbackURI,
            input.feedbackHash,
          ],
        },
        {
          registry: ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
          event: "NewFeedback",
          expectedArgs: {
            agentId: input.agentId,
            clientAddress: wallet,
            value: input.value,
            valueDecimals: String(input.valueDecimals),
            tag1: input.tag1,
            tag2: input.tag2,
            endpoint: input.endpoint,
            feedbackURI: input.feedbackURI,
            feedbackHash: input.feedbackHash,
          },
        },
      );
    },

    async requestAgentValidation(rawInput: unknown) {
      const input = arcErc8004ValidationRequestInputSchema.parse(rawInput);
      const wallet = await selectCircleWallet(dependencies.circleCli, input.walletAddress);
      const identity = await readIdentity(dependencies.reader, input.agentId);
      await assertOwnerOrOperator(dependencies.reader, identity.owner, wallet, input.agentId);
      const existing = await dependencies.reader.getValidationStatus(input.requestHash);
      if (existing.exists) throw new Error("ERC-8004 validation request hash already exists.");
      return await execute(
        `validation-request:${input.requestHash.toLowerCase()}`,
        input,
        "VALIDATION_REQUEST",
        {
          address: wallet,
          contract: ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
          functionSignature: "validationRequest(address,uint256,string,bytes32)",
          parameters: [
            input.validatorAddress,
            input.agentId,
            input.requestURI,
            input.requestHash,
          ],
        },
        {
          registry: ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
          event: "ValidationRequest",
          expectedArgs: {
            validatorAddress: input.validatorAddress,
            agentId: input.agentId,
            requestURI: input.requestURI,
            requestHash: input.requestHash,
          },
        },
      );
    },

    async respondAgentValidation(rawInput: unknown) {
      const input = arcErc8004ValidationResponseInputSchema.parse(rawInput);
      const wallet = await selectCircleWallet(dependencies.circleCli, input.walletAddress);
      const status = await dependencies.reader.getValidationStatus(input.requestHash);
      if (!status.exists) throw new Error("ERC-8004 validation request does not exist.");
      await readIdentity(dependencies.reader, status.agentId);
      if (!sameAddress(status.validatorAddress, wallet)) {
        throw new Error("Only the requested validator wallet may respond.");
      }
      if (status.hasResponse) {
        throw new Error("ERC-8004 validation request already has a response.");
      }
      return await execute(
        `validation-response:${input.requestHash.toLowerCase()}`,
        input,
        "VALIDATION_RESPONSE",
        {
          address: wallet,
          contract: ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
          functionSignature: "validationResponse(bytes32,uint8,string,bytes32,string)",
          parameters: [
            input.requestHash,
            String(input.response),
            input.responseURI,
            input.responseHash,
            input.tag,
          ],
        },
        {
          registry: ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
          event: "ValidationResponse",
          expectedArgs: {
            validatorAddress: wallet,
            agentId: status.agentId,
            requestHash: input.requestHash,
            response: String(input.response),
            responseURI: input.responseURI,
            responseHash: input.responseHash,
            tag: input.tag,
          },
        },
      );
    },

    async getAgentTrust(rawInput: unknown) {
      const input = arcErc8004TrustInputSchema.parse(rawInput);
      await readIdentity(dependencies.reader, input.agentId);
      const clientAddresses = uniqueAddresses(input.trustedClientAddresses);
      const validatorAddresses = uniqueAddresses(input.trustedValidatorAddresses);
      const [reputation, validation] = await Promise.all([
        dependencies.reader.getReputationSummary(
          input.agentId,
          clientAddresses,
          input.reputationTag1,
          input.reputationTag2,
        ),
        dependencies.reader.getValidationSummary(
          input.agentId,
          validatorAddresses,
          input.validationTag,
        ),
      ]);
      return {
        agentId: input.agentId,
        trustedSources: {
          clientAddresses,
          validatorAddresses,
        },
        reputation: {
          ...reputation,
          formattedValue: formatFixed(reputation.summaryValue, reputation.summaryValueDecimals),
          tag1: input.reputationTag1,
          tag2: input.reputationTag2,
        },
        validation: {
          ...validation,
          tag: input.validationTag,
        },
        methodology:
          "Registry summaries are reported separately and filtered only by the caller-supplied trusted addresses and tags; AgentPay does not invent a global score.",
        globalScore: null,
      };
    },
  };
}

async function submitMutation(
  dependencies: ArcErc8004Dependencies,
  operation: ArcErc8004MutationOutput["operation"],
  input: ContractExecutionInput,
  expectation: MutationExpectation,
): Promise<ArcErc8004MutationOutput> {
  let transaction: CircleTransactionResult;
  try {
    transaction = await dependencies.circleCli.executeContract(input);
  } catch {
    return {
      status: "RECONCILIATION_REQUIRED",
      operation,
      reconciliationRequired: true,
      reconciliationMessage:
        "Circle CLI mutation outcome is ambiguous. Reconcile on Arcscan before any retry.",
    };
  }

  try {
    const proof = await dependencies.proofReader.proveMutation(transaction, expectation);
    return {
      status: "CONFIRMED",
      operation,
      transactionId: transaction.id,
      transactionHash: proof.transactionHash,
      arcscanUrl: `${ARC_EXPLORER_TRANSACTION_BASE_URL}${proof.transactionHash}`,
      blockNumber: proof.blockNumber,
      ...(proof.agentId === undefined ? {} : { agentId: proof.agentId }),
      reconciliationRequired: false,
    };
  } catch {
    return {
      status: "RECONCILIATION_REQUIRED",
      operation,
      transactionId: transaction.id,
      ...(transaction.txHash === undefined
        ? {}
        : {
            transactionHash: transaction.txHash,
            arcscanUrl: `${ARC_EXPLORER_TRANSACTION_BASE_URL}${transaction.txHash}`,
          }),
      reconciliationRequired: true,
      reconciliationMessage:
        "Transaction event proof is unavailable. Reconcile on Arcscan before any retry.",
    };
  }
}

async function readIdentity(reader: ArcErc8004Reader, agentId: string) {
  try {
    const [owner, agentURI, agentWallet] = await Promise.all([
      reader.ownerOf(agentId),
      reader.tokenURI(agentId),
      reader.getAgentWallet(agentId),
    ]);
    if (sameAddress(owner, ZERO_ADDRESS)) throw new Error("missing");
    return { owner, agentWallet, agentURI };
  } catch {
    throw new Error("ERC-8004 agent identity does not exist.");
  }
}

async function assertNotSelfFeedback(
  reader: ArcErc8004Reader,
  identity: Awaited<ReturnType<typeof readIdentity>>,
  wallet: string,
  agentId: string,
): Promise<void> {
  const [approved, approvedForAll] = await Promise.all([
    reader.getApproved(agentId),
    reader.isApprovedForAll(identity.owner, wallet),
  ]);
  if (
    sameAddress(wallet, identity.owner)
    || sameAddress(wallet, identity.agentWallet)
    || sameAddress(wallet, approved)
    || approvedForAll
  ) {
    throw new Error("ERC-8004 self-feedback from owner, operator, or agent wallet is forbidden.");
  }
}

async function assertOwnerOrOperator(
  reader: ArcErc8004Reader,
  owner: string,
  wallet: string,
  agentId: string,
): Promise<void> {
  const [approved, approvedForAll] = await Promise.all([
    reader.getApproved(agentId),
    reader.isApprovedForAll(owner, wallet),
  ]);
  if (!sameAddress(owner, wallet) && !sameAddress(approved, wallet) && !approvedForAll) {
    throw new Error("ERC-8004 validation request requires the owner or approved operator wallet.");
  }
}

async function selectCircleWallet(circleCli: CircleCli, requested?: string): Promise<string> {
  const wallets = await circleCli.listAgentWallets();
  if (wallets.length === 0) throw new Error("No authenticated Circle Agent Wallet is available.");
  if (!requested && wallets.length > 1) {
    throw new Error("walletAddress is required when multiple Circle Agent Wallets exist.");
  }
  const selected = requested ?? wallets[0]?.address;
  const wallet = wallets.find((candidate) => sameAddress(candidate.address, selected ?? ""));
  if (!wallet) throw new Error("walletAddress is not an authenticated Circle Agent Wallet.");
  return wallet.address;
}

function uniqueAddresses(addresses: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatFixed(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  const formatted = fractional ? `${whole}.${fractional}` : whole;
  return negative && formatted !== "0" ? `-${formatted}` : formatted;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

const addressProperty = { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" };
const agentIdProperty = { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" };
const hashProperty = { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" };
const walletProperty = { walletAddress: addressProperty };

export const registerAgentIdentityTool = {
  name: "register_agent_identity",
  description: "Register safe Arc Testnet ERC-8004 identity metadata through the deployed identity proxy.",
  inputSchema: objectSchema({
    ...walletProperty,
    idempotencyKey: { type: "string", format: "uuid" },
    agentURI: { type: "string", minLength: 1, maxLength: 2_048 },
  }, ["idempotencyKey", "agentURI"]),
} as const;

export const getAgentIdentityTool = {
  name: "get_agent_identity",
  description: "Read an Arc Testnet ERC-8004 identity owner, URI, and verified agent wallet.",
  inputSchema: objectSchema({ agentId: agentIdProperty }, ["agentId"]),
} as const;

export const giveAgentFeedbackTool = {
  name: "give_agent_feedback",
  description: "Give replay-protected ERC-8004 feedback tied to unique payment or evidence.",
  inputSchema: objectSchema({
    ...walletProperty,
    agentId: agentIdProperty,
    value: { type: "string", pattern: "^-?(?:0|[1-9][0-9]*)$" },
    valueDecimals: { type: "integer", minimum: 0, maximum: 18 },
    tag1: { type: "string", maxLength: 128 },
    tag2: { type: "string", maxLength: 128 },
    endpoint: { type: "string", maxLength: 2_048 },
    feedbackURI: { type: "string", maxLength: 2_048 },
    feedbackHash: hashProperty,
    evidenceId: { type: "string", minLength: 1, maxLength: 256 },
  }, [
    "agentId", "value", "valueDecimals", "tag1", "tag2", "endpoint",
    "feedbackURI", "feedbackHash", "evidenceId",
  ]),
} as const;

export const requestAgentValidationTool = {
  name: "request_agent_validation",
  description: "Request unique ERC-8004 validation as the identity owner or approved operator.",
  inputSchema: objectSchema({
    ...walletProperty,
    agentId: agentIdProperty,
    validatorAddress: addressProperty,
    requestURI: { type: "string", minLength: 1, maxLength: 2_048 },
    requestHash: hashProperty,
  }, ["agentId", "validatorAddress", "requestURI", "requestHash"]),
} as const;

export const respondAgentValidationTool = {
  name: "respond_agent_validation",
  description: "Submit the one allowed ERC-8004 response from the requested validator.",
  inputSchema: objectSchema({
    ...walletProperty,
    requestHash: hashProperty,
    response: { type: "integer", minimum: 0, maximum: 100 },
    responseURI: { type: "string", minLength: 1, maxLength: 2_048 },
    responseHash: hashProperty,
    tag: { type: "string", maxLength: 128 },
  }, ["requestHash", "response", "responseURI", "responseHash", "tag"]),
} as const;

export const getAgentTrustTool = {
  name: "get_agent_trust",
  description: "Read transparent reputation and validation components from caller-trusted address sets.",
  inputSchema: objectSchema({
    agentId: agentIdProperty,
    trustedClientAddresses: { type: "array", minItems: 1, maxItems: 100, items: addressProperty },
    trustedValidatorAddresses: { type: "array", minItems: 1, maxItems: 100, items: addressProperty },
    reputationTag1: { type: "string", maxLength: 128, default: "" },
    reputationTag2: { type: "string", maxLength: 128, default: "" },
    validationTag: { type: "string", maxLength: 128, default: "" },
  }, ["agentId", "trustedClientAddresses", "trustedValidatorAddresses"]),
} as const;
