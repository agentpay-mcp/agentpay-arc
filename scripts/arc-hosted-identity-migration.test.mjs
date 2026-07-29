import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Arc-only Hosted Identity Migration Static Analysis", () => {
  const migrationPath = "supabase/migrations/20260729020000_arc_hosted_identity.sql";

  it("defines public.arc_hosted_accounts with RLS and user isolation", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /create table if not exists public\.arc_hosted_accounts/i);
    assert.match(sql, /auth_user_id uuid primary key references auth\.users\(id\)/i);
    assert.match(sql, /tenant_id uuid not null unique references public\.tenants\(id\)/i);
    assert.match(sql, /account_status text not null check \(account_status in \('ACTIVE', 'PAUSED', 'CLOSED'\)\)/i);
    assert.match(sql, /consent_version text not null check \(consent_version = 'arc-hosted-autonomy-v1'\)/i);
    assert.match(sql, /alter table public\.arc_hosted_accounts enable row level security/i);
    assert.match(sql, /create policy arc_hosted_accounts_user_select on public\.arc_hosted_accounts/i);
    assert.match(sql, /auth_user_id = auth\.uid\(\)/i);
  });

  it("defines public.arc_circle_wallet_bindings with private Circle binding schema", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /create table if not exists public\.arc_circle_wallet_bindings/i);
    assert.match(sql, /provisioning_idempotency_key uuid not null unique/i);
    assert.match(sql, /blockchain text check \(blockchain is null or blockchain = 'ARC-TESTNET'\)/i);
    assert.match(sql, /account_type text check \(account_type is null or account_type = 'SCA'\)/i);
    assert.match(sql, /custody_type text check \(custody_type is null or custody_type = 'DEVELOPER'\)/i);
    assert.match(sql, /provisioning_state text not null check \(provisioning_state in \('PENDING', 'PROVISIONING', 'LIVE', 'FAILED', 'CLOSED'\)\)/i);
    assert.match(sql, /check\s*\(\s*provisioning_state\s*!=\s*'LIVE'\s+or\s+\(/i);
    assert.match(sql, /circle_wallet_set_id is not null/i);
    assert.match(sql, /circle_wallet_id is not null/i);
    assert.match(sql, /wallet_address is not null/i);
    assert.match(sql, /blockchain = 'ARC-TESTNET'/i);
    assert.match(sql, /account_type = 'SCA'/i);
    assert.match(sql, /custody_type = 'DEVELOPER'/i);
    assert.match(sql, /alter table public\.arc_circle_wallet_bindings enable row level security/i);
    assert.doesNotMatch(sql, /create policy.*on public\.arc_circle_wallet_bindings for select to (?:anon|authenticated)/i);
  });

  it("defines service-role-only atomic provisioning and lifecycle functions", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /create or replace function public\.arc_claim_hosted_account/i);
    assert.match(sql, /create or replace function public\.arc_claim_provisioning_job/i);
    assert.match(sql, /create or replace function public\.arc_complete_provisioning/i);
    assert.match(sql, /create or replace function public\.arc_fail_provisioning/i);
    assert.match(sql, /create or replace function public\.arc_set_account_status/i);
    assert.match(sql, /auth_epoch = auth_epoch \+ 1/i);

    assert.match(sql, /revoke all on function public\.arc_claim_hosted_account\(uuid, text\) from public, anon, authenticated/i);
    assert.match(sql, /grant execute on function public\.arc_claim_hosted_account\(uuid, text\) to service_role/i);
  });

  it("does not include any policy limit or allowlist columns", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.doesNotMatch(sql, /daily_limit|per_payment_cap|recipient_allowlist|domain_allowlist/i);
  });

  it("provides a tracked rollback procedure file dropping all Task 13A resources in reverse order", async () => {
    const rollbackPath = "supabase/rollbacks/20260729020000_arc_hosted_identity_rollback.sql";
    const sql = await readFile(rollbackPath, "utf8");

    assert.match(sql, /drop function if exists public\.arc_set_account_status/i);
    assert.match(sql, /drop function if exists public\.arc_fail_provisioning/i);
    assert.match(sql, /drop function if exists public\.arc_complete_provisioning/i);
    assert.match(sql, /drop function if exists public\.arc_claim_provisioning_job/i);
    assert.match(sql, /drop function if exists public\.arc_claim_hosted_account/i);
    assert.match(sql, /drop table if exists public\.arc_circle_wallet_bindings/i);
    assert.match(sql, /drop table if exists public\.arc_hosted_accounts/i);
  });
});
