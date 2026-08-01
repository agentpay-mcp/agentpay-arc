-- Per-client capability grants for the hosted Arc surface.
--
-- Dynamic client registration is enabled, so completing OAuth proves identity
-- and nothing more. Before this table there was nowhere to record that a given
-- client may only read: any client a user approved could reach send_usdc.
--
-- These are capabilities, not spending limits. The funded Circle Agent Wallet
-- balance remains the autonomous budget -- this only decides whether a client
-- can spend it at all. Spend caps, per-payment maximums, recipient allowlists,
-- and task expiry are deliberately out of scope.

create table if not exists public.arc_hosted_client_grants (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- From the bearer token claim, not a foreign key: the authorization server
  -- owns client identity and registers clients dynamically, so this side can
  -- only record what it was told.
  oauth_client_id text not null check (length(trim(oauth_client_id)) between 1 and 256),

  -- Enumerated rather than free text. An unrecognised capability must be
  -- impossible to store, not merely ignored at read time.
  capabilities text[] not null default '{}'::text[]
    check (capabilities <@ array['wallet:read', 'payment:send']::text[]),

  -- Which consent the user actually saw. A grant made under older wording is
  -- not evidence of agreement to newer wording.
  consent_version text not null,

  -- Invalidates every grant for the tenant on credential rotation without
  -- needing to find and delete each row.
  auth_epoch integer not null default 0 check (auth_epoch >= 0),

  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (auth_user_id, oauth_client_id),
  foreign key (auth_user_id, tenant_id)
    references public.arc_hosted_accounts(auth_user_id, tenant_id) on delete cascade
);

-- The read path resolves one client for one user on every mutation, and skips
-- revoked rows.
create index if not exists arc_hosted_client_grants_lookup
  on public.arc_hosted_client_grants (auth_user_id, oauth_client_id)
  where revoked_at is null;

alter table public.arc_hosted_client_grants enable row level security;

-- A user may see what they granted. Only the service role writes: a client must
-- never be able to widen its own capability, which is the whole point.
grant select on public.arc_hosted_client_grants to authenticated;
grant select, insert, update, delete on public.arc_hosted_client_grants to service_role;

create policy arc_hosted_client_grants_user_select on public.arc_hosted_client_grants
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy arc_hosted_client_grants_service_role_all on public.arc_hosted_client_grants
  for all to service_role
  using (true) with check (true);

-- NO BACKFILL, DELIBERATELY.
--
-- Backfilling `payment:send` for every existing account would preserve today's
-- behaviour and close nothing -- every already-registered client would keep the
-- exact authority this table exists to withhold.
--
-- The consequence is that after this migration, and until a grant is recorded,
-- hosted clients are read-only and payments stop. That rollout step is an
-- operational decision with a live deployment attached, so it is left to the
-- operator rather than smuggled into a schema change. See
-- docs/hackathon/arc-agentic/ for the rollout note.
