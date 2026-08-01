# AgentPay Arc Winner-Readiness Implementation Handoff

**Status:** Revised after teammate premise verification; implementation pending

**Baseline commit:** `a1f4f39a753a3914e797a54dd5644a152e65530e`

**Track:** Encode x Arc Programmable Money Hackathon — Agentic Economy

**Official final deadline:** `2026-08-10T11:59:00Z` (`2026-08-09` Anywhere on Earth)

**Internal audit baseline:** `BLOCKED`, evidence-adjusted `28.2/100`

The numeric score is an internal prioritization heuristic. Encode publishes four
judging dimensions but no numeric weights.

## Revision decision — 2026-08-01

This handoff was corrected after the teammate's live/code verification in
[PR #24](https://github.com/agentpay-mcp/agentpay-arc/pull/24#issuecomment-5150933564):

- Dynamic Client Registration is an explicitly authorized, persisted production
  state. Readiness must assert DCR is enabled and `deploy/arc/README.md` must be
  corrected; DCR being enabled is not itself a drift finding.
- Supabase currently advertises only `openid`, `profile`, `email`, and `phone`.
  The implementation path is therefore a server-side capability grant, not a
  custom OAuth scope.
- Do not add spend caps, maximum-per-payment settings, recipient/domain
  allowlists, or per-payment approval prompts. The funded Circle Agent Wallet
  balance remains the autonomous budget defined by the product owner.
- Still prevent silent privilege escalation: an authenticated read-only client
  must not be able to call `send_usdc`; payment capability must be explicit,
  tenant/client bound, revocable, and revalidated at mutation time.
- Submission artifacts are sequenced first because they are a deadline hard
  gate, but draft scripts/outlines are not complete evidence until committed,
  linked publicly, validated, and bound to the final exact release SHA.
- Keep the internal `28.2/100` heuristic out of public submission materials.
  Likewise, `864` Node tests at `63c6c48` and `141` Foundry tests are historical
  snapshots until reproduced on the final exact head.

Execution order: commit the P0-3 draft bundle first, implement and verify the
P0-1 capability boundary, then complete the P0-2 live journey and final P0-3
provenance freeze. Starting the bundle first does not make it submission-ready
before the capability and journey evidence exist.

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

> A capability-controlled agent receives a service objective, observes real
> price and trust signals, chooses whether to pay, executes a small USDC payment
> from its funded Circle Agent Wallet on Arc, receives the protected result, and
> returns a verifiable receipt.

The completed implementation must make the following judge beliefs undeniable:

1. this is a real decision-making agent, not a chatbot calling a fixed tool;
2. the demonstrated value movement happened on Arc with meaningful USDC and
   Circle integration;
3. a compromised or prompt-injected read-only client cannot silently acquire
   payment authority;
4. the live demo, repository, receipt, video, and deck all represent the same
   exact release.

## P0-1 — Close hosted OAuth capability-authority gaps

### Current evidence

- Live authorization metadata publishes a non-null `registration_endpoint`
  because Dynamic OAuth Apps were explicitly authorized and persisted. The
  conflicting statement in `deploy/arc/README.md` is stale.
- Hosted OAuth advertises only `openid`, `email`, `profile`, and `phone`.
- Client identity is already bound and cross-checked, but the `send_usdc` path
  does not distinguish read-only clients from payment-capable clients.
- The product intentionally treats the entire funded Circle Agent Wallet
  balance as the autonomous budget.

### Required implementation

1. Correct `deploy/arc/README.md` and add a deployment/readiness check for the
   authorization-server metadata. Production readiness must assert the reviewed
   state: DCR enabled with the expected issuer and sanitized metadata. The check
   must not print credentials or full metadata.
2. Bind hosted tool authority to the OAuth `client_id` and an explicit internal
   capability grant.
3. Implement the verified server-side path: store at least `wallet:read` versus
   `payment:send`, bound to `auth_user_id`, `client_id`, consent version, auth
   epoch, and revocation state. Do not wait on unsupported custom OAuth scopes.
4. Make the consent/connection surface truthful about whether the client is
   read-only or payment-capable and show the revocation path. This is a one-time
   capability disclosure, not a per-payment prompt or budget configuration UI.
5. Revalidate the capability immediately before every mutation. A stale,
   revoked, wrong-tenant, wrong-client, read-only, or auth-epoch-mismatched grant
   must fail before any Circle call.
6. Preserve the existing idempotency, one-attempt mutation, reconciliation,
   tenant isolation, pause, withdrawal, and secret-redaction properties.

Explicitly out of scope unless the product owner changes the model: spend caps,
maximum-per-payment settings, recipient/domain allowlists, task expiry/action
limits, and per-payment approval prompts.

### Tests first

Write RED tests before implementation for:

- unexpected live DCR metadata makes readiness fail;
- an identity-only or read-only grant cannot call `send_usdc`;
- a grant cannot be replayed by another OAuth client or tenant;
- revocation, consent-version, and auth-epoch boundaries fail closed;
- a capability downgrade concurrent with `send_usdc` cannot pass revalidation;
- concurrent duplicate idempotency keys still reuse one payment attempt;
- ambiguous receipts still enter reconciliation, and a retry cannot submit
  twice;
- the consent UI accurately renders read-only versus payment capability;
- raw tokens, Circle identifiers, metadata bodies, and secrets never appear in
  errors or logs.

### Acceptance evidence

- Unit and integration tests covering every boundary above.
- Browser E2E for read-only, payment-capable, deny, revoke, and auth-epoch
  invalidation behavior.
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
agent needs a paid report or data resource and pays from its funded wallet.

The canonical journey is:

1. receive an objective under an authenticated, payment-capable client grant;
2. inspect at least two real service offers;
3. read price, service identity/trust, required parameters, and funded wallet
   balance as real signals;
4. apply deterministic policy to choose one offer or decline all offers;
5. record the observation, selected action, reason, authority check, and stop
   condition in a sanitized trace;
6. pay a small amount of Arc Testnet USDC without a per-payment human prompt;
7. receive the protected resource;
8. return the result, wallet balance before/after, Circle transaction identifier,
   Arcscan link, receipt status, and expected state change;
9. demonstrate one negative branch and one replay/reconciliation branch.

### Required implementation

1. Integrate one official Circle Agent Stack starter/runtime compatible with
   the existing TypeScript architecture. Record the official source, pinned
   version, and why it is meaningful to the decision loop. Installing a package
   alone is not integration proof.
2. Implement the decision policy as a small, deterministic, independently
   testable module. The model may interpret the objective, but it must not be
   able to bypass hard price/trust rules, Arc/token validation, available funded
   balance, client capability, idempotency, or stop conditions.
3. Use immutable inputs and outputs. Persist only a sanitized trace containing:
   observation, decision, selected tool/action, policy result, outcome,
   recovery, and termination reason.
4. Choose exactly one canonical judge surface. The strongest hosted journey
   must not depend on undocumented local-only tools. Either expose the minimum
   reviewed commerce capability through the hosted authority boundary or host
   the runner beside it with equivalent protections.
5. Keep live mutation mode opt-in and fail closed when required credentials,
   payment capability, Arc chain verification, or idempotency state is absent.
6. Demonstrate why Arc matters with measured confirmation time and
   USDC-denominated cost, not only a network label.

### Tests first

Write RED tests before implementation for:

- a price/trust signal change produces a different decision;
- insufficient funded balance or a read-only client returns `DECLINED` without
  a mutation;
- prompt content cannot override the deterministic policy;
- the selected offer and decision inputs are included in the immutable journey
  trace that is bound to the eventual payment result;
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
- One immutable journey ID joins the selected quote digest, client capability,
  payment idempotency key, Arc receipt, and protected-response digest. Replaying
  that journey returns the prior receipt and result without a second payment.
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
3. Treat the teammate's eleven-slide outline as a working draft. Produce a final
   concise deck with no placeholders that covers the playbook's eight narrative
   beats; condense slides when that improves the three-minute judge story.
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
