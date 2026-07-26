begin;

create table if not exists public.arc_agent_commerce_receipts (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  idempotency_key uuid not null,
  buyer_agent_id text not null check (char_length(buyer_agent_id) between 1 and 256),
  seller_agent_id text not null check (char_length(seller_agent_id) between 1 and 256),
  service_url text not null check (service_url ~ '^https://'),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  quote_hash text not null check (quote_hash ~ '^0x[0-9a-f]{64}$'),
  inspected_amount_atomic text not null
    check (inspected_amount_atomic ~ '^[1-9][0-9]*$'),
  max_amount text not null
    check (max_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and max_amount::numeric > 0),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  payment_identifier text not null
    check (payment_identifier ~ '^[A-Za-z0-9_-]{16,128}$'),
  status text not null
    check (status in ('CLAIMED', 'SETTLED', 'RECONCILIATION_REQUIRED')),
  settlement_result jsonb
    check (settlement_result is null or jsonb_typeof(settlement_result) = 'object'),
  proof jsonb
    check (
      proof is null
      or (
        jsonb_typeof(proof) = 'object'
        and proof - array['network', 'scheme', 'seller', 'transaction', 'payer'] = '{}'::jsonb
      )
    ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, idempotency_key),
  unique (tenant_id, payment_identifier),
  check (updated_at >= created_at),
  check (status <> 'CLAIMED' or (settlement_result is null and proof is null)),
  check (status <> 'SETTLED' or (settlement_result is not null and proof is not null))
);

create index if not exists arc_agent_commerce_receipts_tenant_created_idx
  on public.arc_agent_commerce_receipts (tenant_id, created_at desc);

alter table public.arc_agent_commerce_receipts enable row level security;
revoke all on table public.arc_agent_commerce_receipts from public, anon, authenticated;
grant select, insert, update on table public.arc_agent_commerce_receipts to service_role;

create or replace function public.claim_arc_agent_commerce_receipt(
  p_tenant_id uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_receipt public.arc_agent_commerce_receipts%rowtype;
begin
  if current_user <> 'service_role' or p_tenant_id is null then
    raise exception 'Arc agent commerce claim requires service_role'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arc-agent-commerce:' || p_tenant_id::text || ':' || (p_receipt->>'idempotencyKey'),
      0
    )
  );

  select * into v_receipt
  from public.arc_agent_commerce_receipts
  where tenant_id = p_tenant_id
    and (
      idempotency_key = (p_receipt->>'idempotencyKey')::uuid
      or payment_identifier = p_receipt->>'paymentIdentifier'
    );

  if v_receipt.idempotency_key is not null then
    if v_receipt.idempotency_key::text <> p_receipt->>'idempotencyKey'
      or v_receipt.buyer_agent_id <> p_receipt->>'buyerAgentId'
      or v_receipt.seller_agent_id <> p_receipt->>'sellerAgentId'
      or v_receipt.service_url <> p_receipt->>'serviceUrl'
      or v_receipt.request_hash <> p_receipt->>'requestHash'
      or v_receipt.quote_hash <> p_receipt->>'quoteHash'
      or v_receipt.inspected_amount_atomic <> p_receipt->>'inspectedAmountAtomic'
      or v_receipt.max_amount <> p_receipt->>'maxAmount'
      or lower(v_receipt.wallet_address) <> lower(p_receipt->>'walletAddress')
      or v_receipt.payment_identifier <> p_receipt->>'paymentIdentifier'
    then
      raise exception 'Arc agent commerce replay conflicts with persisted input';
    end if;
    return jsonb_build_object('claimed', false, 'receipt', to_jsonb(v_receipt));
  end if;

  insert into public.arc_agent_commerce_receipts (
    tenant_id, idempotency_key, buyer_agent_id, seller_agent_id, service_url,
    request_hash, quote_hash, inspected_amount_atomic, max_amount, wallet_address,
    payment_identifier, status, settlement_result, proof, created_at, updated_at
  ) values (
    p_tenant_id,
    (p_receipt->>'idempotencyKey')::uuid,
    p_receipt->>'buyerAgentId',
    p_receipt->>'sellerAgentId',
    p_receipt->>'serviceUrl',
    p_receipt->>'requestHash',
    p_receipt->>'quoteHash',
    p_receipt->>'inspectedAmountAtomic',
    p_receipt->>'maxAmount',
    p_receipt->>'walletAddress',
    p_receipt->>'paymentIdentifier',
    'CLAIMED',
    null,
    null,
    (p_receipt->>'createdAt')::timestamptz,
    (p_receipt->>'updatedAt')::timestamptz
  )
  returning * into v_receipt;

  return jsonb_build_object('claimed', true, 'receipt', to_jsonb(v_receipt));
end;
$$;

create or replace function public.complete_arc_agent_commerce_receipt(
  p_tenant_id uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_receipt public.arc_agent_commerce_receipts%rowtype;
begin
  if current_user <> 'service_role' or p_tenant_id is null then
    raise exception 'Arc agent commerce completion requires service_role'
      using errcode = '42501';
  end if;

  update public.arc_agent_commerce_receipts
  set
    status = p_receipt->>'status',
    settlement_result = p_receipt->'settlementResult',
    proof = p_receipt->'proof',
    updated_at = (p_receipt->>'updatedAt')::timestamptz
  where tenant_id = p_tenant_id
    and idempotency_key = (p_receipt->>'idempotencyKey')::uuid
    and status = 'CLAIMED'
    and p_receipt->>'status' in ('SETTLED', 'RECONCILIATION_REQUIRED')
  returning * into v_receipt;

  if v_receipt.idempotency_key is null then
    raise exception 'Arc agent commerce completion conflicts with persisted state';
  end if;
  return to_jsonb(v_receipt);
end;
$$;

revoke all on function public.claim_arc_agent_commerce_receipt(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_arc_agent_commerce_receipt(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_arc_agent_commerce_receipt(uuid, jsonb)
  to service_role;
grant execute on function public.complete_arc_agent_commerce_receipt(uuid, jsonb)
  to service_role;

create table if not exists public.arc_gateway_seller_settlements (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  payment_identifier text not null check (payment_identifier ~ '^[A-Za-z0-9_-]{16,128}$'),
  buyer_agent_id text not null check (char_length(buyer_agent_id) between 1 and 256),
  seller_agent_id text not null check (char_length(seller_agent_id) between 1 and 256),
  service_url text not null check (service_url ~ '^https://'),
  amount_atomic text not null check (amount_atomic ~ '^[1-9][0-9]*$'),
  max_amount text not null,
  network text not null check (network = 'eip155:5042002'),
  asset text not null check (lower(asset) = '0x3600000000000000000000000000000000000000'),
  status text not null check (status in ('CLAIMED', 'SETTLED')),
  settlement_result jsonb,
  proof jsonb check (
    proof is null
    or proof - array['network', 'scheme', 'seller', 'transaction', 'payer'] = '{}'::jsonb
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, payment_identifier),
  check (status <> 'CLAIMED' or (settlement_result is null and proof is null)),
  check (status <> 'SETTLED' or (settlement_result is not null and proof is not null))
);

alter table public.arc_gateway_seller_settlements enable row level security;
revoke all on table public.arc_gateway_seller_settlements from public, anon, authenticated;
grant select, insert, update on table public.arc_gateway_seller_settlements to service_role;

create or replace function public.claim_arc_gateway_seller_settlement(
  p_tenant_id uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.arc_gateway_seller_settlements%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc Gateway seller claim requires service_role' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arc-gateway-seller:' || p_tenant_id::text || ':' || (p_record->>'paymentIdentifier'),
      0
    )
  );
  select * into v_record
  from public.arc_gateway_seller_settlements
  where tenant_id = p_tenant_id
    and payment_identifier = p_record->>'paymentIdentifier';
  if v_record.payment_identifier is not null then
    if v_record.buyer_agent_id <> p_record->>'buyerAgentId'
      or v_record.seller_agent_id <> p_record->>'sellerAgentId'
      or v_record.service_url <> p_record->>'serviceUrl'
      or v_record.amount_atomic <> p_record->>'amountAtomic'
      or v_record.max_amount <> p_record->>'maxAmount'
      or v_record.network <> p_record->>'network'
      or lower(v_record.asset) <> lower(p_record->>'asset')
    then
      raise exception 'Arc Gateway seller replay conflicts with persisted input';
    end if;
    return jsonb_build_object('claimed', false, 'record', to_jsonb(v_record));
  end if;
  insert into public.arc_gateway_seller_settlements (
    tenant_id, payment_identifier, buyer_agent_id, seller_agent_id, service_url,
    amount_atomic, max_amount, network, asset, status, created_at, updated_at
  ) values (
    p_tenant_id, p_record->>'paymentIdentifier', p_record->>'buyerAgentId',
    p_record->>'sellerAgentId', p_record->>'serviceUrl', p_record->>'amountAtomic',
    p_record->>'maxAmount', p_record->>'network', p_record->>'asset', 'CLAIMED',
    (p_record->>'createdAt')::timestamptz, (p_record->>'updatedAt')::timestamptz
  ) returning * into v_record;
  return jsonb_build_object('claimed', true, 'record', to_jsonb(v_record));
end;
$$;

create or replace function public.complete_arc_gateway_seller_settlement(
  p_tenant_id uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.arc_gateway_seller_settlements%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc Gateway seller completion requires service_role' using errcode = '42501';
  end if;
  update public.arc_gateway_seller_settlements
  set status = 'SETTLED',
      settlement_result = p_record->'settlementResult',
      proof = p_record->'proof',
      updated_at = (p_record->>'updatedAt')::timestamptz
  where tenant_id = p_tenant_id
    and payment_identifier = p_record->>'paymentIdentifier'
    and status = 'CLAIMED'
  returning * into v_record;
  if v_record.payment_identifier is null then
    raise exception 'Arc Gateway seller completion conflicts with persisted state';
  end if;
  return to_jsonb(v_record);
end;
$$;

revoke all on function public.claim_arc_gateway_seller_settlement(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_arc_gateway_seller_settlement(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_arc_gateway_seller_settlement(uuid, jsonb)
  to service_role;
grant execute on function public.complete_arc_gateway_seller_settlement(uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
