import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migrationPath = "supabase/migrations/20260702143000_agentpay_schema.sql";
const tenantMigrationPath = "supabase/migrations/20260712100000_tenant_sessions.sql";
const routeMinimumMigrationPath = "supabase/migrations/20260712113000_payment_route_minimum.sql";
const paymentReviewMigrationPath = "supabase/migrations/20260712130000_payment_review_handoffs.sql";
const runtimeIdentityMigrationPath = "supabase/migrations/20260713140000_runtime_environment_identity.sql";
const paidExecutionLifecycleMigrationPath = "supabase/migrations/20260713150000_paid_execution_lifecycle.sql";
const paidExecutionChallengeOutboxMigrationPath = "supabase/migrations/20260713160000_paid_execution_challenge_outbox.sql";
const paidExecutionCanaryLedgerMigrationPath = "supabase/migrations/20260713170000_paid_execution_canary_ledger.sql";
const canaryOwnerRebindingMigrationPath = "supabase/migrations/20260714180000_canary_owner_rebinding.sql";
const oauthConsumerAuthorizationMigrationPath = "supabase/migrations/20260715110000_oauth_consumer_authorization.sql";
const paymentIntentAuditMigrationPath = "supabase/migrations/20260715153000_payment_intent_atomic_audit.sql";
const celoBoundaryMigrationPath = "supabase/migrations/20260717120000_celo_home_chain_boundary.sql";
const celoConsumerResourceMigrationPath = "supabase/migrations/20260721120000_celo_consumer_resource.sql";
const productionSetupMigrationPath = "supabase/migrations/20260721130000_celo_production_mainnet_onboarding.sql";
const celoX402SettlementAuditMigrationPath = "supabase/migrations/20260721160000_celo_x402_settlement_audit.sql";
const arcAgentActivityMigrationPath = "supabase/migrations/20260726090000_arc_agent_activity.sql";
const arcReceiptTransitionMigrationPath =
  "supabase/migrations/20260726091000_arc_payment_receipt_transitions.sql";
const migrationsDir = "supabase/migrations";
const requiredTables = ["setup_intents", "agent_wallets", "payment_intents", "payment_events"];
const requiredSecurityStatements = [
  "alter table public.setup_intents enable row level security",
  "alter table public.agent_wallets enable row level security",
  "alter table public.payment_intents enable row level security",
  "alter table public.payment_events enable row level security",
  "revoke all on table public.setup_intents from anon, authenticated",
  "revoke all on table public.agent_wallets from anon, authenticated",
  "revoke all on table public.payment_intents from anon, authenticated",
  "revoke all on table public.payment_events from anon, authenticated",
];
const requiredIndexes = [
  "create index if not exists setup_intents_status_expires_at_idx on public.setup_intents (status, expires_at)",
  "create index if not exists agent_wallets_status_created_at_idx on public.agent_wallets (status, created_at desc)",
  "create index if not exists payment_intents_created_at_idx on public.payment_intents (created_at desc)",
  "create index if not exists payment_intents_status_deadline_idx on public.payment_intents (status, deadline)",
  "create index if not exists payment_events_payment_intent_id_created_at_idx on public.payment_events (payment_intent_id, created_at desc)",
];

function normalizeSql(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, ";")
    .trim()
    .toLowerCase();
}

describe("AgentPay Supabase migration", () => {
  it("defines runtime tables with RLS and query-aligned indexes", async () => {
    const sql = normalizeSql(await readFile(migrationPath, "utf8"));

    for (const tableName of requiredTables) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}\\b`), tableName);
    }

    for (const statement of requiredSecurityStatements) {
      assert.ok(sql.includes(statement), statement);
    }

    for (const index of requiredIndexes) {
      assert.ok(sql.includes(index), index);
    }

    assert.ok(sql.includes("home_chain_id integer not null default 196"), "X Layer home chain default");
    assert.ok(sql.includes("home_chain_id integer not null default 196 check (home_chain_id in (196, 1952))"), "setup intent X Layer network default");
    assert.ok(sql.includes("source_token_symbol text not null check (source_token_symbol in ('usdt0', 'usdc', 'usdt'))"));
  });

  it("includes an upgrade migration for payment intent direct tracking schema drift", async () => {
    const migrationNames = await readdir(migrationsDir);
    const upgradeMigrationName = migrationNames.find((name) => name.endsWith("_align_payment_intents_live_schema.sql"));

    assert.ok(upgradeMigrationName, "Expected a live schema alignment migration");

    const sql = normalizeSql(await readFile(`${migrationsDir}/${upgradeMigrationName}`, "utf8"));

    assert.ok(sql.includes("add column if not exists completed_at timestamptz"), "completed_at upgrade");
    assert.ok(sql.includes("drop constraint if exists payment_intents_route_provider_check"), "route provider drop");
    assert.ok(
      sql.includes("add constraint payment_intents_route_provider_check check (route_provider in ('direct', 'li.fi', 'contract_call'))"),
      "route provider direct/contract-call check",
    );
    assert.ok(sql.includes("drop constraint if exists payment_intents_payment_type_check"), "payment type drop");
    assert.ok(
      sql.includes(
        "add constraint payment_intents_payment_type_check check (payment_type in ('wallet_payment', 'invoice_payment', 'x402_payment', 'contract_call'))",
      ),
      "payment type contract-call check",
    );
    assert.ok(sql.includes("alter column home_chain_id set default 196"), "agent wallet home chain default upgrade");
    assert.ok(sql.includes("add column if not exists home_chain_id integer not null default 196"), "setup intent home chain upgrade");
    assert.ok(sql.includes("notify pgrst, 'reload schema'"), "PostgREST schema cache reload");
  });

  it("defines tenant, challenge, session, and composite isolation controls", async () => {
    const sql = normalizeSql(await readFile(tenantMigrationPath, "utf8"));

    for (const tableName of [
      "tenants",
      "verified_owner_identities",
      "auth_challenges",
      "service_sessions",
      "legacy_migration_audit",
    ]) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}\\b`), tableName);
    }

    for (const column of [
      "alter table public.agent_wallets alter column tenant_id set not null",
      "alter table public.payment_intents alter column tenant_id set not null",
      "alter table public.payment_events alter column tenant_id set not null",
      "credential_digest text not null unique",
      "authentication_epoch bigint not null",
      "consumed_at timestamptz",
    ]) {
      assert.ok(sql.includes(column), column);
    }

    for (const control of [
      "foreign key (tenant_id, owner_address) references public.verified_owner_identities",
      "foreign key (tenant_id, account_address) references public.agent_wallets",
      "foreign key (tenant_id, payment_intent_id) references public.payment_intents",
      "drop constraint if exists payment_intents_account_address_fkey",
      "drop constraint if exists agent_wallets_account_address_key",
      "set status = 'cancelled'",
      "set status = 'closed'",
      "notify pgrst, 'reload schema'",
      "notify pgrst, 'reload schema'",
      "alter table public.service_sessions enable row level security",
      "revoke all on table public.service_sessions from anon, authenticated",
    ]) {
      assert.ok(sql.includes(control), control);
    }
  });

  it("drops the legacy wallet foreign key before normalizing referenced addresses", async () => {
    const sql = normalizeSql(await readFile(tenantMigrationPath, "utf8"));
    const dropLegacyWalletForeignKey = sql.indexOf(
      "alter table public.payment_intents drop constraint if exists payment_intents_account_address_fkey",
    );
    const normalizeWalletAddresses = sql.indexOf(
      "update public.agent_wallets set owner_address = lower(owner_address), account_address = lower(account_address)",
    );
    const normalizePaymentAddresses = sql.indexOf(
      "update public.payment_intents set owner_address = lower(owner_address), account_address = lower(account_address)",
    );

    assert.notEqual(dropLegacyWalletForeignKey, -1, "legacy wallet foreign key drop");
    assert.ok(dropLegacyWalletForeignKey < normalizeWalletAddresses, "drop before wallet address normalization");
    assert.ok(dropLegacyWalletForeignKey < normalizePaymentAddresses, "drop before payment address normalization");
  });

  it("persists a provider-verified minimum output for V2 route signing", async () => {
    const sql = normalizeSql(await readFile(routeMinimumMigrationPath, "utf8"));

    assert.ok(sql.includes("add column if not exists min_amount_out text"), "route minimum column");
    assert.ok(sql.includes("add column if not exists native_value text"), "route native value column");
    assert.ok(sql.includes("payment_intents_min_amount_out_check"), "route minimum constraint");
    assert.ok(sql.includes("notify pgrst, 'reload schema'"), "PostgREST schema cache reload");
  });

  it("persists a tenant-bound Review & Sign handoff without raw tokens", async () => {
    const sql = normalizeSql(await readFile(paymentReviewMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.payment_review_handoffs"));
    assert.ok(sql.includes("token_digest text not null unique"));
    assert.ok(sql.includes("authorization_hash text not null"));
    assert.ok(sql.includes("status text not null default 'pending'"));
    assert.ok(sql.includes("foreign key (tenant_id, payment_intent_id)"));
    assert.ok(sql.includes("alter table public.payment_review_handoffs enable row level security"));
    assert.ok(sql.includes("revoke all on table public.payment_review_handoffs from anon, authenticated"));
    assert.ok(sql.includes("grant select, insert, update, delete on table public.payment_review_handoffs to service_role"));
    assert.ok(sql.includes("create or replace function public.record_payment_review_event"));
    assert.ok(sql.includes("create trigger payment_review_opened_event"));
    assert.ok(sql.includes("create trigger payment_signature_accepted_event"));
    assert.ok(sql.includes("payment_review_opened"));
    assert.ok(sql.includes("payment_signature_accepted"));
  });

  it("defines a singleton runtime identity with operator-only mutation", async () => {
    const sql = normalizeSql(await readFile(runtimeIdentityMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.runtime_environment_identity"));
    assert.ok(sql.includes("id smallint primary key"));
    assert.ok(sql.includes("check (id = 1)"));
    assert.ok(sql.includes("execution_mode text not null check (execution_mode in ('off', 'canary', 'public', 'drain'))"));
    assert.ok(sql.includes("manifest_sha256 text not null"));
    assert.ok(sql.includes("migration_head text not null"));
    assert.ok(sql.includes("check ((chain_id = 196 and caip2 = 'eip155:196')"));
    assert.ok(sql.includes("check (eip712_chain_id = chain_id)"));
    assert.ok(sql.includes("check (x402_network = caip2)"));
    assert.ok(sql.includes("alter table public.runtime_environment_identity enable row level security"));
    assert.ok(sql.includes("grant select on table public.runtime_environment_identity to service_role"));
    assert.ok(sql.includes("revoke insert, update, delete, truncate"));
  });

  it("allows a quarantined legacy owner to receive one active production binding", async () => {
    const sql = normalizeSql(await readFile(canaryOwnerRebindingMigrationPath, "utf8"));

    assert.ok(sql.includes("drop constraint if exists verified_owner_identities_owner_address_key"));
    assert.ok(
      sql.includes(
        "create unique index if not exists verified_owner_identities_verified_owner_idx on public.verified_owner_identities (lower(owner_address)) where status = 'verified'",
      ),
    );
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
  });

  it("defines a fail-closed atomic Celo production setup lifecycle", async () => {
    const sql = normalizeSql(await readFile(productionSetupMigrationPath, "utf8"));

    for (const tableName of [
      "setup_runtime_state",
      "setup_canary_owners",
      "setup_deployment_jobs",
      "setup_deployment_events",
      "setup_sponsor_budgets",
      "setup_rate_limit_buckets",
    ]) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}\\b`), tableName);
      assert.ok(sql.includes(`alter table public.${tableName} enable row level security`), `${tableName} RLS`);
    }

    for (const column of [
      "capability_digest text",
      "deployment_nonce text",
      "manifest_sha256 text",
      "factory_address text",
      "factory_runtime_code_hash text",
      "deployment_salt text",
      "predicted_account text",
      "account_creation_code_hash text",
      "account_runtime_code_hash text",
      "authorization_hash text",
      "owner_setup_signature text",
      "public_error_code text",
    ]) {
      assert.ok(sql.includes(column), column);
    }

    for (const control of [
      "unique (setup_intent_id)",
      "unique (chain_id, deployer_address, deployer_nonce)",
      "unique (transaction_hash)",
      "agent_wallets_tenant_owner_chain_unique",
      "create role agentpay_setup_web nologin noinherit",
      "create role agentpay_setup_worker nologin noinherit",
      "grant agentpay_setup_web, agentpay_setup_worker to authenticator",
      "revoke all on all tables in schema public from public, anon, authenticated",
      "revoke all on all sequences in schema public from public, anon, authenticated",
      "revoke all on all functions in schema public from public, anon, authenticated",
      "set search_path = pg_catalog, public, extensions",
      "notify pgrst, 'reload schema'",
    ]) {
      assert.ok(sql.includes(control), control);
    }

    for (const functionName of [
      "create_production_setup_challenge",
      "read_production_setup_status",
      "consume_production_setup_admission",
      "claim_setup_deployment_job",
      "reserve_setup_sponsor_budget",
      "persist_setup_signed_transaction",
      "mark_setup_broadcast_result",
      "record_setup_receipt",
      "finalize_verified_setup_wallet",
      "mark_setup_manual_review",
      "prune_expired_production_setups",
    ]) {
      assert.ok(sql.includes(`create or replace function public.${functionName}`), functionName);
      assert.ok(sql.includes("security definer"), `${functionName} security definer`);
    }

    assert.ok(sql.includes("owner_setup_signature ~ '^0x[0-9a-fa-f]{130}$'"), "normalized 65-byte setup signature");
    assert.ok(sql.includes("home_chain_id = 42220"), "production setup is pinned to Celo mainnet");
    assert.ok(!sql.includes("home_chain_id = 196"), "legacy X Layer chain cannot enter the Celo setup lifecycle");
    assert.ok(sql.includes("new.owner_setup_signature is distinct from old.owner_setup_signature"), "signature is immutable");
    assert.ok(
      sql.includes("metadata ?| array['ownersetupsignature', 'owner_setup_signature', 'rawtransaction', 'raw_tx']"),
      "events reject setup signatures and raw transaction material",
    );
  });

  it("defines tenant-scoped Arc requests, receipts, batches, and append-only activity", async () => {
    const sql = normalizeSql(await readFile(arcAgentActivityMigrationPath, "utf8"));

    for (const tableName of [
      "arc_payment_requests",
      "arc_payment_receipts",
      "arc_payment_batches",
      "arc_payment_batch_items",
      "arc_agent_activity",
    ]) {
      assert.ok(sql.includes(`create table if not exists public.${tableName}`), `${tableName} table`);
      assert.ok(sql.includes(`alter table public.${tableName} enable row level security`), `${tableName} RLS`);
      assert.ok(
        sql.includes(`revoke all on table public.${tableName} from public, anon, authenticated`),
        `${tableName} anonymous write denial`,
      );
      assert.ok(
        sql.includes(`grant select, insert, update, delete on table public.${tableName} to service_role`),
        `${tableName} service-role access`,
      );
    }

    for (const constraint of [
      "chain text not null default 'ARC-TESTNET' check (chain = 'ARC-TESTNET')",
      "token text not null default 'USDC' check (token = 'USDC')",
      "check (recipient ~ '^0x[0-9a-fa-f]{40}$')",
      "check (amount ~ '^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$' and amount::numeric > 0)",
      "'SUBMITTING'",
      "'RECONCILIATION_REQUIRED'",
      "check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fa-f]{64}$')",
      "unique (tenant_id, idempotency_key)",
      "unique (tenant_id, batch_id, item_index)",
    ]) {
      assert.ok(sql.includes(constraint.toLowerCase()), constraint);
    }

    assert.ok(sql.includes("create unique index if not exists arc_payment_batch_items_recipient_idx"));
    assert.ok(sql.includes("lower(recipient)"));
    assert.ok(sql.includes("create or replace function public.reject_arc_activity_mutation"));
    assert.ok(sql.includes("raise exception 'arc agent activity is append-only'"));
    assert.ok(sql.includes("before update or delete on public.arc_agent_activity"));
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
    assert.doesNotMatch(sql, /create policy .* for insert .* to (?:public|anon|authenticated)/);
  });

  it("creates Arc batches and items through one fail-closed atomic RPC", async () => {
    const sql = normalizeSql(await readFile(arcAgentActivityMigrationPath, "utf8"));

    assert.ok(sql.includes("create or replace function public.create_arc_payment_batch("));
    assert.ok(sql.includes("returns jsonb"));
    assert.ok(sql.includes("language plpgsql"));
    assert.ok(sql.includes("security invoker"));
    assert.ok(sql.includes("if current_user <> 'service_role' then"));
    assert.ok(sql.includes("jsonb_typeof(p_items) is distinct from 'array'"));
    assert.ok(sql.includes("insert into public.arc_payment_batches"));
    assert.ok(sql.includes("on conflict do nothing"));
    assert.ok(sql.includes("get diagnostics v_inserted = row_count"));
    assert.ok(sql.includes("insert into public.arc_payment_batch_items"));
    assert.ok(sql.includes("pg_advisory_xact_lock("));
    assert.ok(sql.includes("jsonb_array_length(p_items) not between 1 and 100"));
    assert.ok(sql.includes("arc payment batch recipients must be unique"));
    assert.ok(sql.includes("raise exception 'arc payment batch replay conflicts with persisted input'"));
    assert.ok(
      sql.includes(
        "revoke all on function public.create_arc_payment_batch(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated",
      ),
    );
    assert.ok(
      sql.includes(
        "grant execute on function public.create_arc_payment_batch(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb) to service_role",
      ),
    );
    assert.doesNotMatch(
      sql,
      /create or replace function public\.create_arc_payment_batch[\s\S]*exception\s+when[\s\S]*commit/,
    );
  });

  it("claims one Arc batch item atomically and audits the non-retriable state", async () => {
    const sql = normalizeSql(await readFile(arcAgentActivityMigrationPath, "utf8"));

    assert.ok(sql.includes("create or replace function public.claim_arc_payment_batch_item("));
    assert.ok(sql.includes("security invoker"));
    assert.ok(sql.includes("if current_user <> 'service_role' then"));
    assert.ok(sql.includes("update public.arc_payment_batch_items"));
    assert.ok(sql.includes("status = 'submitted'"));
    assert.ok(sql.includes("and status = 'pending'"));
    assert.ok(sql.includes("and transaction_id is null"));
    assert.ok(sql.includes("and transaction_hash is null"));
    assert.ok(
      sql.includes(
        "check (status <> 'pending' or (transaction_id is null and transaction_hash is null))",
      ),
    );
    assert.ok(sql.includes("returning to_jsonb(arc_payment_batch_items.*)"));
    assert.ok(sql.includes("insert into public.arc_agent_activity"));
    assert.ok(sql.includes("'batch_item_claimed'"));
    assert.ok(
      sql.includes(
        "revoke all on function public.claim_arc_payment_batch_item(uuid, uuid, text, timestamptz) from public, anon, authenticated",
      ),
    );
    assert.ok(
      sql.includes(
        "grant execute on function public.claim_arc_payment_batch_item(uuid, uuid, text, timestamptz) to service_role",
      ),
    );
  });

  it("transitions Arc receipts and audits them in one state-checked RPC", async () => {
    const sql = normalizeSql(
      await readFile(arcReceiptTransitionMigrationPath, "utf8"),
    );

    assert.ok(sql.includes("create or replace function public.transition_arc_payment_receipt("));
    assert.ok(sql.includes("security invoker"));
    assert.ok(sql.includes("if current_user <> 'service_role' then"));
    assert.ok(sql.includes("for update"));
    assert.ok(sql.includes("v_receipt.status <> p_expected_status"));
    assert.ok(sql.includes("p_expected_status = 'submitting'"));
    assert.ok(sql.includes("p_expected_status = 'submitted'"));
    assert.ok(sql.includes("update public.arc_payment_receipts"));
    assert.ok(sql.includes("insert into public.arc_agent_activity"));
    assert.ok(sql.includes("'payment_transitioned'"));
    assert.ok(sql.includes("return to_jsonb(v_receipt)"));
    assert.doesNotMatch(sql, /update public\.arc_payment_receipts[\s\S]*idempotency_key\s*=/);
    assert.doesNotMatch(sql, /exception\s+when/);
    assert.ok(
      sql.includes(
        "revoke all on function public.transition_arc_payment_receipt( uuid, uuid, text, text, text, text, text, timestamptz ) from public, anon, authenticated",
      ),
    );
    assert.ok(
      sql.includes(
        "grant execute on function public.transition_arc_payment_receipt( uuid, uuid, text, text, text, text, text, timestamptz ) to service_role",
      ),
    );
  });

  it("claims one Arc receipt atomically with exact replay binding and audit", async () => {
    const sql = normalizeSql(await readFile(arcAgentActivityMigrationPath, "utf8"));

    assert.ok(sql.includes("create or replace function public.claim_arc_payment_receipt("));
    assert.ok(sql.includes("security invoker"));
    assert.ok(sql.includes("if current_user <> 'service_role' then"));
    assert.ok(sql.includes("insert into public.arc_payment_receipts"));
    assert.ok(sql.includes("on conflict do nothing"));
    assert.ok(sql.includes("get diagnostics v_inserted = row_count"));
    assert.ok(sql.includes("arc payment receipt replay conflicts with persisted input"));
    assert.ok(sql.includes("create unique index if not exists arc_payment_receipts_request_idx"));
    assert.ok(sql.includes("where payment_request_id is not null"));
    assert.ok(sql.includes("v_request.expires_at <= pg_catalog.now()"));
    assert.ok(sql.includes("'payment_claimed:' || p_receipt_id::text"));
    assert.ok(sql.includes("'payment_claimed'"));
    assert.ok(
      sql.includes(
        "status not in ('pending', 'submitting') or (transaction_id is null and transaction_hash is null)",
      ),
    );
    assert.ok(
      sql.includes("check (status <> 'submitted' or transaction_id is not null)"),
    );
    assert.ok(
      sql.includes(
        "revoke all on function public.claim_arc_payment_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated",
      ),
    );
    assert.ok(
      sql.includes(
        "grant execute on function public.claim_arc_payment_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz) to service_role",
      ),
    );
  });

  it("adds opaque OAuth clients and one-time PKCE authorization records", async () => {
    const sql = normalizeSql(await readFile(oauthConsumerAuthorizationMigrationPath, "utf8"));

    assert.ok(sql.includes("add column if not exists session_lifetime_seconds integer not null default 604800"));
    assert.ok(sql.includes("add column if not exists flow text not null default 'legacy_session'"));
    assert.ok(sql.includes("check (flow in ('legacy_session', 'oauth_authorization'))"));
    assert.ok(sql.includes("create table if not exists public.oauth_clients"));
    assert.ok(sql.includes("redirect_uris text[] not null"));
    assert.ok(sql.includes("last_used_at timestamptz not null default now()"));
    assert.ok(sql.includes("create table if not exists public.oauth_authorizations"));
    assert.ok(sql.includes("state_digest text not null"));
    assert.ok(sql.includes("code_challenge text not null"));
    assert.ok(sql.includes("code_digest text unique"));
    assert.ok(sql.includes("consumed_at timestamptz"));
    assert.ok(sql.includes("foreign key (client_id) references public.oauth_clients"));
    assert.ok(sql.includes("alter table public.oauth_clients enable row level security"));
    assert.ok(sql.includes("alter table public.oauth_authorizations enable row level security"));
    assert.ok(sql.includes("revoke all on table public.oauth_clients from public, anon, authenticated"));
    assert.ok(sql.includes("revoke all on table public.oauth_authorizations from public, anon, authenticated"));
    assert.ok(sql.includes("grant select, insert, update on table public.oauth_clients, public.oauth_authorizations, public.oauth_rate_limit_buckets to service_role"));
    assert.ok(sql.includes("create index if not exists oauth_authorizations_code_digest_idx"));
    assert.ok(sql.includes("create table if not exists public.oauth_rate_limit_buckets"));
    assert.ok(sql.includes("key_digest text not null check (key_digest ~ '^[0-9a-f]{64}$')"));
    assert.ok(sql.includes("create or replace function public.consume_oauth_admission"));
    assert.ok(sql.includes("create or replace function public.prune_oauth_authorization_data"));
    assert.ok(sql.includes("delete from public.oauth_authorizations"));
    assert.ok(sql.includes("delete from public.oauth_clients as client"));
    assert.ok(sql.includes("from public.oauth_authorizations as authorization_record"), "non-reserved authorization cleanup alias");
    assert.ok(!sql.includes("as authorization where"), "reserved authorization is never used as a SQL alias");
    assert.ok(sql.includes("alter table public.oauth_rate_limit_buckets enable row level security"));
    assert.ok(sql.includes("create or replace function public.exchange_oauth_authorization_code"));
    assert.ok(sql.includes("insert into public.service_sessions"));
    assert.ok(sql.includes("revoke all on function public.exchange_oauth_authorization_code"));
    assert.ok(sql.includes("grant execute on function public.exchange_oauth_authorization_code"));
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
  });

  it("binds paid ASP settlement to one tenant-safe lifecycle and stores deterministic replay output", async () => {
    const sql = normalizeSql(await readFile(paidExecutionLifecycleMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.paid_execution_lifecycles"));
    for (const column of [
      "tenant_id uuid not null",
      "idempotency_key text not null",
      "payment_payload_hash text not null",
      "payment_requirements_hash text not null",
      "request_hash text not null",
      "arguments_hash text not null",
      "settlement_tx_hash text",
      "response_body_base64 text",
    ]) {
      assert.ok(sql.includes(column), column);
    }
    for (const status of ["claimed", "settling", "settled", "executing", "completed", "failed"]) {
      assert.ok(sql.includes(status), `status ${status}`);
    }
    assert.ok(sql.includes("unique (tenant_id, idempotency_key)"));
    assert.ok(sql.includes("foreign key (tenant_id, payment_intent_id)"));
    assert.ok(sql.includes("alter table public.paid_execution_lifecycles enable row level security"));
    assert.ok(sql.includes("revoke all on table public.paid_execution_lifecycles from public, anon, authenticated"));
    assert.ok(sql.includes("grant select, insert, update on table public.paid_execution_lifecycles to service_role"));
    assert.ok(sql.includes("set_paid_execution_lifecycles_updated_at"));
  });

  it("adds durable challenge, independent fee/refund states, and signed invoice outbox controls", async () => {
    const sql = normalizeSql(await readFile(paidExecutionChallengeOutboxMigrationPath, "utf8"));

    for (const column of ["authorization_hash text", "fee_status text", "execution_status text", "refund_status text"]) {
      assert.ok(sql.includes(column), column);
    }
    for (const status of ["settlement_unknown", "settlement_rejected", "broadcast_unknown", "manual_review", "required"]) {
      assert.ok(sql.includes(status), status);
    }
    assert.ok(sql.includes("create table if not exists public.asp_payment_challenges"));
    assert.ok(sql.includes("payment_requirements_hash text not null"));
    assert.ok(sql.includes("status text not null default 'offered'"));
    assert.ok(sql.includes("create table if not exists public.invoice_execution_outbox"));
    assert.ok(sql.includes("raw_tx_ciphertext text"));
    assert.ok(sql.includes("raw_tx_hash text"));
    assert.ok(sql.includes("unique (chain_id, executor_address, executor_nonce)"));
    assert.ok(sql.includes("alter table public.asp_payment_challenges enable row level security"));
    assert.ok(sql.includes("alter table public.invoice_execution_outbox enable row level security"));
    assert.ok(sql.includes("grant select, insert, update on table public.asp_payment_challenges, public.invoice_execution_outbox to service_role"));
  });

  it("records complete Celo x402 fee settlement evidence in the payment audit log", async () => {
    const sql = normalizeSql(await readFile(celoX402SettlementAuditMigrationPath, "utf8"));

    for (const column of ["fee_network text", "fee_asset text", "fee_amount text", "fee_pay_to text"]) {
      assert.ok(sql.includes(column), column);
    }
    assert.ok(sql.includes("create or replace function public.record_paid_execution_settlement_event"));
    assert.ok(sql.includes("'x402_fee_settled'"));
    for (const field of ["lifecycleid", "payer", "payto", "amount", "asset", "network", "transactionhash"]) {
      assert.ok(sql.includes(`'${field}'`), field);
    }
    assert.ok(sql.includes("insert into public.payment_events"));
    assert.ok(sql.includes("on conflict do nothing"));
  });

  it("adds a transactional canary reservation ledger without enabling execution", async () => {
    const sql = normalizeSql(await readFile(paidExecutionCanaryLedgerMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.paid_execution_canary_reservations"));
    assert.ok(sql.includes("unique (environment, reservation_key)"));
    assert.ok(sql.includes("unique (environment, lifecycle_id)"));
    assert.ok(sql.includes("length(reservation_key) between 1 and 256"), "reservation key length is bounded without PostgreSQL's 255 repetition limit");
    assert.ok(!sql.includes("{1,256}"), "PostgreSQL does not accept a 256 repetition upper bound");
    assert.ok(sql.includes("amount_atomic numeric(78, 0) not null"));
    assert.ok(sql.includes("status in ('reserved', 'completed', 'manual_review')"));
    assert.ok(sql.includes("pg_advisory_xact_lock"));
    assert.ok(sql.includes("agentpay:canary:' || p_environment"), "campaign-wide advisory lock");
    assert.ok(sql.includes("'accepted_lifecycles', ( select count(*)::bigint from public.paid_execution_canary_reservations where environment = p_environment )"), "lifecycle cap does not reset daily");
    assert.ok(sql.includes("where environment = p_environment and tenant_id = p_tenant_id and status in ('reserved', 'manual_review')"), "cross-midnight in-flight fence");
    assert.ok(sql.includes("create or replace function public.reserve_paid_execution_canary"));
    assert.ok(sql.includes("create or replace function public.get_paid_execution_canary_usage"));
    assert.ok(sql.includes("create or replace function public.complete_paid_execution_canary"));
    assert.ok(sql.includes("canary_auto_stop"));
    assert.ok(sql.includes("alter table public.paid_execution_canary_reservations enable row level security"));
    assert.ok(sql.includes("revoke all on table public.paid_execution_canary_reservations from public, anon, authenticated"));
    assert.ok(sql.includes("grant execute on function public.reserve_paid_execution_canary"));
  });

  it("records payment intent state changes with a transactional tenant-bound audit trigger", async () => {
    const sql = normalizeSql(await readFile(paymentIntentAuditMigrationPath, "utf8"));

    assert.ok(sql.startsWith("begin;"));
    assert.ok(sql.endsWith("commit;"));
    assert.ok(sql.includes("create or replace function public.record_payment_intent_state_event"));
    assert.ok(sql.includes("after insert or update of status on public.payment_intents"));
    assert.ok(sql.includes("insert into public.payment_events"));
    assert.ok(sql.includes("new.tenant_id"));
    assert.ok(sql.includes("new.id"));
    for (const eventType of [
      "payment_created",
      "payment_approved",
      "payment_executing",
      "payment_failed",
      "payment_expired",
      "payment_completed",
    ]) {
      assert.ok(sql.includes(eventType), eventType);
    }
    assert.ok(sql.includes("revoke all on function public.record_payment_intent_state_event"));
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
  });

  it("replaces legacy X Layer persistence constraints with the Celo home-chain boundary", async () => {
    const sql = normalizeSql(await readFile(celoBoundaryMigrationPath, "utf8"));

    assert.ok(sql.startsWith("begin;"));
    assert.ok(sql.endsWith("commit;"));
    for (const statement of [
      "alter column home_chain_id set default 42220",
      "check (home_chain_id in (42220, 11142220))",
      "check (chain_id in (42220, 11142220))",
      "check (source_chain_id in (42220, 11142220))",
      "check (source_token_symbol in ('usdc', 'usdt', 'usdm'))",
      "check (destination_token_symbol in ('usdt0', 'usdc', 'usdt', 'usdm'))",
      "check (caip2 in ('eip155:42220', 'eip155:11142220'))",
      "check ((chain_id = 42220 and caip2 = 'eip155:42220') or (chain_id = 11142220 and caip2 = 'eip155:11142220'))",
      "notify pgrst, 'reload schema'",
    ]) {
      assert.ok(sql.includes(statement), statement);
    }
    assert.ok(!sql.includes("default 196"));
  });

  it("migrates OAuth authorization resources to the isolated Celo MCP path", async () => {
    const sql = normalizeSql(await readFile(celoConsumerResourceMigrationPath, "utf8"));

    assert.ok(sql.startsWith("begin;"));
    assert.ok(sql.endsWith("commit;"));
    assert.ok(sql.includes("drop constraint if exists oauth_authorizations_resource_check"));
    assert.ok(sql.includes("check (resource = 'https://wallet.agentpay.site/celo/mcp')"));
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
  });
});
