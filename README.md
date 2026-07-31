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

The hosted hackathon MVP is live:

- Web dashboard: [arc.agentpay.site](https://arc.agentpay.site)
- OAuth-protected MCP: `https://mcp.arc.agentpay.site/mcp`
- Health: `https://mcp.arc.agentpay.site/healthz`

The hosted MCP uses wallet-first login, OAuth 2.1 with PKCE, explicit consent,
and one tenant-isolated Circle developer-controlled SCA wallet per user. It
exposes five hosted Arc MCP tools: `setup_agent_wallet`, `get_agent_budget`,
`send_usdc`, `get_payment_receipt`, and `get_unified_balance`.

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

The product is conversational. Hosted users connect the MCP endpoint, sign in
with an external wallet, explicitly approve OAuth access, and then return to
their agent chat. Operators may also run the complete local tool surface.

1. The agent calls `setup_agent_wallet` and returns the Circle Agent Wallet
   address.
2. The user funds that wallet with Arc Testnet USDC. Circle login, Terms
   acceptance, and email OTP are manual human steps that AgentPay never
   automates.
3. The agent calls `get_agent_budget` before spending. Insufficient balance
   stops the flow.
4. The agent performs the requested economic action and returns a receipt with
   an Arcscan proof link.
5. Hosted users withdraw remaining balance from the dashboard, which calls the
   authenticated withdrawal API. The complete local MCP surface exposes
   `withdraw_agent_budget` for the same purpose.

On the hosted path, Circle API credentials and the Entity Secret remain only in
the Arc MCP service environment; neither reaches the browser, database, OAuth
client, or tool response. On the local path, writes run through the
authenticated Circle CLI and its session stays on the user's machine. Both
paths execute mutating commands exactly once and never blindly retry an
ambiguous payment.

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

## Try the hosted MVP

Add this Streamable HTTP endpoint to an MCP-compatible client:

```text
https://mcp.arc.agentpay.site/mcp
```

The client discovers the OAuth server, opens the wallet-signature and consent
flow at `https://arc.agentpay.site`, and returns with a PKCE-bound token.
Normal users do not need Supabase, RPC, executor, deployer, or bytecode config. They
also do not receive or manage Circle API credentials.

## Local install

The npm package is not published yet, so do not run an `npx` command from the
registry. Clone this repository, build it, and run the tracked installer from
the repository root. It detects the target runtime and writes MCP configuration
plus the `skills/agentpay/SKILL.md` instructions:

```bash
git clone https://github.com/agentpay-mcp/agentpay-arc.git
cd agentpay-arc
npm ci
npm run build
node packages/cli/dist/index.js install --runtime <runtime>
```

Use `codex`, `claude`, `cursor`, `hermes`, or `generic` for `<runtime>`. To
configure the hosted MCP alongside the complete local 31-tool wallet surface:

```bash
node packages/cli/dist/index.js install --runtime <runtime> \
  --mcp-url https://mcp.arc.agentpay.site/mcp
```

For an operator-managed deployment:

```bash
node packages/cli/dist/index.js install --runtime <runtime> --self-hosted
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

### Hosted Arc and inherited local runtime boundaries

The live hosted Arc runtime is an independent entry point that validates only
the Arc-prefixed environment contract, binds web and MCP listeners to loopback,
and runs behind the Arc-only TLS proxy. Its public surfaces are:

- Web and OAuth consent: `https://arc.agentpay.site`
- Authenticated MCP: `https://mcp.arc.agentpay.site/mcp`
- Browser API: `https://mcp.arc.agentpay.site/api/`

The inherited general-purpose local startup parser remains separate and is
still Celo-shaped. It is not the process serving the hosted Arc deployment.

`parseAgentPayEnv` in `apps/mcp-server/src/runtime/agentpay-runtime.ts` is what
starts that inherited runtime, and it still validates the inherited Celo
environment: `AGENTPAY_HOME_CHAIN_ID` must be a Celo chain ID — `42220` in
production. Do not feed hosted Arc values into that legacy parser. The hosted
deployment instead uses `deploy/arc/` and its `ARC_*` environment names.

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
