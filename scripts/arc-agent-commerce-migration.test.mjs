import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const path = "supabase/migrations/20260727090000_arc_agent_commerce.sql";

describe("Arc agent commerce migration", () => {
  it("creates tenant-scoped atomic receipts without signature or credential fields", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    for (const required of [
      "create table if not exists public.arc_agent_commerce_receipts",
      "primary key (tenant_id, idempotency_key)",
      "unique (tenant_id, payment_identifier)",
      "create or replace function public.claim_arc_agent_commerce_receipt",
      "pg_advisory_xact_lock",
      "create or replace function public.complete_arc_agent_commerce_receipt",
      "alter table public.arc_agent_commerce_receipts enable row level security",
      "revoke all on table public.arc_agent_commerce_receipts from public, anon, authenticated",
      "grant execute on function public.claim_arc_agent_commerce_receipt(uuid, jsonb) to service_role",
      "notify pgrst, 'reload schema'",
      "create table if not exists public.arc_gateway_seller_settlements",
      "primary key (tenant_id, payment_identifier)",
      "create or replace function public.claim_arc_gateway_seller_settlement",
      "create or replace function public.complete_arc_gateway_seller_settlement",
    ]) {
      assert.ok(sql.includes(required), required);
    }
    assert.doesNotMatch(sql, /\bsignature\s+(?:text|jsonb|bytea)\b/);
    assert.doesNotMatch(sql, /\b(?:api_key|credential|private_key|seed_phrase)\s+(?:text|jsonb|bytea)\b/);
  });
});
