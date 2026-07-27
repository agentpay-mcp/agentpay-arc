import { z } from "zod";

import type {
  ArcErc8004EvidenceRepository,
  ArcErc8004MutationOutput,
  ArcErc8004MutationRecord,
} from "../tools/arc-agent-identity.ts";

interface SupabaseError {
  readonly message: string;
}

export interface ArcErc8004SupabaseResult {
  readonly data: unknown;
  readonly error: SupabaseError | null;
}

export interface ArcErc8004SupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<ArcErc8004SupabaseResult>;
}

const tenantIdSchema = z.string().uuid();
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const safeOutputSchema = z
  .object({
    status: z.enum(["CONFIRMED", "RECONCILIATION_REQUIRED"]),
    operation: z.enum(["REGISTER", "FEEDBACK", "VALIDATION_REQUEST", "VALIDATION_RESPONSE"]),
    transactionId: z.string().min(1).max(256).optional(),
    transactionHash: transactionHashSchema.optional(),
    arcscanUrl: z.string().url().startsWith("https://testnet.arcscan.app/tx/").optional(),
    blockNumber: z.string().regex(/^\d+$/).optional(),
    agentId: z.string().regex(/^(?:0|[1-9]\d*)$/).optional(),
    reconciliationRequired: z.boolean(),
    reconciliationMessage: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.status === "CONFIRMED" && output.reconciliationRequired) {
      context.addIssue({ code: "custom", message: "Confirmed output cannot require reconciliation" });
    }
    if (output.status === "RECONCILIATION_REQUIRED" && !output.reconciliationRequired) {
      context.addIssue({ code: "custom", message: "Reconciliation output must be explicit" });
    }
  });
const rowSchema = z
  .object({
    tenant_id: tenantIdSchema,
    mutation_key: z.string().min(1).max(512),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["CLAIMED", "COMPLETED"]),
    output: safeOutputSchema.nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.status === "CLAIMED" && row.output !== null) {
      context.addIssue({ code: "custom", message: "Claimed mutation must not have output" });
    }
    if (row.status === "COMPLETED" && row.output === null) {
      context.addIssue({ code: "custom", message: "Completed mutation requires output" });
    }
  });
const claimSchema = z.object({ claimed: z.boolean(), record: rowSchema }).strict();

export function createTenantArcErc8004EvidenceRepository(
  client: ArcErc8004SupabaseClient,
  trustedTenantId: string,
): ArcErc8004EvidenceRepository {
  const tenantId = tenantIdSchema.parse(trustedTenantId);
  return {
    async claim(record) {
      const parsedRecord = parseInputRecord(record);
      const result = await client.rpc("claim_arc_erc8004_mutation", {
        p_tenant_id: tenantId,
        p_mutation_key: parsedRecord.key,
        p_fingerprint: parsedRecord.fingerprint,
      });
      if (result.error) throw new Error("Arc ERC-8004 atomic evidence claim failed.");
      const parsed = claimSchema.safeParse(result.data);
      if (!parsed.success || parsed.data.record.tenant_id !== tenantId) {
        throw new Error("Arc ERC-8004 evidence repository returned invalid data.");
      }
      const persisted = mapRow(parsed.data.record);
      assertReplayMatch(persisted, parsedRecord);
      return { claimed: parsed.data.claimed, record: persisted };
    },
    async complete(key, fingerprint, output) {
      const parsedRecord = parseInputRecord({ key, fingerprint, status: "CLAIMED" });
      const parsedOutput = safeOutputSchema.parse(output);
      const result = await client.rpc("complete_arc_erc8004_mutation", {
        p_tenant_id: tenantId,
        p_mutation_key: parsedRecord.key,
        p_fingerprint: parsedRecord.fingerprint,
        p_output: parsedOutput,
      });
      if (result.error) throw new Error("Arc ERC-8004 evidence completion failed.");
      const parsed = rowSchema.safeParse(result.data);
      if (!parsed.success || parsed.data.tenant_id !== tenantId) {
        throw new Error("Arc ERC-8004 evidence repository returned invalid data.");
      }
      const persisted = mapRow(parsed.data);
      assertReplayMatch(persisted, parsedRecord);
      if (
        persisted.status !== "COMPLETED"
        || JSON.stringify(persisted.output) !== JSON.stringify(parsedOutput)
      ) {
        throw new Error("Arc ERC-8004 evidence completion returned conflicting data.");
      }
      return persisted;
    },
  };
}

function parseInputRecord(record: ArcErc8004MutationRecord): ArcErc8004MutationRecord {
  return {
    key: z.string().min(1).max(512).parse(record.key),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).parse(record.fingerprint),
    status: z.literal("CLAIMED").parse(record.status),
  };
}

function mapRow(row: z.output<typeof rowSchema>): ArcErc8004MutationRecord {
  return {
    key: row.mutation_key,
    fingerprint: row.fingerprint,
    status: row.status,
    ...(row.output === null ? {} : { output: row.output as ArcErc8004MutationOutput }),
  };
}

function assertReplayMatch(
  actual: ArcErc8004MutationRecord,
  expected: ArcErc8004MutationRecord,
): void {
  if (actual.key !== expected.key || actual.fingerprint !== expected.fingerprint) {
    throw new Error("Arc ERC-8004 evidence repository returned conflicting data.");
  }
}
