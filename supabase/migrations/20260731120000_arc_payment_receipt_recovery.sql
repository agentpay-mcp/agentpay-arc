begin;

create or replace function public.transition_arc_payment_receipt(
  p_tenant_id uuid,
  p_receipt_id uuid,
  p_expected_status text,
  p_status text,
  p_transaction_id text,
  p_transaction_hash text,
  p_error_message text,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_receipt public.arc_payment_receipts%rowtype;
  v_transition_allowed boolean;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc payment receipt transition requires service_role'
      using errcode = '42501';
  end if;

  if p_tenant_id is null
    or p_receipt_id is null
    or p_receipt_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_expected_status is null
    or p_expected_status not in ('SUBMITTING', 'SUBMITTED', 'RECONCILIATION_REQUIRED')
    or p_status is null
    or p_status not in (
      'SUBMITTED',
      'COMPLETED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )
    or p_updated_at is null
    or (
      p_transaction_hash is not null
      and p_transaction_hash !~ '^0x[0-9a-fA-F]{64}$'
    )
  then
    raise exception 'Invalid Arc payment receipt transition';
  end if;

  select *
  into v_receipt
  from public.arc_payment_receipts
  where tenant_id = p_tenant_id
    and id = p_receipt_id
  for update;

  if v_receipt.id is null or v_receipt.status <> p_expected_status then
    raise exception 'Arc payment receipt transition conflicts with persisted state';
  end if;

  v_transition_allowed :=
    (
      p_expected_status = 'SUBMITTING'
      and p_status in ('SUBMITTED', 'FAILED', 'RECONCILIATION_REQUIRED')
    )
    or (
      p_expected_status = 'SUBMITTED'
      and p_status in ('COMPLETED', 'RECONCILIATION_REQUIRED')
    )
    or (
      p_expected_status = 'RECONCILIATION_REQUIRED'
      and p_status = 'COMPLETED'
    );

  if not v_transition_allowed
    or p_updated_at < v_receipt.updated_at
    or (
      p_status = 'SUBMITTED'
      and p_transaction_id is null
    )
    or (
      p_status = 'COMPLETED'
      and (p_transaction_id is null or p_transaction_hash is null)
    )
    or (
      p_status = 'FAILED'
      and (p_transaction_id is not null or p_transaction_hash is not null)
    )
  then
    raise exception 'Arc payment receipt transition violates its state machine';
  end if;

  update public.arc_payment_receipts
  set
    status = p_status,
    transaction_id = p_transaction_id,
    transaction_hash = p_transaction_hash,
    error_message = p_error_message,
    updated_at = p_updated_at
  where tenant_id = p_tenant_id
    and id = p_receipt_id
  returning * into v_receipt;

  insert into public.arc_agent_activity (
    tenant_id,
    id,
    activity_type,
    status,
    reference_id,
    metadata,
    created_at
  )
  values (
    p_tenant_id,
    'payment_transition:'
      || p_receipt_id::text
      || ':'
      || lower(p_status)
      || ':'
      || extract(epoch from p_updated_at)::text,
    'PAYMENT',
    p_status,
    p_receipt_id::text,
    jsonb_build_object(
      'event', 'PAYMENT_TRANSITIONED',
      'previousStatus', p_expected_status,
      'transactionId', p_transaction_id,
      'transactionHash', p_transaction_hash,
      'errorMessage', p_error_message
    ),
    p_updated_at
  );

  return to_jsonb(v_receipt);
end;
$$;

revoke all on function public.transition_arc_payment_receipt(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.transition_arc_payment_receipt(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
