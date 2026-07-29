-- Rollback procedure for Arc-only Hosted Identity Foundation (Task 13A)
-- This SQL drops all Task 13A RPC functions, tables, security policies, and shared tenant RLS policies in reverse dependency order.

begin;

-- 1. Drop PL/pgSQL functions idempotently
drop function if exists public.arc_set_account_status(uuid, text);
drop function if exists public.arc_fail_provisioning(uuid, uuid, text);
drop function if exists public.arc_complete_provisioning(uuid, uuid, text, text, text);
drop function if exists public.arc_claim_provisioning_job(uuid);
drop function if exists public.arc_claim_hosted_account(uuid, text);

-- 2. Drop RLS policies & tables idempotently
drop policy if exists arc_hosted_accounts_user_select on public.arc_hosted_accounts;
drop policy if exists arc_hosted_accounts_service_role_all on public.arc_hosted_accounts;
drop policy if exists arc_circle_wallet_bindings_service_role_all on public.arc_circle_wallet_bindings;
drop policy if exists arc_tenants_service_role_all on public.tenants;

drop table if exists public.arc_circle_wallet_bindings cascade;
drop table if exists public.arc_hosted_accounts cascade;

commit;
