begin;

create table if not exists public.arc_compliance_evidence (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  evidence_key text not null check (char_length(evidence_key) between 1 and 256),
  operation_id uuid not null,
  address text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  direction text not null check (direction in ('SEND', 'RECEIVE')),
  channel text not null check (
    channel in ('AGENT_WALLET_TRANSFER', 'AGENT_WALLET_PAID_SERVICE')
  ),
  evidence_type text not null check (
    evidence_type in ('CIRCLE_AGENT_WALLET_BUILT_IN', 'CIRCLE_COMPLIANCE_ENGINE')
  ),
  status text not null check (
    status in (
      'DECLARED_RUNTIME_CONTROL', 'DISABLED', 'SCREENED',
      'UNAVAILABLE', 'UNSUPPORTED_CHAIN'
    )
  ),
  decision text check (
    decision is null or decision in ('APPROVED', 'DENIED', 'REVIEW', 'UNAVAILABLE')
  ),
  reference_id text check (
    reference_id is null
    or (
      char_length(reference_id) between 1 and 128
      and reference_id ~ '^[A-Za-z0-9_:.~-]+$'
    )
  ),
  created_at timestamptz not null,
  primary key (tenant_id, evidence_key),
  check (
    (
      evidence_type = 'CIRCLE_AGENT_WALLET_BUILT_IN'
      and status = 'DECLARED_RUNTIME_CONTROL'
      and decision is null
      and reference_id is null
    )
    or (
      evidence_type = 'CIRCLE_COMPLIANCE_ENGINE'
      and status <> 'DECLARED_RUNTIME_CONTROL'
      and decision is not null
    )
  ),
  check (reference_id is null or status = 'SCREENED')
);

create index if not exists arc_compliance_evidence_operation_idx
  on public.arc_compliance_evidence (tenant_id, operation_id, created_at);

alter table public.arc_compliance_evidence enable row level security;
revoke all on table public.arc_compliance_evidence from public, anon, authenticated;
grant select, insert on table public.arc_compliance_evidence to service_role;

create or replace function public.list_arc_compliance_evidence(
  p_tenant_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_evidence jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'Compliance evidence read requires service_role' using errcode = '42501';
  end if;
  select coalesce(
    jsonb_agg(
      to_jsonb(evidence)
      order by
        case evidence.evidence_type
          when 'CIRCLE_AGENT_WALLET_BUILT_IN' then 0
          else 1
        end,
        evidence.created_at
    ),
    '[]'::jsonb
  )
  into v_evidence
  from public.arc_compliance_evidence as evidence
  where evidence.tenant_id = p_tenant_id
    and evidence.operation_id = p_operation_id;
  return v_evidence;
end;
$$;

create or replace function public.record_arc_compliance_evidence(
  p_tenant_id uuid,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_evidence public.arc_compliance_evidence%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Compliance evidence write requires service_role' using errcode = '42501';
  end if;
  if p_evidence - array[
    'evidenceKey', 'operationId', 'address', 'direction', 'channel',
    'evidenceType', 'status', 'decision', 'referenceId', 'createdAt'
  ] <> '{}'::jsonb then
    raise exception 'Compliance evidence contains unsupported fields';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arc-compliance:' || p_tenant_id::text || ':' || (p_evidence->>'evidenceKey'),
      0
    )
  );
  select * into v_evidence
  from public.arc_compliance_evidence
  where tenant_id = p_tenant_id
    and evidence_key = p_evidence->>'evidenceKey';

  if v_evidence.evidence_key is not null then
    if v_evidence.operation_id <> (p_evidence->>'operationId')::uuid
      or lower(v_evidence.address) <> lower(p_evidence->>'address')
      or v_evidence.direction <> p_evidence->>'direction'
      or v_evidence.channel <> p_evidence->>'channel'
      or v_evidence.evidence_type <> p_evidence->>'evidenceType'
      or v_evidence.status <> p_evidence->>'status'
      or v_evidence.decision is distinct from nullif(p_evidence->>'decision', '')
      or v_evidence.reference_id is distinct from nullif(p_evidence->>'referenceId', '')
    then
      raise exception 'Compliance evidence replay conflicts with persisted input';
    end if;
    return to_jsonb(v_evidence);
  end if;

  insert into public.arc_compliance_evidence (
    tenant_id, evidence_key, operation_id, address, direction, channel,
    evidence_type, status, decision, reference_id, created_at
  ) values (
    p_tenant_id,
    p_evidence->>'evidenceKey',
    (p_evidence->>'operationId')::uuid,
    p_evidence->>'address',
    p_evidence->>'direction',
    p_evidence->>'channel',
    p_evidence->>'evidenceType',
    p_evidence->>'status',
    nullif(p_evidence->>'decision', ''),
    nullif(p_evidence->>'referenceId', ''),
    (p_evidence->>'createdAt')::timestamptz
  )
  returning * into v_evidence;
  return to_jsonb(v_evidence);
end;
$$;

revoke all on function public.list_arc_compliance_evidence(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_arc_compliance_evidence(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.list_arc_compliance_evidence(uuid, uuid) to service_role;
grant execute on function public.record_arc_compliance_evidence(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
