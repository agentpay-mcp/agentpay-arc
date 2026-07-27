import {
  CIRCLE_ARC_CHAIN,
  circleAddressSchema,
  uuidV4Schema,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

const tenantIdSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const directionSchema = z.enum(["SEND", "RECEIVE"]);
const channelSchema = z.enum([
  "AGENT_WALLET_TRANSFER",
  "AGENT_WALLET_PAID_SERVICE",
]);
const evidenceTypeSchema = z.enum([
  "CIRCLE_AGENT_WALLET_BUILT_IN",
  "CIRCLE_COMPLIANCE_ENGINE",
]);
const evidenceStatusSchema = z.enum([
  "DECLARED_RUNTIME_CONTROL",
  "DISABLED",
  "SCREENED",
  "UNAVAILABLE",
  "UNSUPPORTED_CHAIN",
]);
const decisionSchema = z.enum(["APPROVED", "DENIED", "REVIEW", "UNAVAILABLE"]);
const availabilitySchema = z.enum(["NOT_CONFIGURED", "UNSUPPORTED_CHAIN"]);
const referenceIdSchema = z.string().regex(/^[A-Za-z0-9_:.~-]{1,128}$/);

const evidenceSchema = z
  .object({
    evidenceKey: z.string().min(1).max(256),
    operationId: uuidV4Schema,
    address: circleAddressSchema,
    direction: directionSchema,
    channel: channelSchema,
    evidenceType: evidenceTypeSchema,
    status: evidenceStatusSchema,
    decision: decisionSchema.optional(),
    referenceId: referenceIdSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();

const providerResultSchema = z
  .object({
    decision: decisionSchema,
    availability: availabilitySchema.optional(),
    referenceId: referenceIdSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.availability && result.decision !== "UNAVAILABLE") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unavailable screening cannot approve a payment.",
        path: ["decision"],
      });
    }
  });

const rowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    evidence_key: z.string().min(1).max(256),
    operation_id: uuidV4Schema,
    address: circleAddressSchema,
    direction: directionSchema,
    channel: channelSchema,
    evidence_type: evidenceTypeSchema,
    status: evidenceStatusSchema,
    decision: decisionSchema.nullable(),
    reference_id: referenceIdSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export type ComplianceDirection = z.infer<typeof directionSchema>;
export type ComplianceChannel = z.infer<typeof channelSchema>;
export type ComplianceDecision = z.infer<typeof decisionSchema>;
export type ComplianceEvidence = z.infer<typeof evidenceSchema>;

export interface ComplianceScreeningProvider {
  screen(input: {
    readonly address: string;
    readonly chain: typeof CIRCLE_ARC_CHAIN;
    readonly direction: ComplianceDirection;
  }): Promise<{
    readonly decision: ComplianceDecision;
    readonly availability?: z.infer<typeof availabilitySchema>;
    readonly referenceId?: string;
  }>;
}

export interface ComplianceEvidenceRepository {
  list(operationId: string): Promise<readonly ComplianceEvidence[]>;
  record(evidence: ComplianceEvidence): Promise<ComplianceEvidence>;
}

export interface ComplianceEvidenceSupabaseResult {
  readonly data: unknown;
  readonly error: { readonly message: string } | null;
}

export interface ComplianceEvidenceSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<ComplianceEvidenceSupabaseResult>;
}

export interface CompliancePaymentGate {
  screen(input: {
    readonly operationId: string;
    readonly address: string;
    readonly direction: ComplianceDirection;
    readonly channel: ComplianceChannel;
  }): Promise<{
    readonly allowed: boolean;
    readonly engineDecision: ComplianceDecision;
    readonly evidence: readonly ComplianceEvidence[];
  }>;
}

export function createArcCircleComplianceProvider(options: {
  readonly configured: boolean;
  readonly transport?: (input: {
    readonly address: string;
    readonly direction: ComplianceDirection;
  }) => Promise<unknown>;
}): ComplianceScreeningProvider {
  return {
    async screen(input) {
      circleAddressSchema.parse(input.address);
      directionSchema.parse(input.direction);
      if (input.chain !== CIRCLE_ARC_CHAIN) {
        throw new Error("Circle compliance chain binding is invalid.");
      }

      // Circle's standalone Compliance Engine does not currently expose Arc
      // testnet as a supported screening chain. Do not call a transport and do
      // not present Agent Wallet's built-in controls as an engine decision.
      return Object.freeze({
        decision: "UNAVAILABLE" as const,
        availability: options.configured
          ? ("UNSUPPORTED_CHAIN" as const)
          : ("NOT_CONFIGURED" as const),
      });
    },
  };
}

export function createCircleComplianceGate(options: {
  readonly mode: "DISABLED" | "LIVE_REQUIRED";
  readonly provider?: ComplianceScreeningProvider;
  readonly evidence: ComplianceEvidenceRepository;
  readonly clock?: () => Date;
}): CompliancePaymentGate {
  const clock = options.clock ?? (() => new Date());

  return {
    async screen(rawInput) {
      const input = parseGateInput(rawInput);
      const previous = await options.evidence.list(input.operationId);
      assertEvidenceBindings(previous, input);

      const builtIn = previous.find(
        ({ evidenceType }) => evidenceType === "CIRCLE_AGENT_WALLET_BUILT_IN",
      ) ?? await options.evidence.record({
        evidenceKey: `${input.operationId}:agent-wallet`,
        ...input,
        evidenceType: "CIRCLE_AGENT_WALLET_BUILT_IN",
        status: "DECLARED_RUNTIME_CONTROL",
        createdAt: clock().toISOString(),
      });

      const replayedEngine = previous.find(
        ({ evidenceType }) => evidenceType === "CIRCLE_COMPLIANCE_ENGINE",
      );
      if (replayedEngine) {
        if (options.mode === "DISABLED" && replayedEngine.status === "DISABLED") {
          return immutableGateResult(
            true,
            replayedEngine.decision ?? "UNAVAILABLE",
            [builtIn, replayedEngine],
          );
        }
        return enforceDecision([builtIn, replayedEngine], replayedEngine.decision);
      }

      if (options.mode === "DISABLED") {
        const disabled = await options.evidence.record({
          evidenceKey: `${input.operationId}:engine`,
          ...input,
          evidenceType: "CIRCLE_COMPLIANCE_ENGINE",
          status: "DISABLED",
          decision: "UNAVAILABLE",
          createdAt: clock().toISOString(),
        });
        return immutableGateResult(true, "UNAVAILABLE", [builtIn, disabled]);
      }

      if (!options.provider) {
        const unavailable = await recordUnavailable(options.evidence, input, clock);
        return enforceDecision([builtIn, unavailable], "UNAVAILABLE");
      }

      try {
        const result = providerResultSchema.parse(
          await options.provider.screen({
            address: input.address,
            chain: CIRCLE_ARC_CHAIN,
            direction: input.direction,
          }),
        );
        const status = result.availability === "UNSUPPORTED_CHAIN"
          ? "UNSUPPORTED_CHAIN"
          : result.decision === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : "SCREENED";
        const engine = await options.evidence.record({
          evidenceKey: `${input.operationId}:engine`,
          ...input,
          evidenceType: "CIRCLE_COMPLIANCE_ENGINE",
          status,
          decision: result.decision,
          ...(status === "SCREENED" && result.referenceId
            ? { referenceId: result.referenceId }
            : {}),
          createdAt: clock().toISOString(),
        });
        return enforceDecision([builtIn, engine], result.decision);
      } catch (error) {
        if (error instanceof ComplianceRejectedError) throw error;
        const unavailable = await recordUnavailable(options.evidence, input, clock);
        return enforceDecision([builtIn, unavailable], "UNAVAILABLE");
      }
    },
  };
}

export function createInMemoryComplianceEvidenceRepository():
ComplianceEvidenceRepository {
  const records = new Map<string, ComplianceEvidence>();
  return {
    async list(operationId) {
      const id = uuidV4Schema.parse(operationId);
      return Object.freeze(
        [...records.values()]
          .filter((record) => record.operationId === id)
          .map(cloneEvidence),
      );
    },
    async record(rawEvidence) {
      const evidence = evidenceSchema.parse(rawEvidence);
      const existing = records.get(evidence.evidenceKey);
      if (existing) {
        assertSameEvidence(existing, evidence);
        return cloneEvidence(existing);
      }
      records.set(evidence.evidenceKey, cloneEvidence(evidence));
      return cloneEvidence(evidence);
    },
  };
}

export function createTenantComplianceEvidenceRepository(
  client: ComplianceEvidenceSupabaseClient,
  trustedTenantId: string,
): ComplianceEvidenceRepository {
  const tenantId = tenantIdSchema.parse(trustedTenantId);
  return {
    async list(operationId) {
      const result = await client.rpc("list_arc_compliance_evidence", {
        p_tenant_id: tenantId,
        p_operation_id: uuidV4Schema.parse(operationId),
      });
      if (result.error) throw new Error("Compliance evidence read failed.");
      const rows = z.array(rowSchema).safeParse(result.data);
      if (!rows.success || rows.data.some((row) => row.tenant_id !== tenantId)) {
        throw new Error("Compliance evidence repository returned invalid tenant data.");
      }
      return Object.freeze(rows.data.map(mapRow));
    },
    async record(rawEvidence) {
      const evidence = evidenceSchema.parse(rawEvidence);
      const result = await client.rpc("record_arc_compliance_evidence", {
        p_tenant_id: tenantId,
        p_evidence: { ...evidence },
      });
      if (result.error) throw new Error("Compliance evidence write failed.");
      const row = rowSchema.safeParse(result.data);
      if (!row.success || row.data.tenant_id !== tenantId) {
        throw new Error("Compliance evidence repository returned invalid tenant data.");
      }
      const persisted = mapRow(row.data);
      assertSameEvidence(persisted, evidence);
      return persisted;
    },
  };
}

class ComplianceRejectedError extends Error {
  constructor() {
    super("Payment blocked because the required compliance decision was not approved.");
  }
}

function parseGateInput(input: {
  readonly operationId: string;
  readonly address: string;
  readonly direction: ComplianceDirection;
  readonly channel: ComplianceChannel;
}) {
  return Object.freeze({
    operationId: uuidV4Schema.parse(input.operationId),
    address: circleAddressSchema.parse(input.address),
    direction: directionSchema.parse(input.direction),
    channel: channelSchema.parse(input.channel),
  });
}

async function recordUnavailable(
  repository: ComplianceEvidenceRepository,
  input: ReturnType<typeof parseGateInput>,
  clock: () => Date,
): Promise<ComplianceEvidence> {
  return repository.record({
    evidenceKey: `${input.operationId}:engine`,
    ...input,
    evidenceType: "CIRCLE_COMPLIANCE_ENGINE",
    status: "UNAVAILABLE",
    decision: "UNAVAILABLE",
    createdAt: clock().toISOString(),
  });
}

function enforceDecision(
  evidence: readonly ComplianceEvidence[],
  decision: ComplianceDecision | undefined,
) {
  if (decision !== "APPROVED") throw new ComplianceRejectedError();
  return immutableGateResult(true, decision, evidence);
}

function immutableGateResult(
  allowed: boolean,
  decision: ComplianceDecision,
  evidence: readonly ComplianceEvidence[],
) {
  return Object.freeze({
    allowed,
    engineDecision: decision,
    evidence: Object.freeze(evidence.map(cloneEvidence)),
  });
}

function assertEvidenceBindings(
  evidence: readonly ComplianceEvidence[],
  expected: ReturnType<typeof parseGateInput>,
): void {
  for (const record of evidence) {
    if (
      record.operationId !== expected.operationId
      || record.address.toLowerCase() !== expected.address.toLowerCase()
      || record.direction !== expected.direction
      || record.channel !== expected.channel
    ) {
      throw new Error("Compliance evidence conflicts with this payment operation.");
    }
  }
}

function assertSameEvidence(
  actual: ComplianceEvidence,
  expected: ComplianceEvidence,
): void {
  const comparableActual = { ...actual, address: actual.address.toLowerCase() };
  const comparableExpected = { ...expected, address: expected.address.toLowerCase() };
  if (JSON.stringify(comparableActual) !== JSON.stringify(comparableExpected)) {
    throw new Error("Compliance evidence idempotency conflict.");
  }
}

function mapRow(row: z.output<typeof rowSchema>): ComplianceEvidence {
  return evidenceSchema.parse({
    evidenceKey: row.evidence_key,
    operationId: row.operation_id,
    address: row.address,
    direction: row.direction,
    channel: row.channel,
    evidenceType: row.evidence_type,
    status: row.status,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.reference_id ? { referenceId: row.reference_id } : {}),
    createdAt: row.created_at,
  });
}

function cloneEvidence(evidence: ComplianceEvidence): ComplianceEvidence {
  return Object.freeze({ ...evidence });
}
