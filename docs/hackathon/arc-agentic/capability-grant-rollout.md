# Capability Grants — Rollout Note

Migration: `supabase/migrations/20260801130000_arc_hosted_client_grants.sql`

**Do not apply this migration to the live Supabase project without reading this
first.** Applying the schema is harmless on its own; deploying the enforcement
release before grants exist is what stops hosted payments. Ordering the two
correctly is the whole content of this note.

## What changes

Before, completing OAuth was sufficient to call `send_usdc`. Dynamic client
registration is enabled, so any client that registered and obtained a user's
consent could move that user's funds.

After, a client can only spend if a grant records `payment:send` for it, and
that grant is live, current-epoch, and made under the consent wording in force.

## Two authorities, which must not be conflated

**The account owner, acting directly.** A bearer with no OAuth client id. The
hosted API authenticates browser sessions this way and the MCP surface refuses
them outright, so such a token cannot belong to a third party. This is the
owner, keeps full authority over their own wallet, and is unaffected by this
table — `/api/account/withdraw` continues to work exactly as before. Nothing
here is a restraint on the owner; withholding payment from them would only lock
them out of their own funds.

**A delegate, acting on the owner's behalf.** A bearer carrying an OAuth client
id. This is what the grant table governs. A delegate with no grant — including
one that just registered through DCR — resolves to `wallet:read`, so it can
show the user their balance and nothing more. A grant that is revoked,
epoch-retired, or made under older consent wording degrades the same way, so a
delegate that loses payment access still works for reading rather than
appearing broken.

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

Each step needs explicit user approval; none is performed by an agent. The
order matters: the table has to exist before rows can go in it, and the rows
have to be in place before the code that requires them ships.

1. **Apply the schema migration.** Safe on its own — the running release does
   not read this table yet, so nothing changes behaviourally.

2. **Identify the first-party client id.** Read it from the authorization
   server or the consent records. Do not guess it, and do not copy it from a
   log line.

3. **Record the grants, still before deploying enforcement**, so there is no
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

4. **Verify before releasing.** Confirm the granted client resolves to
   `["wallet:read", "payment:send"]` and that a second, ungranted client
   resolves to `["wallet:read"]`.

5. **Deploy the enforcement release.**

6. **Verify after releasing.** The granted client completes one payment; an
   ungranted client is refused and — the part worth checking rather than
   assuming — leaves no transaction and no `SUBMITTING` receipt behind.

## Rollback

Rolling back is a code deploy, not a schema change: redeploy the previous
release and enforcement stops. Leave the table and its rows in place; they are
inert to a release that does not read them, and dropping them would mean
rebuilding every grant before the next attempt.

Revoking a single client is the narrower tool and does not need a rollback —
see below.

## Revocation

Set `revoked_at`. The runtime re-resolves authority before every mutation, so a
revoked grant stops the next payment rather than the one after it. Rotating a
tenant's `auth_epoch` retires every grant issued against the old epoch without
having to find each row.

## What the consent screen now says

Approving OAuth grants read access and nothing else, and the screen says so
rather than leaving the user to infer it from a list of standard scopes:

- **Read your balance and payment history** — granted by approving.
- **Send payments** — *not* granted by this approval; the client cannot move
  funds until payment access is granted separately.

The payment line is rendered from the **resolved grant for that exact client**,
not from a fixed sentence. A client that already holds `payment:send` is shown
as holding it. This is what stops the screen becoming false the moment step 3
grants a client payment access — the earlier draft would have told that
client's user it could not move funds while it could.

An unresolved grant renders as "not granted", which is both what an absent
grant means and the safe reading if the lookup failed.

## Owner-managed grants

The owner grants and removes payment access themselves:

- `GET /api/account/clients` — every delegate and its effective capability.
  Revoked rows report `canSendPayments: false` even though the stored array
  still lists it, because reporting the stored value would tell the owner a
  revoked client can still spend.
- `POST /api/account/clients/payment` — `{ oauthClientId, allowPayment }`.

Both routes refuse any bearer carrying an OAuth client id. A delegate must
never be able to widen or restore its own capability, and binding these routes
to the client-less owner session is what enforces that — the same distinction
that separates the owner's withdrawal from a delegate's payment.

Revocation clears payment and stamps `revoked_at` rather than deleting the row,
so the owner keeps a record that the client was once trusted. Rotating a
tenant's `auth_epoch` remains the blunt instrument that retires every grant at
once.
