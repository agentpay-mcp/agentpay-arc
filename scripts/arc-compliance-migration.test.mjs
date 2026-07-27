import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const path = "supabase/migrations/20260726110000_arc_compliance_evidence.sql";

describe("Arc compliance evidence migration", () => {
  it("stores tenant-scoped sanitized evidence through service-role-only RPCs", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    for (const required of [
      "create table if not exists public.arc_compliance_evidence",
      "primary key (tenant_id, evidence_key)",
      "create or replace function public.list_arc_compliance_evidence",
      "create or replace function public.record_arc_compliance_evidence",
      "pg_advisory_xact_lock",
      "alter table public.arc_compliance_evidence enable row level security",
      "revoke all on table public.arc_compliance_evidence from public, anon, authenticated",
      "grant execute on function public.list_arc_compliance_evidence(uuid, uuid) to service_role",
      "grant execute on function public.record_arc_compliance_evidence(uuid, jsonb) to service_role",
      "notify pgrst, 'reload schema'",
    ]) {
      assert.ok(sql.includes(required), required);
    }
    assert.doesNotMatch(
      sql,
      /\b(?:api_key|credential|mnemonic|private_key|raw_payload|request_payload|response_payload|seed_phrase|signature)\s+(?:text|jsonb|bytea)\b/,
    );
  });
});
