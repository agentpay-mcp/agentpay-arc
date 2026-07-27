begin;

create table if not exists public.arc_liquidity_operations (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id uuid not null,
  kind text not null check (kind in ('BRIDGE', 'SWAP', 'SWAP_AND_PAY')),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (
    status in (
      'SUBMITTING', 'SUBMITTED', 'SWAP_VERIFIED', 'PAYING',
      'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'
    )
  ),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  quote_expires_at timestamptz not null,
  steps jsonb not null default '[]'::jsonb check (
    jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 32
  ),
  error_code text check (
    error_code is null
    or error_code in ('EXECUTION_AMBIGUOUS', 'PROOF_UNAVAILABLE', 'RECEIVED_BELOW_MINIMUM')
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, id),
  check (updated_at >= created_at),
  check (status <> 'SUBMITTING' or steps = '[]'::jsonb),
  check (status <> 'RECONCILIATION_REQUIRED' or error_code is not null)
);

create index if not exists arc_liquidity_operations_tenant_updated_idx
  on public.arc_liquidity_operations (tenant_id, updated_at desc);

alter table public.arc_liquidity_operations enable row level security;
revoke all on table public.arc_liquidity_operations from public, anon, authenticated;
grant select, insert, update on table public.arc_liquidity_operations to service_role;

create or replace function public.get_arc_liquidity_operation(
  p_tenant_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operation public.arc_liquidity_operations%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc liquidity read requires service_role' using errcode = '42501';
  end if;
  select * into v_operation
  from public.arc_liquidity_operations
  where tenant_id = p_tenant_id and id = p_operation_id;
  if v_operation.id is null then
    return null;
  end if;
  return to_jsonb(v_operation);
end;
$$;

create or replace function public.claim_arc_liquidity_operation(
  p_tenant_id uuid,
  p_operation jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operation public.arc_liquidity_operations%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc liquidity claim requires service_role' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arc-liquidity:' || p_tenant_id::text || ':' || (p_operation->>'id'),
      0
    )
  );
  select * into v_operation
  from public.arc_liquidity_operations
  where tenant_id = p_tenant_id and id = (p_operation->>'id')::uuid;
  if v_operation.id is not null then
    if v_operation.kind <> p_operation->>'kind'
      or v_operation.input_fingerprint <> p_operation->>'inputFingerprint'
      or lower(v_operation.wallet_address) <> lower(p_operation->>'walletAddress')
    then
      raise exception 'Arc liquidity replay conflicts with persisted input';
    end if;
    return jsonb_build_object('claimed', false, 'operation', to_jsonb(v_operation));
  end if;
  if p_operation->>'status' <> 'SUBMITTING'
    or p_operation->'steps' <> '[]'::jsonb
    or p_operation->>'errorCode' is not null
  then
    raise exception 'Arc liquidity initial claim is invalid';
  end if;
  insert into public.arc_liquidity_operations (
    tenant_id, id, kind, input_fingerprint, status, wallet_address,
    quote_expires_at, steps, error_code, created_at, updated_at
  ) values (
    p_tenant_id,
    (p_operation->>'id')::uuid,
    p_operation->>'kind',
    p_operation->>'inputFingerprint',
    'SUBMITTING',
    p_operation->>'walletAddress',
    (p_operation->>'quoteExpiresAt')::timestamptz,
    '[]'::jsonb,
    null,
    (p_operation->>'createdAt')::timestamptz,
    (p_operation->>'updatedAt')::timestamptz
  )
  returning * into v_operation;
  return jsonb_build_object('claimed', true, 'operation', to_jsonb(v_operation));
end;
$$;

create or replace function public.transition_arc_liquidity_operation(
  p_tenant_id uuid,
  p_operation jsonb,
  p_expected_statuses text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operation public.arc_liquidity_operations%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc liquidity transition requires service_role' using errcode = '42501';
  end if;
  if coalesce(array_length(p_expected_statuses, 1), 0) = 0 then
    raise exception 'Arc liquidity expected status is required';
  end if;
  update public.arc_liquidity_operations
  set
    status = p_operation->>'status',
    steps = p_operation->'steps',
    error_code = nullif(p_operation->>'errorCode', ''),
    updated_at = (p_operation->>'updatedAt')::timestamptz
  where tenant_id = p_tenant_id
    and id = (p_operation->>'id')::uuid
    and status = any(p_expected_statuses)
    and kind = p_operation->>'kind'
    and input_fingerprint = p_operation->>'inputFingerprint'
    and lower(wallet_address) = lower(p_operation->>'walletAddress')
    and quote_expires_at = (p_operation->>'quoteExpiresAt')::timestamptz
    and created_at = (p_operation->>'createdAt')::timestamptz
    and (
      (status = 'SUBMITTING' and p_operation->>'status' in (
        'SUBMITTED', 'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'
      ))
      or (status = 'SUBMITTED' and p_operation->>'status' in (
        'SWAP_VERIFIED', 'RECONCILIATION_REQUIRED'
      ))
      or (status = 'SWAP_VERIFIED' and p_operation->>'status' = 'PAYING')
      or (status = 'PAYING' and p_operation->>'status' in (
        'COMPLETED', 'RECONCILIATION_REQUIRED'
      ))
    )
  returning * into v_operation;
  if v_operation.id is null then
    raise exception 'Arc liquidity transition conflicts with persisted state';
  end if;
  return to_jsonb(v_operation);
end;
$$;

revoke all on function public.get_arc_liquidity_operation(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_arc_liquidity_operation(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.transition_arc_liquidity_operation(uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.get_arc_liquidity_operation(uuid, uuid) to service_role;
grant execute on function public.claim_arc_liquidity_operation(uuid, jsonb) to service_role;
grant execute on function public.transition_arc_liquidity_operation(uuid, jsonb, text[])
  to service_role;

create table if not exists public.arc_erc8004_mutations (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  mutation_key text not null check (char_length(mutation_key) between 1 and 512),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('CLAIMED', 'COMPLETED')),
  output jsonb check (
    output is null
    or (
      jsonb_typeof(output) = 'object'
      and output - array[
        'status', 'operation', 'transactionId', 'transactionHash',
        'arcscanUrl', 'blockNumber', 'agentId', 'reconciliationRequired',
        'reconciliationMessage'
      ] = '{}'::jsonb
    )
  ),
  primary key (tenant_id, mutation_key),
  check (status <> 'CLAIMED' or output is null),
  check (status <> 'COMPLETED' or output is not null)
);

alter table public.arc_erc8004_mutations enable row level security;
revoke all on table public.arc_erc8004_mutations from public, anon, authenticated;
grant select, insert, update on table public.arc_erc8004_mutations to service_role;

create or replace function public.claim_arc_erc8004_mutation(
  p_tenant_id uuid,
  p_mutation_key text,
  p_fingerprint text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.arc_erc8004_mutations%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc ERC-8004 claim requires service_role' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arc-erc8004:' || p_tenant_id::text || ':' || p_mutation_key,
      0
    )
  );
  select * into v_record
  from public.arc_erc8004_mutations
  where tenant_id = p_tenant_id and mutation_key = p_mutation_key;
  if v_record.mutation_key is not null then
    if v_record.fingerprint <> p_fingerprint then
      raise exception 'Arc ERC-8004 replay conflicts with persisted input';
    end if;
    return jsonb_build_object('claimed', false, 'record', to_jsonb(v_record));
  end if;
  insert into public.arc_erc8004_mutations (
    tenant_id, mutation_key, fingerprint, status, output
  ) values (
    p_tenant_id, p_mutation_key, p_fingerprint, 'CLAIMED', null
  )
  returning * into v_record;
  return jsonb_build_object('claimed', true, 'record', to_jsonb(v_record));
end;
$$;

create or replace function public.complete_arc_erc8004_mutation(
  p_tenant_id uuid,
  p_mutation_key text,
  p_fingerprint text,
  p_output jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.arc_erc8004_mutations%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc ERC-8004 completion requires service_role' using errcode = '42501';
  end if;
  update public.arc_erc8004_mutations
  set status = 'COMPLETED', output = p_output
  where tenant_id = p_tenant_id
    and mutation_key = p_mutation_key
    and fingerprint = p_fingerprint
    and status = 'CLAIMED'
  returning * into v_record;
  if v_record.mutation_key is null then
    raise exception 'Arc ERC-8004 completion conflicts with persisted state';
  end if;
  return to_jsonb(v_record);
end;
$$;

revoke all on function public.claim_arc_erc8004_mutation(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_arc_erc8004_mutation(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_arc_erc8004_mutation(uuid, text, text)
  to service_role;
grant execute on function public.complete_arc_erc8004_mutation(uuid, text, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';

commit;
