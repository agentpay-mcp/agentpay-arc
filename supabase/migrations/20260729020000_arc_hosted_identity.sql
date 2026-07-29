-- Migration: 20260729020000_arc_hosted_identity.sql
-- Description: Arc-only hosted identity, tenant mapping, autonomy consent, and private Circle wallet bindings schema.

begin;

-- Expand arc_agent_activity activity_type constraint to include hosted identity events if table exists
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'arc_agent_activity'
  ) then
    alter table public.arc_agent_activity drop constraint if exists arc_agent_activity_activity_type_check;
    alter table public.arc_agent_activity add constraint arc_agent_activity_activity_type_check
      check (activity_type in ('PAYMENT', 'BATCH_PAYOUT', 'PAYMENT_REQUEST', 'HOSTED_IDENTITY', 'CIRCLE_WALLET_PROVISIONING'));
  end if;
end $$;

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
  fencing_token uuid not null default gen_random_uuid(),
  circle_wallet_set_id text unique,
  circle_wallet_id text unique,
  wallet_address text unique check (wallet_address is null or wallet_address ~ '^0x[0-9a-f]{40}$'),
  blockchain text check (blockchain is null or blockchain = 'ARC-TESTNET'),
  account_type text check (account_type is null or account_type = 'SCA'),
  custody_type text check (custody_type is null or custody_type = 'DEVELOPER'),
  provisioning_state text not null check (provisioning_state in ('PENDING', 'PROVISIONING', 'LIVE', 'FAILED', 'CLOSED')),
  error_code text check (error_code is null or (length(trim(error_code)) > 0 and length(error_code) <= 128 and error_code ~ '^[a-zA-Z0-9_-]+$')),
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

-- Schema Usage Grants
grant usage on schema public to anon, authenticated, service_role;

-- Enable RLS
alter table public.arc_hosted_accounts enable row level security;
alter table public.arc_circle_wallet_bindings enable row level security;

-- Table Grants
grant select on public.arc_hosted_accounts to authenticated;
grant select, insert, update, delete on public.arc_hosted_accounts to service_role;
grant select, insert, update, delete on public.arc_circle_wallet_bindings to service_role;

-- RLS Policies
create policy arc_hosted_accounts_user_select on public.arc_hosted_accounts
  for select
  to authenticated
  using (auth_user_id = auth.uid());

create policy arc_hosted_accounts_service_role_all on public.arc_hosted_accounts
  for all
  to service_role
  using (true)
  with check (true);

create policy arc_circle_wallet_bindings_service_role_all on public.arc_circle_wallet_bindings
  for all
  to service_role
  using (true)
  with check (true);

-- Allow service_role to query tenants if RLS enabled
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'tenants' and policyname = 'tenants_service_role_all'
  ) then
    create policy tenants_service_role_all on public.tenants for all to service_role using (true) with check (true);
  end if;
end $$;

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
  v_account_exists boolean;
  v_tenant_id uuid;
begin
  if p_consent_version != 'arc-hosted-autonomy-v1' then
    raise exception 'Invalid consent version: %', p_consent_version;
  end if;

  -- Transaction advisory lock to serialize concurrent claims for the same auth_user_id
  perform pg_advisory_xact_lock(hashtext('arc_claim_hosted_account:' || p_auth_user_id::text));

  select exists(
    select 1 from public.arc_hosted_accounts a where a.auth_user_id = p_auth_user_id for update
  ) into v_account_exists;

  if not v_account_exists then
    insert into public.tenants (environment, status, auth_epoch, created_at, updated_at)
    values ('production', 'ACTIVE', 0, now(), now())
    returning id into v_tenant_id;

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
      fencing_token,
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

    -- Audit account creation event if arc_agent_activity table exists
    if exists (select 1 from information_schema.tables where table_name = 'arc_agent_activity') then
      insert into public.arc_agent_activity (tenant_id, id, activity_type, status, reference_id, metadata, created_at)
      values (
        v_tenant_id,
        'hosted_account_created:' || p_auth_user_id::text,
        'HOSTED_IDENTITY',
        'ACTIVE',
        p_auth_user_id::text,
        jsonb_build_object('consent_version', p_consent_version, 'wallet_status', 'PENDING'),
        now()
      )
      on conflict on constraint arc_agent_activity_pkey do nothing;
    end if;
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
  fencing_token uuid,
  provisioning_state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding record;
  v_fencing_token uuid;
begin
  select b.auth_user_id, b.tenant_id, b.provisioning_idempotency_key, b.fencing_token, b.provisioning_state, b.updated_at
  into v_binding
  from public.arc_circle_wallet_bindings b
  where b.auth_user_id = p_auth_user_id
  for update skip locked;

  if not found then
    return;
  end if;

  if v_binding.provisioning_state in ('PENDING', 'FAILED') or (
     v_binding.provisioning_state = 'PROVISIONING' and v_binding.updated_at < now() - interval '5 minutes'
  ) then
    v_fencing_token := gen_random_uuid();

    update public.arc_circle_wallet_bindings
    set provisioning_state = 'PROVISIONING',
        fencing_token = v_fencing_token,
        updated_at = now()
    where arc_circle_wallet_bindings.auth_user_id = p_auth_user_id;

    update public.arc_hosted_accounts
    set wallet_status = 'PROVISIONING',
        updated_at = now()
    where arc_hosted_accounts.auth_user_id = p_auth_user_id;

    if exists (select 1 from information_schema.tables where table_name = 'arc_agent_activity') then
      insert into public.arc_agent_activity (tenant_id, id, activity_type, status, reference_id, metadata, created_at)
      values (
        v_binding.tenant_id,
        'provisioning_claimed:' || v_binding.provisioning_idempotency_key::text || ':' || gen_random_uuid()::text,
        'CIRCLE_WALLET_PROVISIONING',
        'PROVISIONING',
        p_auth_user_id::text,
        jsonb_build_object('idempotency_key', v_binding.provisioning_idempotency_key, 'auth_user_id', p_auth_user_id),
        now()
      )
      on conflict on constraint arc_agent_activity_pkey do nothing;
    end if;

    return query
    select b.auth_user_id, b.tenant_id, b.provisioning_idempotency_key, b.fencing_token, b.provisioning_state
    from public.arc_circle_wallet_bindings b
    where b.auth_user_id = p_auth_user_id;
  end if;
end;
$$;

-- 3. Complete provisioning
create or replace function public.arc_complete_provisioning(
  p_auth_user_id uuid,
  p_fencing_token uuid,
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
  v_binding record;
begin
  v_address := lower(trim(p_wallet_address));

  select b.tenant_id, b.circle_wallet_set_id, b.circle_wallet_id, b.wallet_address, b.provisioning_state, b.fencing_token
  into v_binding
  from public.arc_circle_wallet_bindings b
  where b.auth_user_id = p_auth_user_id
  for update;

  if not found then
    raise exception 'Binding record not found for user: %', p_auth_user_id;
  end if;

  -- Idempotent replay check if already LIVE with exact matching parameters and fencing token
  if v_binding.provisioning_state = 'LIVE' then
    if v_binding.circle_wallet_set_id = p_circle_wallet_set_id and
       v_binding.circle_wallet_id = p_circle_wallet_id and
       v_binding.wallet_address = v_address and
       v_binding.fencing_token = p_fencing_token then
      return;
    else
      raise exception 'Cannot re-complete LIVE provisioning with conflicting Circle IDs or address';
    end if;
  end if;

  if v_binding.fencing_token != p_fencing_token then
    raise exception 'Stale or invalid fencing token for provisioning completion';
  end if;

  if v_binding.provisioning_state != 'PROVISIONING' then
    raise exception 'Cannot complete provisioning from state: %', v_binding.provisioning_state;
  end if;

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

  if exists (select 1 from information_schema.tables where table_name = 'arc_agent_activity') then
    insert into public.arc_agent_activity (tenant_id, id, activity_type, status, reference_id, metadata, created_at)
    values (
      v_binding.tenant_id,
      'provisioning_completed:' || p_auth_user_id::text || ':' || now()::text,
      'CIRCLE_WALLET_PROVISIONING',
      'LIVE',
      p_auth_user_id::text,
      jsonb_build_object(
        'wallet_address', v_address
      ),
      now()
    )
    on conflict on constraint arc_agent_activity_pkey do nothing;
  end if;
end;
$$;

-- 4. Fail provisioning
create or replace function public.arc_fail_provisioning(
  p_auth_user_id uuid,
  p_fencing_token uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding record;
begin
  select b.tenant_id, b.provisioning_state, b.fencing_token, b.error_code
  into v_binding
  from public.arc_circle_wallet_bindings b
  where b.auth_user_id = p_auth_user_id
  for update;

  if not found then
    raise exception 'Binding record not found for user: %', p_auth_user_id;
  end if;

  -- Idempotent replay check if already FAILED with matching error_code and fencing_token
  if v_binding.provisioning_state = 'FAILED' and
     v_binding.fencing_token = p_fencing_token and
     v_binding.error_code = p_error_code then
    return;
  end if;

  if v_binding.fencing_token != p_fencing_token then
    raise exception 'Stale or invalid fencing token for provisioning failure';
  end if;

  if v_binding.provisioning_state not in ('PENDING', 'PROVISIONING') then
    raise exception 'Cannot fail provisioning from state: %', v_binding.provisioning_state;
  end if;

  update public.arc_circle_wallet_bindings
  set provisioning_state = 'FAILED',
      error_code = p_error_code,
      updated_at = now()
  where arc_circle_wallet_bindings.auth_user_id = p_auth_user_id;

  update public.arc_hosted_accounts
  set wallet_status = 'FAILED',
      updated_at = now()
  where arc_hosted_accounts.auth_user_id = p_auth_user_id;

  if exists (select 1 from information_schema.tables where table_name = 'arc_agent_activity') then
    insert into public.arc_agent_activity (tenant_id, id, activity_type, status, reference_id, metadata, created_at)
    values (
      v_binding.tenant_id,
      'provisioning_failed:' || p_auth_user_id::text || ':' || now()::text,
      'CIRCLE_WALLET_PROVISIONING',
      'FAILED',
      p_auth_user_id::text,
      jsonb_build_object('error_code', p_error_code),
      now()
    )
    on conflict on constraint arc_agent_activity_pkey do nothing;
  end if;
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
  v_current_status text;
begin
  if p_status not in ('ACTIVE', 'PAUSED', 'CLOSED') then
    raise exception 'Invalid account status: %', p_status;
  end if;

  select a.tenant_id, a.account_status
  into v_tenant_id, v_current_status
  from public.arc_hosted_accounts a
  where a.auth_user_id = p_auth_user_id
  for update;

  if v_tenant_id is null then
    raise exception 'Hosted account not found for user: %', p_auth_user_id;
  end if;

  if v_current_status = p_status then
    return;
  end if;

  if v_current_status = 'CLOSED' then
    raise exception 'Cannot transition closed account for user: %', p_auth_user_id;
  end if;

  update public.arc_hosted_accounts
  set account_status = p_status,
      updated_at = now()
  where arc_hosted_accounts.auth_user_id = p_auth_user_id;

  update public.tenants
  set auth_epoch = auth_epoch + 1,
      updated_at = now()
  where id = v_tenant_id;

  if exists (select 1 from information_schema.tables where table_name = 'arc_agent_activity') then
    insert into public.arc_agent_activity (tenant_id, id, activity_type, status, reference_id, metadata, created_at)
    values (
      v_tenant_id,
      'account_status_changed:' || p_status || ':' || now()::text,
      'HOSTED_IDENTITY',
      p_status,
      p_auth_user_id::text,
      jsonb_build_object('account_status', p_status),
      now()
    )
    on conflict on constraint arc_agent_activity_pkey do nothing;
  end if;
end;
$$;

-- Revoke execution from public, anon, and authenticated
revoke all on function public.arc_claim_hosted_account(uuid, text) from public, anon, authenticated;
revoke all on function public.arc_claim_provisioning_job(uuid) from public, anon, authenticated;
revoke all on function public.arc_complete_provisioning(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.arc_fail_provisioning(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.arc_set_account_status(uuid, text) from public, anon, authenticated;

-- Grant execution strictly to service_role
grant execute on function public.arc_claim_hosted_account(uuid, text) to service_role;
grant execute on function public.arc_claim_provisioning_job(uuid) to service_role;
grant execute on function public.arc_complete_provisioning(uuid, uuid, text, text, text) to service_role;
grant execute on function public.arc_fail_provisioning(uuid, uuid, text) to service_role;
grant execute on function public.arc_set_account_status(uuid, text) to service_role;

commit;
