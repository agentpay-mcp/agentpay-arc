import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const path = "supabase/migrations/20260726100000_arc_agent_jobs.sql";

describe("Arc ERC-8183 agent jobs migration", () => {
  it("creates tenant-scoped job and append-only lifecycle tables", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    for (const required of [
      "create table if not exists public.arc_agent_jobs",
      "create table if not exists public.arc_agent_job_events",
      "primary key (tenant_id, job_id)",
      "primary key (tenant_id, id)",
      "references public.tenants(id)",
      "alter table public.arc_agent_jobs enable row level security",
      "alter table public.arc_agent_job_events enable row level security",
      "revoke all on table public.arc_agent_jobs from public, anon, authenticated",
      "revoke all on table public.arc_agent_job_events from public, anon, authenticated",
    ]) {
      assert.ok(sql.includes(required), required);
    }
  });

  it("pins Arc Testnet and the six-decimal atomic budget", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(sql.includes("check (chain_id = 5042002)"), "chain must be pinned to Arc Testnet");
    assert.ok(sql.includes("budget_atomic numeric(78, 0)"), "budget must be exact atomic units");
    assert.doesNotMatch(
      sql,
      /budget[a-z_]* (?:double precision|real|float)/,
      "token amounts must never be stored as floating point",
    );
  });

  it("constrains lifecycle state to the six ERC-8183 states", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(
      sql.includes("state in ('open', 'funded', 'submitted', 'completed', 'rejected', 'expired')"),
      "state must be constrained to the ERC-8183 enum",
    );
  });

  it("keeps the lifecycle log append-only for the service role", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(
      sql.includes("grant select, insert on table public.arc_agent_job_events to service_role"),
      "lifecycle events must not be updatable or deletable",
    );
    assert.doesNotMatch(
      sql,
      /grant [^;]*(?:update|delete)[^;]* on table public\.arc_agent_job_events/,
      "the lifecycle log must never grant update or delete",
    );
  });

  it("refuses to record a proof for an ambiguous write", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(
      sql.includes("status <> 'reconciliation_required'"),
      "an ambiguous write must not claim a resulting state or proof",
    );
  });

  it("requires an evaluator and a funded provider", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(
      sql.includes("check (evaluator_address <> '0x0000000000000000000000000000000000000000')"),
      "evaluator must never be the zero address",
    );
    assert.ok(
      sql.includes("check (provider_address <> '0x0000000000000000000000000000000000000000')"),
      "a provider is required at creation because there is no setProvider tool",
    );
  });

  it("stores the fields the Task 9 read model needs", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.ok(sql.includes("description text not null"), "marketplace cannot re-read the chain");
    assert.ok(sql.includes("hook_address text not null"), "hook must survive for the read model");
  });

  it("indexes the access paths the tools actually use", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    for (const index of [
      "arc_agent_jobs_tenant_state_idx",
      "arc_agent_jobs_client_idx",
      "arc_agent_jobs_provider_idx",
      "arc_agent_jobs_evaluator_idx",
      "arc_agent_job_events_job_idx",
    ]) {
      assert.ok(sql.includes(index), index);
    }
  });

  it("never grants anonymous access", async () => {
    const sql = (await readFile(path, "utf8")).replace(/\s+/g, " ").toLowerCase();

    assert.doesNotMatch(
      sql,
      /grant [^;]* to (?:anon|authenticated|public)\b/,
      "no anonymous or authenticated-role grants are permitted",
    );
  });
});
