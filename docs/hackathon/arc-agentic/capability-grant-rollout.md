# Capability Grants — Rollout Note

Migration: `supabase/migrations/20260801130000_arc_hosted_client_grants.sql`

**Do not apply this migration to the live Supabase project without reading this
first.** Applying it stops hosted payments until grants are recorded. That is
intended, and it is the entire point — but it is a deliberate operational step,
not a side effect anyone should discover in production.

## What changes

Before, completing OAuth was sufficient to call `send_usdc`. Dynamic client
registration is enabled, so any client that registered and obtained a user's
consent could move that user's funds.

After, a client can only spend if a live, current-epoch grant records
`payment:send` for it. Reads are unaffected.

This is a capability, not a spending limit. The funded Circle Agent Wallet
balance remains the autonomous budget: no cap, no per-payment maximum, no
recipient allowlist, no expiry. The only question this answers is whether a
given client may spend at all.

## Why the migration deliberately does not backfill

Backfilling `payment:send` for every existing account would keep today's
behaviour and close nothing: every already-registered client would retain the
exact authority this table exists to withhold. A migration that leaves the
system exactly as insecure as it was, while appearing to add a security
control, is worse than no migration — it makes the gap look closed.

So the table starts empty, and the operator decides who gets `payment:send`.

## Rollout sequence

Each step needs explicit user approval; none is performed by an agent.

1. **Identify the first-party client id.** Read it from the authorization
   server or the consent records. Do not guess it, and do not copy it from a
   log line.

2. **Record the grant before applying the enforcement release**, so there is no
   window where payments fail:

   ```sql
   insert into public.arc_hosted_client_grants
     (auth_user_id, tenant_id, oauth_client_id, capabilities, consent_version, auth_epoch)
   select a.auth_user_id,
          a.tenant_id,
          $1,                                    -- exact first-party client id
          array['wallet:read', 'payment:send'],
          a.consent_version,
          t.auth_epoch
   from public.arc_hosted_accounts a
   join public.tenants t on t.id = a.tenant_id
   where a.account_status = 'ACTIVE'
     and a.wallet_status = 'LIVE'
   on conflict (auth_user_id, oauth_client_id) do nothing;
   ```

   Scoped to one named client. Every other client — including any registered
   later through DCR — stays read-only until granted explicitly.

3. **Verify before releasing.** One granted client can pay; one
   dynamically-registered client cannot, and its refusal leaves no transaction.

4. **Then deploy the enforcement release.**

## Revocation

Set `revoked_at`. The runtime re-resolves authority before every mutation, so a
revoked grant stops the next payment rather than the one after it. Rotating a
tenant's `auth_epoch` retires every grant issued against the old epoch without
having to find each row.

## What is still missing

The consent screen does not yet disclose read-only versus payment capability or
the revocation path. Enforcement is real without it, but a user approving a
client still cannot see what they are approving. That disclosure is the
remaining piece of P0-1, and it is UI work, not authorization work.
