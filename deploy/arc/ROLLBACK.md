# Arc Hosted Rollback

Rollback is a remote state change. Follow this runbook only after explicit
authorization and only for the dedicated Arc infrastructure.

## Preconditions

1. Record the active release commit and the last known-good reviewed commit.
2. Confirm the target paths begin with `/opt/agentpay-arc/releases/`.
3. Confirm both systemd unit names begin with `agentpay-arc-` and the
   rendered units use the reviewed loopback ports `3101` (web) and `3102`
   (MCP); rescan the shared host immediately before any future activation.
4. Confirm the database project reference belongs to the new Arc project.
5. Take and verify a database backup before any schema rollback.
6. Do not print, copy, rotate, or replace secrets during an application
   rollback.

## Application rollback

1. Verify the last known-good release is immutable and complete.
2. Atomically point `/opt/agentpay-arc/current` to that release.
3. Render both systemd templates with that exact release commit.
4. Run `systemd-analyze verify` and `nginx -t`.
5. Restart only `agentpay-arc-web.service` and
   `agentpay-arc-mcp.service`.
6. Reload Nginx only after its configuration test passes.
7. Verify loopback health, readiness, both TLS hosts, OAuth discovery, consent,
   token exchange, an authenticated MCP request, and cross-tenant denials.

If verification fails, stop public traffic to the Arc hosts and preserve logs.
Do not switch unrelated services, processes, or configurations.

## Database rollback

Schema rollback is destructive and requires separate explicit authorization.
After confirming a current backup and the exact project reference, the approved
rollback file is:

```text
supabase/rollbacks/20260729020000_arc_hosted_identity_rollback.sql
```

Apply it only to the new Arc project. Never infer the target from the current
CLI link or shell history. Re-run migration and cross-tenant tests in an
isolated disposable database before a remote rollback.

## DNS rollback

DNS is unchanged during an ordinary application rollback. Change only the two
Arc records when the user explicitly authorizes a DNS rollback and supplies or
confirms the exact target values.

## Evidence to retain

- reviewed and rollback commit identifiers
- application release directory and symlink target
- database project reference with credentials redacted
- pre- and post-rollback health results
- systemd, Nginx, OAuth, and tenant-isolation evidence
- timestamps and operator identity

If the exact target, authorization, backup, or credentials are unavailable,
stop and request user intervention.
