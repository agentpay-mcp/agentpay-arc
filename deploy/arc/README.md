# Arc Hosted Deployment Preparation

This directory defines the reproducible infrastructure surface for the hosted
Arc web and MCP services. It is preparation only: it does not create a remote
project, deploy a release, apply a migration, change DNS, or provision secrets.

## Fixed topology

- `https://arc.agentpay.site` serves the web application from
  `127.0.0.1:3101`.
- Requests below `https://arc.agentpay.site/api/` are proxied to the MCP
  process at `127.0.0.1:3102`.
- `https://mcp.arc.agentpay.site/mcp` and its discovery and health endpoints
  are proxied to `127.0.0.1:3102`.
- Browser API requests use `https://mcp.arc.agentpay.site/api/`; the
  `https://arc.agentpay.site/api/` route remains an equivalent same-product
  proxy path.
- The web and MCP processes run under separate unprivileged users and receive
  separate environment files.
- Nginx is the only public listener and terminates TLS for the two exact hosts.

The Nginx access log is JSON and records `$uri`, never the query string,
authorization header, or request body. Application output is retained in the
system journal. Logrotate covers both Nginx access and error logs.

## Immutable release layout

Use an immutable directory for every reviewed commit:

```text
/opt/agentpay-arc/
├── releases/
│   └── <reviewed-commit>/
└── current -> /opt/agentpay-arc/releases/<reviewed-commit>
```

Never edit a release after activation. Build a new release, validate it, and
then move the `current` symlink atomically. Replace every `@RELEASE_COMMIT@`
placeholder in the systemd templates with the exact reviewed commit.

## Local build and validation

These commands are safe to run in a clean local checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node --test scripts/arc-hosted-deployment.test.mjs
```

For a prepared server release:

1. Copy `env/web.env.example` and `env/mcp.env.example` to separate private
   files outside the release tree.
2. Populate values only from the new Arc-specific accounts and project.
3. Restrict each environment file to its matching service user and root.
4. Run `validate-env.mjs web` and `validate-env.mjs mcp` under the matching
   environment before starting either service.
5. Build `apps/arc-web` before activating the release.
6. Install the reviewed Nginx, systemd, and logrotate templates.

The validation command emits only the scope and success or error name. It never
prints environment values.

`ARC_RELEASE_SHA` is required in the MCP environment and must equal the exact
40-character commit directory activated in `/opt/agentpay-arc/current`. The
MCP `/healthz` and `/readyz` responses expose that same value so a hosted
journey can prove which reviewed release served the request before authorizing
any payment.

## New Supabase project checklist

Complete these dashboard steps only during an explicitly authorized remote
execution phase:

1. Create a new project dedicated to Arc.
2. Enable OAuth 2.1 and the authorization-server path expected by the MCP
   discovery metadata.
   Set the authorization path to
   `https://arc.agentpay.site/oauth/consent`.
3. Configure an asymmetric signing key and record the issuer URL.
4. Dynamic Client Registration (DCR) is **enabled**, authorized by the user on
   2026-08-01 after the public-client readiness review. Discovery therefore
   publishes a non-null `registration_endpoint`, and readiness asserts that
   reviewed state — a change in either direction is drift, not just a missing
   feature. The review covered OAuth 2.1 PKCE, explicit consent, exact redirect URI
   validation, authentication and registration rate limits,
   client-registration audit monitoring, and a tested path to revoke abusive
   clients.

   Because any client can now register, a registered client is authenticated
   but not trusted: it starts read-only and can only spend once the owner
   grants `payment:send` from account settings. See
   `docs/hackathon/arc-agentic/capability-grant-rollout.md`. Roll back by
   disabling DCR if registration or authorization probes fail.
5. Enable the **Ethereum Web3 Wallet** authentication provider. Arc uses the
   official Supabase SIWE flow for identity-only external-wallet login; its
   signature is never a payment approval or Circle-wallet credential.
6. Set Site URL to `https://arc.agentpay.site` and allow exactly
   `https://arc.agentpay.site/**` as the browser redirect URL pattern. This
   exact origin is part of SIWE message verification.
7. Configure authentication rate limits and CAPTCHA before accepting public
   users. Keep provider credentials out of the repository and environment
   examples.
8. Create a dedicated service-role credential and keep it only in
   `/etc/agentpay-arc/mcp.env`.
9. Apply the Arc migration set to that new project only after taking a backup
    and verifying the project reference.
10. Enable database backups, authentication audit logs, and alerting before
    accepting users.

No keys from another product, project, repository, or runtime may be copied
into these files.

## Installation destinations

- Web environment: `/etc/agentpay-arc/web.env`
- MCP environment: `/etc/agentpay-arc/mcp.env`
- Systemd units: `/etc/systemd/system/agentpay-arc-*.service`
- Nginx configuration: `/etc/nginx/conf.d/agentpay-arc.conf`
- Logrotate configuration: `/etc/logrotate.d/agentpay-arc`
- Nginx logs: `/var/log/agentpay-arc/`

Suggested ownership:

```text
/etc/agentpay-arc/web.env  root:agentpay-arc-web  0640
/etc/agentpay-arc/mcp.env  root:agentpay-arc-mcp  0640
/opt/agentpay-arc/releases root:root              0755
```

## Health and readiness

After an authorized activation, verify locally before public traffic:

```sh
curl --fail --silent http://127.0.0.1:3101/healthz
curl --fail --silent --header "Host: mcp.arc.agentpay.site" http://127.0.0.1:3102/healthz
curl --fail --silent --header "Host: mcp.arc.agentpay.site" http://127.0.0.1:3102/readyz
```

Then verify the two TLS hosts, OAuth discovery, consent, token exchange, and an
authenticated MCP request. Do not use production secrets in command history or
logs.

## Backup and observability

- Retain the current and at least one prior immutable release.
- Enable backups and point-in-time recovery on the new database project.
- Test restoration only into an isolated temporary project after authorization.
- Never include environment files in release archives or backups.
- Monitor systemd restarts, readiness failures, Nginx 4xx/5xx rates, OAuth
  denials, cross-tenant denials, and database capacity.

See `ROLLBACK.md` for the exact rollback boundary.
