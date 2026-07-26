-- Tenant-scoped Arc Agent Wallet requests, receipts, resumable batches, and audit activity.
begin;

create table if not exists public.arc_payment_requests (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id uuid not null,
  idempotency_key uuid not null,
  recipient text not null check (recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount text not null
    check (amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and amount::numeric > 0),
  token text not null default 'USDC' check (token = 'USDC'),
  chain text not null default 'ARC-TESTNET' check (chain = 'ARC-TESTNET'),
  purpose text not null check (char_length(purpose) between 1 and 512),
  status text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'EXPIRED')),
  expires_at timestamptz not null,
  receipt_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key),
  check (expires_at > created_at),
  check ((status = 'PAID') = (receipt_id is not null))
);

create table if not exists public.arc_payment_receipts (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id uuid not null,
  idempotency_key uuid not null,
  payment_request_id uuid,
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  recipient text not null check (recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount text not null
    check (amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and amount::numeric > 0),
  token text not null default 'USDC' check (token = 'USDC'),
  chain text not null default 'ARC-TESTNET' check (chain = 'ARC-TESTNET'),
  purpose text not null check (char_length(purpose) between 1 and 512),
  status text not null default 'PENDING'
    check (status in (
      'PENDING',
      'SUBMITTING',
      'SUBMITTED',
      'COMPLETED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )),
  transaction_id text,
  transaction_hash text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, payment_request_id)
    references public.arc_payment_requests (tenant_id, id)
    on delete restrict,
  check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  check (
    status not in ('PENDING', 'SUBMITTING')
    or (transaction_id is null and transaction_hash is null)
  ),
  check (status <> 'SUBMITTED' or transaction_id is not null),
  check (status <> 'COMPLETED' or (transaction_id is not null and transaction_hash is not null)),
  check (status <> 'FAILED' or (transaction_id is null and transaction_hash is null))
);

alter table public.arc_payment_requests
  add constraint arc_payment_requests_receipt_fkey
  foreign key (tenant_id, receipt_id)
  references public.arc_payment_receipts (tenant_id, id)
  on delete restrict;

create table if not exists public.arc_payment_batches (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  batch_id uuid not null,
  idempotency_key uuid not null,
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  token text not null default 'USDC' check (token = 'USDC'),
  chain text not null default 'ARC-TESTNET' check (chain = 'ARC-TESTNET'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SUBMITTED', 'PARTIAL', 'COMPLETED', 'FAILED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, batch_id),
  unique (tenant_id, idempotency_key)
);

create table if not exists public.arc_payment_batch_items (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id text not null,
  batch_id uuid not null,
  item_index integer not null check (item_index >= 0),
  recipient text not null check (recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount text not null
    check (amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and amount::numeric > 0),
  purpose text check (purpose is null or char_length(purpose) between 1 and 512),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED')),
  transaction_id text,
  transaction_hash text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, batch_id, item_index),
  foreign key (tenant_id, batch_id)
    references public.arc_payment_batches (tenant_id, batch_id)
    on delete restrict,
  check (id = batch_id::text || ':' || item_index::text),
  check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  check (status <> 'PENDING' or (transaction_id is null and transaction_hash is null)),
  check (status <> 'COMPLETED' or (transaction_id is not null and transaction_hash is not null))
);

create unique index if not exists arc_payment_batch_items_recipient_idx
  on public.arc_payment_batch_items (tenant_id, batch_id, lower(recipient));

create table if not exists public.arc_agent_activity (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id text not null,
  activity_type text not null
    check (activity_type in ('PAYMENT', 'BATCH_PAYOUT', 'PAYMENT_REQUEST')),
  status text not null check (char_length(status) between 1 and 32),
  reference_id text not null check (char_length(reference_id) between 1 and 256),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists arc_payment_requests_tenant_status_expires_idx
  on public.arc_payment_requests (tenant_id, status, expires_at);
create index if not exists arc_payment_receipts_tenant_created_idx
  on public.arc_payment_receipts (tenant_id, created_at desc);
create index if not exists arc_payment_receipts_tenant_transaction_idx
  on public.arc_payment_receipts (tenant_id, transaction_id)
  where transaction_id is not null;
create unique index if not exists arc_payment_receipts_request_idx
  on public.arc_payment_receipts (tenant_id, payment_request_id)
  where payment_request_id is not null;
create index if not exists arc_payment_batches_tenant_created_idx
  on public.arc_payment_batches (tenant_id, created_at desc);
create index if not exists arc_payment_batch_items_resume_idx
  on public.arc_payment_batch_items (tenant_id, batch_id, status, item_index);
create index if not exists arc_agent_activity_tenant_created_idx
  on public.arc_agent_activity (tenant_id, created_at desc);
create index if not exists arc_agent_activity_reference_idx
  on public.arc_agent_activity (tenant_id, reference_id, created_at desc);

create or replace function public.claim_arc_payment_receipt(
  p_tenant_id uuid,
  p_receipt_id uuid,
  p_idempotency_key uuid,
  p_payment_request_id uuid,
  p_wallet_address text,
  p_recipient text,
  p_amount text,
  p_token text,
  p_chain text,
  p_purpose text,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_by_id public.arc_payment_receipts%rowtype;
  v_by_key public.arc_payment_receipts%rowtype;
  v_by_request public.arc_payment_receipts%rowtype;
  v_request public.arc_payment_requests%rowtype;
  v_inserted integer;
  v_receipt jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc payment receipt claim requires service_role'
      using errcode = '42501';
  end if;

  if p_tenant_id is null
    or p_receipt_id is null
    or p_receipt_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_idempotency_key is null
    or p_idempotency_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_wallet_address is null
    or p_wallet_address !~ '^0x[0-9a-fA-F]{40}$'
    or p_recipient is null
    or p_recipient !~ '^0x[0-9a-fA-F]{40}$'
    or not (
      case
        when p_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'
        then p_amount::numeric > 0
        else false
      end
    )
    or p_token is distinct from 'USDC'
    or p_chain is distinct from 'ARC-TESTNET'
    or p_purpose is null
    or char_length(p_purpose) not between 1 and 512
    or p_created_at is null
    or p_updated_at is distinct from p_created_at
  then
    raise exception 'Invalid Arc payment receipt claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('arc-payment-receipt:' || p_tenant_id::text, 0)
  );

  select *
  into v_by_id
  from public.arc_payment_receipts
  where tenant_id = p_tenant_id
    and id = p_receipt_id;

  select *
  into v_by_key
  from public.arc_payment_receipts
  where tenant_id = p_tenant_id
    and idempotency_key = p_idempotency_key;

  if p_payment_request_id is not null then
    select *
    into v_by_request
    from public.arc_payment_receipts
    where tenant_id = p_tenant_id
      and payment_request_id = p_payment_request_id;
  end if;

  if v_by_id.id is not null
    or v_by_key.id is not null
    or (p_payment_request_id is not null and v_by_request.id is not null)
  then
    if v_by_id.id is null
      or v_by_key.id is null
      or v_by_id.id <> v_by_key.id
      or (
        p_payment_request_id is not null
        and (
          v_by_request.id is null
          or v_by_request.id <> v_by_id.id
        )
      )
      or v_by_id.payment_request_id is distinct from p_payment_request_id
      or lower(v_by_id.wallet_address) <> lower(p_wallet_address)
      or lower(v_by_id.recipient) <> lower(p_recipient)
      or v_by_id.amount <> p_amount
      or v_by_id.token <> p_token
      or v_by_id.chain <> p_chain
      or v_by_id.purpose <> p_purpose
    then
      raise exception 'Arc payment receipt replay conflicts with persisted input';
    end if;

    return jsonb_build_object(
      'claimed',
      false,
      'receipt',
      to_jsonb(v_by_id)
    );
  end if;

  if p_payment_request_id is not null then
    select *
    into v_request
    from public.arc_payment_requests
    where tenant_id = p_tenant_id
      and id = p_payment_request_id
    for update;

    if v_request.id is null
      or v_request.status <> 'OPEN'
      or v_request.expires_at <= pg_catalog.now()
      or lower(v_request.recipient) <> lower(p_recipient)
      or v_request.amount <> p_amount
      or v_request.token <> p_token
      or v_request.chain <> p_chain
      or v_request.purpose <> p_purpose
    then
      raise exception 'Arc payment request is not claimable with these receipt fields';
    end if;
  end if;

  insert into public.arc_payment_receipts (
    tenant_id,
    id,
    idempotency_key,
    payment_request_id,
    wallet_address,
    recipient,
    amount,
    token,
    chain,
    purpose,
    status,
    transaction_id,
    transaction_hash,
    error_message,
    created_at,
    updated_at
  )
  values (
    p_tenant_id,
    p_receipt_id,
    p_idempotency_key,
    p_payment_request_id,
    p_wallet_address,
    p_recipient,
    p_amount,
    p_token,
    p_chain,
    p_purpose,
    'SUBMITTING',
    null,
    null,
    null,
    p_created_at,
    p_updated_at
  )
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted <> 1 then
    raise exception 'Arc payment receipt replay conflicts with persisted input';
  end if;

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
    'payment_claimed:' || p_receipt_id::text,
    'PAYMENT',
    'SUBMITTING',
    p_receipt_id::text,
    jsonb_build_object(
      'event', 'PAYMENT_CLAIMED',
      'walletAddress', p_wallet_address,
      'recipient', p_recipient,
      'amount', p_amount,
      'paymentRequestId', p_payment_request_id
    ),
    p_created_at
  );

  select to_jsonb(receipt_row)
  into v_receipt
  from public.arc_payment_receipts as receipt_row
  where receipt_row.tenant_id = p_tenant_id
    and receipt_row.id = p_receipt_id;

  return jsonb_build_object(
    'claimed',
    true,
    'receipt',
    v_receipt
  );
end;
$$;

create or replace function public.create_arc_payment_batch(
  p_tenant_id uuid,
  p_batch_id uuid,
  p_idempotency_key uuid,
  p_wallet_address text,
  p_token text,
  p_chain text,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_by_batch public.arc_payment_batches%rowtype;
  v_by_key public.arc_payment_batches%rowtype;
  v_inserted integer;
  v_disposition text;
  v_item_count integer;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc payment batch creation requires service_role'
      using errcode = '42501';
  end if;

  if p_tenant_id is null
    or p_batch_id is null
    or p_batch_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_idempotency_key is null
    or p_idempotency_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_wallet_address is null
    or p_wallet_address !~ '^0x[0-9a-fA-F]{40}$'
    or p_token is distinct from 'USDC'
    or p_chain is distinct from 'ARC-TESTNET'
    or p_created_at is null
    or p_updated_at is distinct from p_created_at
  then
    raise exception 'Invalid Arc payment batch header';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) not between 1 and 100
  then
    raise exception 'Arc payment batch must contain between 1 and 100 items';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as incoming(item)
    where jsonb_typeof(incoming.item) <> 'object'
      or jsonb_typeof(incoming.item -> 'recipient') is distinct from 'string'
      or jsonb_typeof(incoming.item -> 'amount') is distinct from 'string'
      or (
        incoming.item ? 'purpose'
        and jsonb_typeof(incoming.item -> 'purpose') not in ('string', 'null')
      )
      or exists (
        select 1
        from jsonb_object_keys(incoming.item) as item_key(key)
        where not (item_key.key = any (array['recipient', 'amount', 'purpose']))
      )
      or incoming.item ->> 'recipient' !~ '^0x[0-9a-fA-F]{40}$'
      or not (
        case
          when incoming.item ->> 'amount'
            ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'
          then (incoming.item ->> 'amount')::numeric > 0
          else false
        end
      )
      or (
        incoming.item ->> 'purpose' is not null
        and char_length(incoming.item ->> 'purpose') not between 1 and 512
      )
  ) then
    raise exception 'Invalid Arc payment batch item';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as incoming(item)
    group by lower(incoming.item ->> 'recipient')
    having count(*) > 1
  ) then
    raise exception 'Arc payment batch recipients must be unique';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('arc-payment-batch:' || p_tenant_id::text, 0)
  );

  insert into public.arc_payment_batches (
    tenant_id,
    batch_id,
    idempotency_key,
    wallet_address,
    token,
    chain,
    status,
    created_at,
    updated_at
  )
  values (
    p_tenant_id,
    p_batch_id,
    p_idempotency_key,
    p_wallet_address,
    p_token,
    p_chain,
    'PENDING',
    p_created_at,
    p_updated_at
  )
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    insert into public.arc_payment_batch_items (
      tenant_id,
      id,
      batch_id,
      item_index,
      recipient,
      amount,
      purpose,
      status,
      transaction_id,
      transaction_hash,
      error_message,
      created_at,
      updated_at
    )
    select
      p_tenant_id,
      p_batch_id::text || ':' || (incoming.ordinality - 1)::text,
      p_batch_id,
      (incoming.ordinality - 1)::integer,
      incoming.item ->> 'recipient',
      incoming.item ->> 'amount',
      incoming.item ->> 'purpose',
      'PENDING',
      null,
      null,
      null,
      p_created_at,
      p_updated_at
    from jsonb_array_elements(p_items) with ordinality as incoming(item, ordinality);
    v_disposition := 'CREATED';
  else
    select *
    into v_by_batch
    from public.arc_payment_batches
    where tenant_id = p_tenant_id
      and batch_id = p_batch_id;

    select *
    into v_by_key
    from public.arc_payment_batches
    where tenant_id = p_tenant_id
      and idempotency_key = p_idempotency_key;

    if v_by_batch.batch_id is null
      or v_by_key.batch_id is null
      or v_by_batch.batch_id <> v_by_key.batch_id
      or lower(v_by_batch.wallet_address) <> lower(p_wallet_address)
      or v_by_batch.token <> p_token
      or v_by_batch.chain <> p_chain
    then
      raise exception 'Arc payment batch replay conflicts with persisted input';
    end if;

    select count(*)
    into v_item_count
    from public.arc_payment_batch_items
    where tenant_id = p_tenant_id
      and batch_id = p_batch_id;

    if v_item_count <> jsonb_array_length(p_items)
      or exists (
        select 1
        from jsonb_array_elements(p_items) with ordinality as incoming(item, ordinality)
        left join public.arc_payment_batch_items as persisted
          on persisted.tenant_id = p_tenant_id
          and persisted.batch_id = p_batch_id
          and persisted.item_index = (incoming.ordinality - 1)::integer
        where persisted.id is null
          or persisted.id <> p_batch_id::text || ':' || (incoming.ordinality - 1)::text
          or lower(persisted.recipient) <> lower(incoming.item ->> 'recipient')
          or persisted.amount <> incoming.item ->> 'amount'
          or persisted.purpose is distinct from incoming.item ->> 'purpose'
      )
    then
      raise exception 'Arc payment batch replay conflicts with persisted input';
    end if;
    v_disposition := 'REPLAY';
  end if;

  return jsonb_build_object(
    'disposition',
    v_disposition,
    'batch',
    (
      select to_jsonb(batch_row)
      from public.arc_payment_batches as batch_row
      where batch_row.tenant_id = p_tenant_id
        and batch_row.batch_id = p_batch_id
    ),
    'items',
    (
      select coalesce(
        jsonb_agg(to_jsonb(item_row) order by item_row.item_index),
        '[]'::jsonb
      )
      from public.arc_payment_batch_items as item_row
      where item_row.tenant_id = p_tenant_id
        and item_row.batch_id = p_batch_id
    )
  );
end;
$$;

create or replace function public.claim_arc_payment_batch_item(
  p_tenant_id uuid,
  p_batch_id uuid,
  p_item_id text,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_claimed jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'Arc payment batch item claim requires service_role'
      using errcode = '42501';
  end if;

  if p_tenant_id is null
    or p_batch_id is null
    or p_batch_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_item_id is null
    or p_item_id !~ ('^' || p_batch_id::text || ':[0-9]+$')
    or p_updated_at is null
  then
    raise exception 'Invalid Arc payment batch item claim';
  end if;

  update public.arc_payment_batch_items
  set
    status = 'SUBMITTED',
    updated_at = p_updated_at
  where tenant_id = p_tenant_id
    and batch_id = p_batch_id
    and id = p_item_id
    and status = 'PENDING'
    and transaction_id is null
    and transaction_hash is null
  returning to_jsonb(arc_payment_batch_items.*)
  into v_claimed;

  if v_claimed is null then
    return null;
  end if;

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
    'batch_item_claimed:' || p_item_id,
    'BATCH_PAYOUT',
    'SUBMITTED',
    p_item_id,
    jsonb_build_object(
      'event', 'BATCH_ITEM_CLAIMED',
      'batchId', p_batch_id,
      'itemId', p_item_id
    ),
    p_updated_at
  );

  return v_claimed;
end;
$$;

create or replace function public.reject_arc_activity_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Arc Agent activity is append-only';
end;
$$;

drop trigger if exists arc_agent_activity_append_only on public.arc_agent_activity;
create trigger arc_agent_activity_append_only
before update or delete on public.arc_agent_activity
for each row execute function public.reject_arc_activity_mutation();

alter table public.arc_payment_requests enable row level security;
alter table public.arc_payment_receipts enable row level security;
alter table public.arc_payment_batches enable row level security;
alter table public.arc_payment_batch_items enable row level security;
alter table public.arc_agent_activity enable row level security;

revoke all on table public.arc_payment_requests from public, anon, authenticated;
revoke all on table public.arc_payment_receipts from public, anon, authenticated;
revoke all on table public.arc_payment_batches from public, anon, authenticated;
revoke all on table public.arc_payment_batch_items from public, anon, authenticated;
revoke all on table public.arc_agent_activity from public, anon, authenticated;
revoke all on function public.claim_arc_payment_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.create_arc_payment_batch(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.claim_arc_payment_batch_item(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reject_arc_activity_mutation() from public, anon, authenticated;

grant select, insert, update, delete on table public.arc_payment_requests to service_role;
grant select, insert, update, delete on table public.arc_payment_receipts to service_role;
grant select, insert, update, delete on table public.arc_payment_batches to service_role;
grant select, insert, update, delete on table public.arc_payment_batch_items to service_role;
grant select, insert, update, delete on table public.arc_agent_activity to service_role;
grant execute on function public.claim_arc_payment_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.create_arc_payment_batch(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.claim_arc_payment_batch_item(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.reject_arc_activity_mutation() to service_role;

notify pgrst, 'reload schema';

commit;
