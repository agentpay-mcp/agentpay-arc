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
    check (status in ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED')),
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
  check (status <> 'PENDING' or transaction_id is null),
  check (status <> 'COMPLETED' or (transaction_id is not null and transaction_hash is not null))
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
  check (status <> 'PENDING' or transaction_id is null),
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
create index if not exists arc_payment_batches_tenant_created_idx
  on public.arc_payment_batches (tenant_id, created_at desc);
create index if not exists arc_payment_batch_items_resume_idx
  on public.arc_payment_batch_items (tenant_id, batch_id, status, item_index);
create index if not exists arc_agent_activity_tenant_created_idx
  on public.arc_agent_activity (tenant_id, created_at desc);
create index if not exists arc_agent_activity_reference_idx
  on public.arc_agent_activity (tenant_id, reference_id, created_at desc);

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
revoke all on function public.reject_arc_activity_mutation() from public, anon, authenticated;

grant select, insert, update, delete on table public.arc_payment_requests to service_role;
grant select, insert, update, delete on table public.arc_payment_receipts to service_role;
grant select, insert, update, delete on table public.arc_payment_batches to service_role;
grant select, insert, update, delete on table public.arc_payment_batch_items to service_role;
grant select, insert, update, delete on table public.arc_agent_activity to service_role;
grant execute on function public.reject_arc_activity_mutation() to service_role;

notify pgrst, 'reload schema';

commit;
