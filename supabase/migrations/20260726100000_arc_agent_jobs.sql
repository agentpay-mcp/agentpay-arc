begin;

-- ERC-8183 Agentic Commerce job escrow on Arc Testnet.
--
-- Budgets are stored as exact six-decimal atomic units (numeric(78,0)), never
-- as floating point and never as Arc's native 18-decimal gas view. Arc USDC
-- exposes both views over one balance; only the ERC-20 view settles here.

create table if not exists public.arc_agent_jobs (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  job_id numeric(78, 0) not null check (job_id >= 0),
  contract_address text not null check (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id integer not null check (chain_id = 5042002),
  client_address text not null check (client_address ~ '^0x[0-9a-fA-F]{40}$'),
  provider_address text not null check (provider_address ~ '^0x[0-9a-fA-F]{40}$'),
  evaluator_address text not null check (evaluator_address ~ '^0x[0-9a-fA-F]{40}$'),
  -- Needed by the Task 9 marketplace read model, which cannot re-read the chain.
  description text not null check (length(description) between 1 and 2048),
  hook_address text not null default '0x0000000000000000000000000000000000000000'
    check (hook_address ~ '^0x[0-9a-fA-F]{40}$'),
  budget_atomic numeric(78, 0) not null default 0 check (budget_atomic >= 0),
  expired_at timestamptz not null,
  state text not null check (
    state in ('Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired')
  ),
  deliverable_hash text check (deliverable_hash ~ '^0x[0-9a-f]{64}$'),
  reason_hash text check (reason_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, job_id),
  check (updated_at >= created_at),
  -- The evaluator is mandatory at creation and can never be the zero address.
  check (evaluator_address <> '0x0000000000000000000000000000000000000000'),
  -- A provider is required at creation: this tool surface exposes no
  -- setProvider, so a job without one could never be funded.
  check (provider_address <> '0x0000000000000000000000000000000000000000'),
  -- Escrow past Open must carry a budget.
  check (state = 'Open' or budget_atomic > 0),
  -- A deliverable only exists once the provider has submitted.
  check (deliverable_hash is null or state in ('Submitted', 'Completed', 'Rejected')),
  -- A reason hash only exists on a settled outcome.
  check (reason_hash is null or state in ('Completed', 'Rejected'))
);

create index if not exists arc_agent_jobs_tenant_state_idx
  on public.arc_agent_jobs (tenant_id, state, updated_at desc);

create index if not exists arc_agent_jobs_client_idx
  on public.arc_agent_jobs (tenant_id, client_address, updated_at desc);

create index if not exists arc_agent_jobs_provider_idx
  on public.arc_agent_jobs (tenant_id, provider_address, updated_at desc);

create index if not exists arc_agent_jobs_evaluator_idx
  on public.arc_agent_jobs (tenant_id, evaluator_address, updated_at desc);

create index if not exists arc_agent_jobs_expiry_idx
  on public.arc_agent_jobs (tenant_id, expired_at)
  where state in ('Open', 'Funded', 'Submitted');

-- Append-only lifecycle audit. Rows are never updated or deleted, so a
-- reconciliation-required write stays visible next to whatever followed it.
create table if not exists public.arc_agent_job_events (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  id uuid not null,
  job_id numeric(78, 0) not null check (job_id >= 0),
  action text not null check (
    action in ('CREATE', 'SET_BUDGET', 'FUND', 'SUBMIT', 'COMPLETE', 'REJECT')
  ),
  from_state text check (
    from_state in ('Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired')
  ),
  to_state text check (
    to_state in ('Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired')
  ),
  actor_address text not null check (actor_address ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null check (status in ('SUBMITTED', 'RECONCILIATION_REQUIRED')),
  deliverable_hash text check (deliverable_hash ~ '^0x[0-9a-f]{64}$'),
  reason_hash text check (reason_hash ~ '^0x[0-9a-f]{64}$'),
  circle_transaction_id text check (length(circle_transaction_id) between 1 and 256),
  transaction_hash text check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(78, 0) check (block_number >= 0),
  explorer_url text check (explorer_url ~ '^https://testnet\.arcscan\.app/tx/0x[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (tenant_id, id),
  -- An ambiguous outcome must never claim a resulting state or a proof.
  check (
    status <> 'RECONCILIATION_REQUIRED'
    or (to_state is null and transaction_hash is null and block_number is null)
  ),
  -- A proven write carries its explorer URL alongside the hash, or neither.
  check ((transaction_hash is null) = (explorer_url is null))
);

create index if not exists arc_agent_job_events_job_idx
  on public.arc_agent_job_events (tenant_id, job_id, created_at desc);

create index if not exists arc_agent_job_events_recent_idx
  on public.arc_agent_job_events (tenant_id, created_at desc);

create index if not exists arc_agent_job_events_reconciliation_idx
  on public.arc_agent_job_events (tenant_id, created_at desc)
  where status = 'RECONCILIATION_REQUIRED';

alter table public.arc_agent_jobs enable row level security;
alter table public.arc_agent_job_events enable row level security;

revoke all on table public.arc_agent_jobs from public, anon, authenticated;
revoke all on table public.arc_agent_job_events from public, anon, authenticated;

grant select, insert, update on table public.arc_agent_jobs to service_role;
-- No update or delete: the lifecycle log is append-only.
grant select, insert on table public.arc_agent_job_events to service_role;

commit;
