-- Migration: 20260729020000_arc_hosted_identity.sql
-- Description: Arc-only hosted identity, tenant mapping, autonomy consent, and private Circle wallet bindings schema.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;


create table if not exists public.arc_hosted_accounts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  account_status text not null check (account_status in ('ACTIVE', 'PAUSED', 'CLOSED')),
  consent_version text not null check (consent_version = 'arc-hosted-autonomy-v1'),
  consent_timestamp timestamptz not null default now(),
  wallet_address text check (wallet_address is null or wallet_address ~ '^0x[0-9a-f]{40}$'),
  wallet_status text not null check (wallet_status in ('PENDING', 'PROVISIONING', 'LIVE', 'FAILED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_user_id, tenant_id)
);

create table if not exists public.arc_circle_wallet_bindings (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  provisioning_idempotency_key uuid not null unique,
  circle_wallet_set_id text,
  circle_wallet_id text,
  wallet_address text check (wallet_address is null or wallet_address ~ '^0x[0-9a-f]{40}$'),
  blockchain text check (blockchain is null or blockchain = 'ARC-TESTNET'),
  account_type text check (account_type is null or account_type = 'SCA'),
  custody_type text check (custody_type is null or custody_type = 'DEVELOPER'),
  provisioning_state text not null check (provisioning_state in ('PENDING', 'PROVISIONING', 'LIVE', 'FAILED', 'CLOSED')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (auth_user_id, tenant_id) references public.arc_hosted_accounts(auth_user_id, tenant_id) on delete cascade,
  check (
    provisioning_state != 'LIVE' or (
      circle_wallet_set_id is not null and
      circle_wallet_id is not null and
      wallet_address is not null and
      blockchain = 'ARC-TESTNET' and
      account_type = 'SCA' and
      custody_type = 'DEVELOPER'
    )
  )
);

-- Enable RLS
alter table public.arc_hosted_accounts enable row level security;
alter table public.arc_circle_wallet_bindings enable row level security;

-- RLS Policies
create policy arc_hosted_accounts_user_select on public.arc_hosted_accounts
  for select
  to authenticated
  using (auth_user_id = auth.uid());

-- Note: arc_circle_wallet_bindings has no select/insert/update/delete policy for authenticated or anon roles.
-- It is strictly backend service_role accessible.

-- Indexes for performance and reconciliation
create index if not exists idx_arc_hosted_accounts_tenant_status on public.arc_hosted_accounts (tenant_id, account_status);
create index if not exists idx_arc_hosted_accounts_user_status on public.arc_hosted_accounts (auth_user_id, account_status);
create index if not exists idx_arc_circle_wallet_bindings_prov_state on public.arc_circle_wallet_bindings (provisioning_state);

-- Atomic Service-Role RPC Functions

-- 1. Claim or fetch hosted account
create or replace function public.arc_claim_hosted_account(
  p_auth_user_id uuid,
  p_consent_version text default 'arc-hosted-autonomy-v1'
)
returns table (
  auth_user_id uuid,
  tenant_id uuid,
  account_status text,
  consent_version text,
  consent_timestamp timestamptz,
  wallet_address text,
  wallet_status text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_account_exists boolean;
begin
  if p_consent_version != 'arc-hosted-autonomy-v1' then
    raise exception 'Invalid consent version: %', p_consent_version;
  end if;

  select exists(
    select 1 from public.arc_hosted_accounts a where a.auth_user_id = p_auth_user_id
  ) into v_account_exists;

  if not v_account_exists then
    -- Create new tenant
    insert into public.tenants (id, name, created_at)
    values (gen_random_uuid(), 'arc-hosted-' || p_auth_user_id::text, now())
    returning id into v_tenant_id;

    -- Create hosted account record
    insert into public.arc_hosted_accounts (
      auth_user_id,
      tenant_id,
      account_status,
      consent_version,
      consent_timestamp,
      wallet_address,
      wallet_status,
      created_at,
      updated_at
    ) values (
      p_auth_user_id,
      v_tenant_id,
      'ACTIVE',
      p_consent_version,
      now(),
      null,
      'PENDING',
      now(),
      now()
    );

    -- Create pending Circle wallet binding
    insert into public.arc_circle_wallet_bindings (
      auth_user_id,
      tenant_id,
      provisioning_idempotency_key,
      circle_wallet_set_id,
      circle_wallet_id,
      wallet_address,
      blockchain,
      account_type,
      custody_type,
      provisioning_state,
      error_code,
      created_at,
      updated_at
    ) values (
      p_auth_user_id,
      v_tenant_id,
      gen_random_uuid(),
      null,
      null,
      null,
      null,
      null,
      null,
      'PENDING',
      null,
      now(),
      now()
    );
  end if;

  return query
  select
    a.auth_user_id,
    a.tenant_id,
    a.account_status,
    a.consent_version,
    a.consent_timestamp,
    a.wallet_address,
    a.wallet_status,
    a.created_at,
    a.updated_at
  from public.arc_hosted_accounts a
  where a.auth_user_id = p_auth_user_id;
end;
$$;

-- 2. Claim provisioning job
create or replace function public.arc_claim_provisioning_job(
  p_auth_user_id uuid
)
returns table (
  auth_user_id uuid,
  tenant_id uuid,
  provisioning_idempotency_key uuid,
  provisioning_state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding record;
begin
  select b.auth_user_id, b.tenant_id, b.provisioning_idempotency_key, b.provisioning_state
  into v_binding
  from public.arc_circle_wallet_bindings b
  where b.auth_user_id = p_auth_user_id;

  if not found then
    raise exception 'Binding not found for user: %', p_auth_user_id;
  end if;

  if v_binding.provisioning_state in ('PENDING', 'FAILED') then
    update public.arc_circle_wallet_bindings
    set provisioning_state = 'PROVISIONING',
        updated_at = now()
    where arc_circle_wallet_bindings.auth_user_id = p_auth_user_id;

    update public.arc_hosted_accounts
    set wallet_status = 'PROVISIONING',
        updated_at = now()
    where arc_hosted_accounts.auth_user_id = p_auth_user_id;
  end if;

  return query
  select b.auth_user_id, b.tenant_id, b.provisioning_idempotency_key, b.provisioning_state
  from public.arc_circle_wallet_bindings b
  where b.auth_user_id = p_auth_user_id;
end;
$$;

-- 3. Complete provisioning
create or replace function public.arc_complete_provisioning(
  p_auth_user_id uuid,
  p_circle_wallet_set_id text,
  p_circle_wallet_id text,
  p_wallet_address text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_address text;
begin
  v_address := lower(p_wallet_address);

  update public.arc_circle_wallet_bindings
  set circle_wallet_set_id = p_circle_wallet_set_id,
      circle_wallet_id = p_circle_wallet_id,
      wallet_address = v_address,
      blockchain = 'ARC-TESTNET',
      account_type = 'SCA',
      custody_type = 'DEVELOPER',
      provisioning_state = 'LIVE',
      error_code = null,
      updated_at = now()
  where arc_circle_wallet_bindings.auth_user_id = p_auth_user_id;

  update public.arc_hosted_accounts
  set wallet_address = v_address,
      wallet_status = 'LIVE',
      updated_at = now()
  where arc_hosted_accounts.auth_user_id = p_auth_user_id;
end;
$$;

-- 4. Fail provisioning
create or replace function public.arc_fail_provisioning(
  p_auth_user_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.arc_circle_wallet_bindings
  set provisioning_state = 'FAILED',
      error_code = p_error_code,
      updated_at = now()
  where arc_circle_wallet_bindings.auth_user_id = p_auth_user_id;

  update public.arc_hosted_accounts
  set wallet_status = 'FAILED',
      updated_at = now()
  where arc_hosted_accounts.auth_user_id = p_auth_user_id;
end;
$$;

-- 5. Set account status & invalidate tenant auth epoch
create or replace function public.arc_set_account_status(
  p_auth_user_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if p_status not in ('ACTIVE', 'PAUSED', 'CLOSED') then
    raise exception 'Invalid account status: %', p_status;
  end if;

  update public.arc_hosted_accounts
  set account_status = p_status,
      updated_at = now()
  where arc_hosted_accounts.auth_user_id = p_auth_user_id
  returning tenant_id into v_tenant_id;

  if v_tenant_id is not null then
    update public.tenants
    set auth_epoch = auth_epoch + 1,
        updated_at = now()
    where id = v_tenant_id;
  end if;
end;
$$;

-- Revoke execution from public, anon, and authenticated
revoke all on function public.arc_claim_hosted_account(uuid, text) from public, anon, authenticated;
revoke all on function public.arc_claim_provisioning_job(uuid) from public, anon, authenticated;
revoke all on function public.arc_complete_provisioning(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.arc_fail_provisioning(uuid, text) from public, anon, authenticated;
revoke all on function public.arc_set_account_status(uuid, text) from public, anon, authenticated;

-- Grant execution strictly to service_role
grant execute on function public.arc_claim_hosted_account(uuid, text) to service_role;
grant execute on function public.arc_claim_provisioning_job(uuid) to service_role;
grant execute on function public.arc_complete_provisioning(uuid, text, text, text) to service_role;
grant execute on function public.arc_fail_provisioning(uuid, text) to service_role;
grant execute on function public.arc_set_account_status(uuid, text) to service_role;
