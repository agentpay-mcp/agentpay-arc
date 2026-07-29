-- Rollback procedure for Arc-only Hosted Identity Foundation (Task 13A)
-- This SQL drops all Task 13A RPC functions, tables, and security policies in reverse dependency order.

begin;

-- 1. Revoke and drop PL/pgSQL functions
revoke execute on function public.arc_set_account_status(uuid, text) from service_role;
revoke execute on function public.arc_fail_provisioning(uuid, uuid, text) from service_role;
revoke execute on function public.arc_complete_provisioning(uuid, uuid, text, text, text) from service_role;
revoke execute on function public.arc_claim_provisioning_job(uuid) from service_role;
revoke execute on function public.arc_claim_hosted_account(uuid, text) from service_role;

drop function if exists public.arc_set_account_status(uuid, text);
drop function if exists public.arc_fail_provisioning(uuid, uuid, text);
drop function if exists public.arc_complete_provisioning(uuid, uuid, text, text, text);
drop function if exists public.arc_claim_provisioning_job(uuid);
drop function if exists public.arc_claim_hosted_account(uuid, text);

-- 2. Drop RLS policies & tables
drop policy if exists arc_hosted_accounts_user_select on public.arc_hosted_accounts;

drop table if exists public.arc_circle_wallet_bindings cascade;
drop table if exists public.arc_hosted_accounts cascade;

commit;
