# AgentPay Arc

AgentPay Arc is a plugin-first, MCP-first payment runtime that lets an AI agent
hold a wallet and transact autonomously in USDC on **Arc**, Circle's
stablecoin-native L1.

The authorization model is deliberately simple: **the funded balance is the budget.**

The user funds a Circle Agent Wallet once, and the agent may spend that balance
on the workflows it was asked to perform. There is no daily allowance, no
per-payment maximum, no recipient allowlist, and no approval prompt on every
payment.

Built for the Encode x Arc Programmable Money Hackathon, Agentic Economy track.

## Status

Arc Testnet only. There is no Arc mainnet — Arc has not launched one.

- Home chain: Arc Testnet, chain ID `5042002` (`eip155:5042002`)
- RPC: `https://rpc.testnet.arc.network`
- Explorer: [testnet.arcscan.app](https://testnet.arcscan.app)
- USDC ERC-20 interface: `0x3600000000000000000000000000000000000000`, 6 decimals
- Native USDC gas token: 18 metadata decimals — the same balance, a different view

Arc USDC exposes a native 18-decimal view and a 6-decimal ERC-20 view of one
underlying balance. AgentPay reads and transfers through the ERC-20 interface
and never sums the two views.

### Relationship to AgentPay Celo and X Layer

This repository is an isolated fork of the AgentPay product. The Celo and OKX
X Layer deployments are separate, live, and untouched by anything here. Where
this repository still contains Celo code, scripts, manifests, or contracts, that
is inherited lineage from the fork — not an Arc claim. The Celo owner-signed
EIP-712 smart-account flow is legacy and is **not** the Arc authorization model.

## Chat Flow

The product is conversational. The user installs AgentPay, completes Circle
login and Terms manually, funds the Agent Wallet, and then asks for work.

1. The agent calls `setup_agent_wallet` and returns the Circle Agent Wallet
   address.
2. The user funds that wallet with Arc Testnet USDC. Circle login, Terms
   acceptance, and email OTP are manual human steps that AgentPay never
   automates.
3. The agent calls `get_agent_budget` before spending. Insufficient balance
   stops the flow.
4. The agent performs the requested economic action and returns a receipt with
   an Arcscan proof link.
5. The user can withdraw the remaining balance at any time with
   `withdraw_agent_budget`.

Wallet writes run through the authenticated local Circle CLI. The CLI session,
OTP, and wallet credentials stay on the user's machine and are never sent to a
hosted service. Mutating commands execute exactly once and are never blindly
retried.

## 19 Approved Features

The hackathon product exposes 31 local Arc MCP tools across all 19 approved
features. The local process composes the reviewed wallet, payment, commerce,
liquidity, ERC-8004, and ERC-8183 adapters; the marketplace and x402 seller
remain read-only/hosted surfaces beside it.

## Arc Tools

Wallet and budget:

```text
setup_agent_wallet   fund_agent_wallet   get_agent_budget   withdraw_agent_budget
```

Payments and receipts:

```text
send_usdc   pay_invoice   create_payment_request   batch_payout
get_payment_receipt   list_agent_activity
```

Agent commerce over x402:

```text
search_paid_services   inspect_paid_service   pay_paid_service
```

Liquidity and cross-chain funding:

```text
get_unified_balance   fund_from_any_chain   bridge_usdc   swap_tokens   swap_and_pay
```

ERC-8004 identity, reputation, and validation:

```text
register_agent_identity   get_agent_identity   get_agent_trust
give_agent_feedback   request_agent_validation   respond_agent_validation
```

ERC-8183 escrow jobs:

```text
create_agent_job   set_agent_job_budget   fund_agent_job
submit_agent_deliverable   complete_agent_job   reject_agent_job   get_agent_job
```

The separate Agent Marketplace UI lists paid services, verified trust data,
ERC-8183 seller jobs, and session-scoped activity without receiving local wallet
mutation authority.

The buyer path uses `circle services pay` through the Circle CLI adapter,
because the Agent Wallet is a smart contract account and cannot be driven by an
EOA-only buyer SDK. The hosted seller path uses
`@circle-fin/x402-batching/server`. Buyer and seller stay separate adapters.

`swap_and_pay` stops before paying if the actual received amount falls below the
invoice or service minimum, and persists the exact last verified state rather
than hiding partial progress.

## Install

The installer detects the target runtime and writes MCP configuration plus the
`skills/agentpay/SKILL.md` agent instructions:

```bash
npx @agentpay-ai/agentpay-arc install
```

The Arc package is not published to npm yet; until it is, run the installer from
`packages/cli` in this repository.

Normal users do not need Supabase, RPC, executor, deployer, or bytecode config.

For an operator-managed deployment:

```bash
npx @agentpay-ai/agentpay-arc install --self-hosted
```

## Components

- `apps/mcp-server/` — MCP tools, the safe Circle CLI adapter, Viem readers,
  Supabase repositories, and production readiness gates.
- `apps/setup-web/` — setup and review web flow.
- `packages/shared/` — Arc chain/token metadata, Zod schemas, and domain helpers.
- `packages/cli/` — the `@agentpay-ai/agentpay-arc` installer and runtime templates.
- `packages/skill/` — source for the installed `skills/agentpay/SKILL.md` instructions.
- `contracts/` — Foundry contracts and tests, inherited from the Celo lineage.
- `supabase/migrations/` — tenant, payment, audit, and Arc feature migrations.

## Configuration

The normal local `agent-wallet-mcp` needs no environment variables. The
operator-hosted inherited MCP startup still requires `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CELO_RPC_URL`, and `EXECUTOR_PRIVATE_KEY`.
`ARC_TESTNET_RPC_URL` is required by the separate Arc production readiness gate,
not by the local startup parser.

See `.env.example` for the full key list.

### The hosted runtime environment is still Celo-shaped

The Arc migration is not finished at the configuration layer, and the docs say
so rather than advertising values that would not start.

`parseAgentPayEnv` in `apps/mcp-server/src/runtime/agentpay-runtime.ts` is what
actually starts the MCP server, and it still validates the inherited Celo
environment: `AGENTPAY_HOME_CHAIN_ID` must be a Celo chain ID — `42220` in
production — and the production setup URL must be the Celo one. Setting those
keys to Arc values makes the server refuse to start. `.env.example` therefore
keeps the Celo values, and `scripts/env-example-runtime.test.ts` feeds the
committed values through that parser so this cannot drift unnoticed.

A separate Arc gate, `validateProductionEnvironment` in
`apps/mcp-server/src/runtime/production-readiness.ts`, expects the Arc values
instead: `AGENTPAY_HOME_CHAIN_ID=5042002`, an HTTPS `ARC_TESTNET_RPC_URL`, and
the `/arc/` public routes below. **The two gates currently disagree**, and
reconciling them is a runtime change, not a documentation change.

- Authenticated consumer MCP: `https://wallet.agentpay.site/arc/mcp`
- Public paid MCP: `https://mcp.agentpay.site/arc/mcp`
- Setup: `https://wallet.agentpay.site/arc/setup`
- Review: `https://wallet.agentpay.site/arc/review`

The Circle Agent Wallet tools are unaffected by either gate. They run on a
config-free local MCP surface with process-owned durable state at
`~/.agentpay/arc-state.json` (created with owner-only file permissions), so the
authenticated Circle CLI session never leaves the user's machine. This local
surface now carries all 31 Arc tools; it does not accept a tenant ID or hosted
credential from tool input.

Self-hosted operators expose the public MCP endpoint with `agentpay serve-http`.
`/healthz` remains free.

## Safety Properties

The simplified approval UX does not relax engineering safety. The runtime
enforces:

- strict Zod validation at every boundary, on input and output;
- exact 6-decimal integer arithmetic for USDC — never JavaScript floating point;
- rejection of zero, negative, over-precision, malformed, and overflowing amounts;
- idempotency keys and replay prevention on mutations;
- exactly one attempt per mutating Circle CLI command, with no blind retry;
- transaction IDs and hashes persisted before any completion is claimed;
- fail-closed behavior on ambiguous state;
- bounded subprocess and HTTP execution with timeouts;
- SSRF and DNS-rebinding defense where arbitrary service URLs are accepted;
- append-auditable activity records with Arcscan proofs;
- secret redaction — no wallet secret, payment signature, Circle session, OTP, or
  API key in HTML, logs, receipts, or database rows.

## Verification

```bash
npm install
npm run demo:local
npm test
npm run typecheck
npm run build
npm run release:smoke
npm audit --audit-level=high
```

`npm test` runs the workspace suites, the script gates, and `forge test`, so
Foundry is required for the full run. Some inherited script gates additionally
need a running Docker daemon. Report blocked gates precisely rather than
calling the repository green when a gate could not run.

## Contributing Agents

`CLAUDE.md` in the repository root carries the architecture, adapter
boundaries, verified Arc constants, engineering rules, and the external-action
approval boundary. Read it before making changes.

Onchain writes, faucet requests, real x402 payments, deployments, remote
Supabase migrations, npm publishes, and pushes are all explicit human decisions
and are never performed automatically.
