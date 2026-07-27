import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const path = "supabase/migrations/20260727100000_arc_liquidity_identity.sql";

describe("Arc liquidity and identity migration", () => {
  it("creates tenant-scoped atomic state machines with service-role-only RPCs", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    for (const required of [
      "create table if not exists public.arc_liquidity_operations",
      "primary key (tenant_id, id)",
      "create or replace function public.get_arc_liquidity_operation",
      "create or replace function public.claim_arc_liquidity_operation",
      "create or replace function public.transition_arc_liquidity_operation",
      "pg_advisory_xact_lock",
      "alter table public.arc_liquidity_operations enable row level security",
      "revoke all on table public.arc_liquidity_operations from public, anon, authenticated",
      "create table if not exists public.arc_erc8004_mutations",
      "primary key (tenant_id, mutation_key)",
      "create or replace function public.claim_arc_erc8004_mutation",
      "create or replace function public.complete_arc_erc8004_mutation",
      "alter table public.arc_erc8004_mutations enable row level security",
      "notify pgrst, 'reload schema'",
    ]) {
      assert.ok(sql.includes(required), required);
    }
    assert.doesNotMatch(
      sql,
      /\b(?:api_key|credential|mnemonic|private_key|seed_phrase|signature)\s+(?:text|jsonb|bytea)\b/,
    );
    const claimBody = sql.slice(
      sql.indexOf("create or replace function public.claim_arc_liquidity_operation"),
      sql.indexOf("create or replace function public.transition_arc_liquidity_operation"),
    );
    assert.doesNotMatch(claimBody, /v_operation\.quote_expires_at\s*<>/);
    assert.doesNotMatch(claimBody, /v_operation\.created_at\s*<>/);
  });
});
