# AgentPay Arc Winner-Readiness Implementation Handoff

**Status:** Ready for teammate implementation in this draft PR

**Baseline commit:** `a1f4f39a753a3914e797a54dd5644a152e65530e`

**Track:** Encode x Arc Programmable Money Hackathon — Agentic Economy

**Official final deadline:** `2026-08-10T11:59:00Z` (`2026-08-09` Anywhere on Earth)

**Internal audit baseline:** `BLOCKED`, evidence-adjusted `28.2/100`

The numeric score is an internal prioritization heuristic. Encode publishes four
judging dimensions but no numeric weights.

## Ownership and external-action boundary

- The teammate owns implementation commits in this PR.
- Codex owns exact-head review and evidence verification; Codex must not merge
  or silently implement the tasks in this handoff.
- Do not deploy, change Supabase/DCR settings, publish packages or artifacts,
  spend USDC, request faucet funds, broadcast transactions, or submit the
  hackathon form without explicit user approval.
- Tests, fixtures, recordings, and fallbacks must be labeled accurately. A mock
  or deterministic fixture is never live transaction proof.
- Keep inherited Celo/X Layer functionality isolated and disclose lineage.
- Do not broaden the product beyond the three P0 outcomes below until every
  hard gate is proven.

## Winning outcome

Deliver one hosted, reproducible story:

> A policy-bounded agent receives a service objective, observes real price and
> trust signals, chooses whether to pay, executes a small USDC payment on Arc,
> receives the protected result, and returns a verifiable receipt without being
> able to exceed its authority.

The completed implementation must make the following judge beliefs undeniable:

1. this is a real decision-making agent, not a chatbot calling a fixed tool;
2. the demonstrated value movement happened on Arc with meaningful USDC and
   Circle integration;
3. a compromised or prompt-injected client cannot silently spend outside the
   explicitly granted task authority;
4. the live demo, repository, receipt, video, and deck all represent the same
   exact release.

## P0-1 — Close hosted OAuth and economic-authority gaps

### Current evidence

- Live authorization metadata publishes a non-null `registration_endpoint`,
  while `deploy/arc/README.md` says DCR must remain disabled until its readiness
  review is complete.
- Hosted OAuth advertises only `openid`, `email`, `profile`, and `phone`.
- The same authorized client can reach `send_usdc`, but the consent UI does not
  explain that the client receives authority over the funded balance.
- The product currently treats the entire funded balance as the budget, with no
  task expiry, cumulative task cap, or recipient/service restriction.

### Required implementation

1. Add a deployment/readiness check for the authorization-server metadata.
   Production readiness must fail closed when DCR state differs from the
   reviewed policy. The check must not print credentials or full metadata.
2. Bind hosted tool authority to the OAuth `client_id` and an explicit internal
   capability grant. Do not assume Supabase supports custom payment scopes:
   verify the current official API first.
3. If custom OAuth scopes are supported, use and enforce at least:
   `wallet:read` and `payment:send`. If they are not supported, store an
   equivalent server-side grant bound to `auth_user_id`, `client_id`, consent
   version, and auth epoch.
4. Require a task grant before `send_usdc`. The grant must contain:
   - maximum cumulative USDC spend in six-decimal atomic units;
   - expiry and maximum action count;
   - exact recipient allowlist or exact paid-service origin binding;
   - revocation state and immutable purpose/objective hash;
   - atomically tracked consumed amount.
   Every payment must atomically reserve budget before the Circle call using a
   unique `(grant_id, idempotency_key)` binding. Reservations transition through
   `RESERVED`, `SUBMITTED`, `CONFIRMED`, `FAILED_BEFORE_SUBMISSION`, or
   `AMBIGUOUS`. Release budget only when submission is proven not to have
   occurred; an ambiguous reservation remains unavailable until reconciliation
   proves the final outcome.
5. Render the effective authority in consent: client identity, read access,
   payment access, maximum task spend, expiry, recipient/service boundary, and
   revocation path.
6. Revalidate the grant immediately before every mutation. A stale, revoked,
   exhausted, expired, mismatched, or ambiguous grant must fail without a
   transfer.
7. Preserve the existing idempotency, one-attempt mutation, reconciliation,
   tenant isolation, pause, withdrawal, and secret-redaction properties.

### Tests first

Write RED tests before implementation for:

- unexpected live DCR metadata makes readiness fail;
- an identity-only or read-only grant cannot call `send_usdc`;
- a grant cannot be replayed by another OAuth client or tenant;
- cumulative spend, recipient/origin, expiry, action-count, revocation, and
  auth-epoch boundaries fail closed;
- two concurrent spends cannot exceed the same task cap;
- crash-after-reserve cannot release authority prematurely;
- concurrent duplicate idempotency keys reuse one reservation;
- ambiguous receipts keep budget reserved until reconciliation, and a retry
  after reconciliation cannot submit twice;
- the consent UI accurately renders the granted economic authority;
- raw tokens, Circle identifiers, metadata bodies, and secrets never appear in
  errors or logs.

### Acceptance evidence

- Unit and integration tests covering every boundary above.
- Browser E2E for approve, deny, revoke, expiry, and overspend rejection.
- Sanitized discovery/readiness output proving reviewed DCR state.
- A written trust-boundary diagram and revocation runbook.
- Fresh security review with no critical/high unresolved finding.

### Gate impact

Primary: `critical_security_clear`.

Secondary: `agent_autonomy_verified`, because bounded authority must appear in
the autonomous trace.

## P0-2 — Implement one real golden autonomous Arc journey

### Product scenario

Use one narrow buyer persona: a team operating an API-consuming AI agent. The
agent needs a paid report or data resource and has a small task budget.

The canonical journey is:

1. receive an objective and task grant;
2. inspect at least two real service offers;
3. read price, service identity/trust, required parameters, and remaining task
   budget as real signals;
4. apply deterministic policy to choose one offer or decline all offers;
5. record the observation, selected action, reason, authority check, and stop
   condition in a sanitized trace;
6. pay a small amount of Arc Testnet USDC without a per-payment human prompt;
7. receive the protected resource;
8. return the result, budget before/after, Circle transaction identifier,
   Arcscan link, receipt status, and expected state change;
9. demonstrate one negative branch and one replay/reconciliation branch.

### Required implementation

1. Integrate one official Circle Agent Stack starter/runtime compatible with
   the existing TypeScript architecture. Record the official source, pinned
   version, and why it is meaningful to the decision loop. Installing a package
   alone is not integration proof.
2. Implement the decision policy as a small, deterministic, independently
   testable module. The model may interpret the objective, but it must not be
   able to bypass hard price, trust, budget, origin, expiry, or action limits.
3. Use immutable inputs and outputs. Persist only a sanitized trace containing:
   observation, decision, selected tool/action, policy result, outcome,
   recovery, and termination reason.
4. Choose exactly one canonical judge surface. The strongest hosted journey
   must not depend on undocumented local-only tools. Either expose the minimum
   reviewed commerce capability through the hosted authority boundary or host
   the runner beside it with equivalent protections.
5. Keep live mutation mode opt-in and fail closed when required credentials,
   task grant, Arc chain verification, or idempotency state is absent.
6. Demonstrate why Arc matters with measured confirmation time and
   USDC-denominated cost, not only a network label.

### Tests first

Write RED tests before implementation for:

- a price/trust signal change produces a different decision;
- insufficient or expired task budget returns `DECLINED` without a mutation;
- prompt content cannot override the deterministic policy;
- an inspected quote is cryptographically or deterministically bound to the
  eventual payment request;
- duplicate execution reuses the receipt and never pays twice;
- timeout or ambiguous receipt stops and enters reconciliation;
- a successful local fixture is explicitly labeled simulated;
- the hosted E2E trace contains every required field and no secret-bearing data.

### Acceptance evidence

- A deterministic local RED/GREEN journey for CI.
- One user-approved live rehearsal on Arc Testnet with a fresh transaction.
- Receipt verification: chain ID `5042002`, sender, recipient/contract, USDC
  amount, successful receipt, confirmations, and expected state change.
- Two publicly reachable offer responses with retrieval timestamps, normalized
  quote digests, signal provenance, expiry, seller/service origin, and expected
  recipient. Fixtures cannot satisfy this live evidence item.
- One immutable journey ID joins the selected quote digest, task grant, payment
  idempotency key, Arc receipt, and protected-response digest. Replaying that
  journey returns the prior receipt and result without a second payment.
- A sanitized machine-readable trace tied to the exact Git SHA.
- A judge runbook that reproduces the journey in under five minutes.
- A decline branch, replay branch, and recovery/stop branch shown in evidence.

### Gate impact

Primary: `arc_deployment_verified`, `agent_autonomy_verified`, and
`core_journey_reproducible`.

Secondary: Arc/USDC integration, Agent Stack usage, real-signal input, and
explicit Arc advantage.

## P0-3 — Freeze provenance and complete the submission bundle

### Required implementation

Use `docs/hackathon/arc-agentic/` for the evidence bundle. Add:

- `README.md` — one-sentence product, scope, live/local/simulated boundaries,
  and public links;
- `claim-ledger.json` — material claims with classification, evidence grade,
  verification time, sources, limitations, and exact commit;
- `architecture.md` — agent loop, trust boundaries, Arc/USDC/Circle flow, and
  inherited-lineage disclosure;
- `judge-runbook.md` — reset and reproduction in under five minutes;
- `demo-script.md` — the final three-minute narration and shot list;
- `submission.json` — completed validator input with no placeholder URLs;
- `rehearsals.md` — two timestamped clean rehearsal results and failures;
- `security.md` — authorization, signer, revocation, replay, rate limit,
  economic-loss, dependency audit, and secret-scan evidence.

Also:

1. Publish the exact release commit and artifact-manifest digest through a safe
   health/version endpoint. Do not expose environment values.
2. Bind the live transaction, trace, video, deck, repository, and MVP to that
   exact release.
3. Produce a final public deck with eight concise slides and no placeholders.
4. Produce a public pitch/demo video no longer than 180 seconds.
5. State the buyer, quantified pain, measurable outcome, why Arc, and a credible
   business model. Do not invent traction or production metrics.
6. Verify every public link while logged out and on mobile.
7. Run the pinned internal `arc-agentic-hackathon` validator as an evidence
   preflight. It is not an Encode validator or official approval. Record the
   skill version, exact command, exit code, retrieval time, and checked URLs.
   Independently verify the participant portal requirements before submission.
   An offline pass is only a structural preflight and must not be presented as
   submission proof.

### Required three-minute video structure

- `0:00–0:15`: buyer, problem, and outcome;
- `0:15–0:35`: objective, real signals, authority, and stop conditions;
- `0:35–1:35`: uninterrupted observe → decide → pay → receive journey;
- `1:35–2:05`: Arcscan receipt and expected state change;
- `2:05–2:35`: architecture, safety, recovery, and production path;
- `2:35–2:55`: why Arc, measured impact, differentiation, business model;
- `2:55–3:00`: memorable close.

### Acceptance evidence

- `/healthz` or equivalent safely returns the exact submission SHA.
- `submission.json` passes the pinned internal online preflight, including Arc
  receipt checks, and participant-portal requirements are independently
  verified.
- Video duration is at most 180 seconds and permissions work logged out.
- Deck and all public links work logged out and on mobile.
- Two clean rehearsals complete from reset state.
- Repo, live build, trace, transaction, video, and deck describe the same SHA.

### Gate impact

Primary: `submission_artifacts_complete` and `repo_demo_same_version`.

Secondary: execution/presentation, public documentation, measurable impact,
and demo resilience.

## Required verification before review handback

Run from a clean checkout and retain exact exit codes and test counts:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
npm --workspace @agentpay-ai/arc-web run test:coverage
npm --workspace @agentpay-ai/mcp-server-arc run test:coverage
npm --workspace @agentpay-ai/arc-web run test:e2e
npm --workspace @agentpay-ai/marketplace-arc run test:e2e
npm run release:smoke
npm audit --audit-level=high
```

Requirements:

- Unit, integration, and E2E coverage for the critical journey.
- Add a deterministic `@agentpay-ai/mcp-server-arc` coverage command covering
  every changed authorization, grant, policy, runner, and reconciliation module.
  Report backend line and branch coverage separately; frontend coverage cannot
  satisfy backend security coverage.
- At least 80% line and branch coverage on changed security/agent modules.
- Resolve or precisely reproduce the Docker/PostgreSQL gate; do not call the
  full test suite green if it hangs, fails, or is skipped.
- No hardcoded secrets, raw tokens, private keys, entity secrets, OTPs, or
  unredacted environment files.
- No critical/high security finding remains unresolved.
- No real financial mutation occurs during automated tests.

## Exact-head review handback

When implementation is ready, the teammate must provide:

1. exact full Git SHA;
2. concise change summary mapped to P0-1, P0-2, and P0-3;
3. exact commands, exit codes, test counts, coverage, and skipped/blocked gates;
4. sanitized live evidence and Arcscan links, clearly separated from fixtures;
5. deployment/publication/submission actions still requiring user approval;
6. known limitations and rollback/revocation instructions.

Codex must review that exact SHA. Any subsequent commit invalidates the prior
approval and requires a new exact-head review.

## Implementation-ready handback

The teammate may hand the PR back for exact-head review when:

- code, migrations, tests, fixtures, runbooks, and dry-run evidence are
  complete;
- every required deployment, authorization-server change, live Arc mutation,
  public artifact, and submission action is listed as pending user approval;
- deterministic verification and the backend/frontend coverage gates pass;
- no critical/high security finding is unresolved in the implementation;
- the exact-head handback bundle above is complete.

Codex then reviews that exact SHA and recalculates the evidence-adjusted score.
The implementation handback does not claim that live or submission gates have
passed.

## Submission-ready activation

After explicit user approval for each external action, activation is complete
only when:

- all seven readiness hard gates are `true`;
- Codex has recalculated the evidence-adjusted score from fresh evidence;
- the score is at least `90/100` under the internal rubric;
- two clean rehearsals have completed;
- no critical/high security finding is unresolved;
- every final public artifact is available and tied to the exact release;
- the user has explicitly approved every external mutation that occurred.
