# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## What this repo is

**AgentPay Arc** — an MCP-first payment runtime for autonomous AI agents on
**Arc**, Circle's stablecoin-native L1. Built for the Encode x Arc Programmable
Money Hackathon (Agentic Economy track).

This is an **isolated fork** of the AgentPay product. Two sibling repositories
exist and must never be modified from here:

| Repo | Chain | Status |
|---|---|---|
| `agentpay-xlayer` | OKX X Layer | original production |
| `agentpay-celo` | Celo | production, live on mainnet |
| `agentpay-arc` | Arc Testnet | **this repo**, hackathon build |

### Inherited Celo code is still present

This repo was forked from `agentpay-celo`, so a large amount of Celo-specific
code, tests, scripts, and manifests remain. When you touch a file, first check
whether it is Arc work or inherited Celo baggage:

- Arc work lives in `*arc*` files and the `ARC_*` constants.
- Celo files (`celo-*`, `*-celo-*`, mainnet manifests, attribution tags) are
  legacy context. **Do not delete them opportunistically** and do not extend
  them either.
- The legacy Celo owner-signed EIP-712 smart-account flow is **not** the Arc
  authorization model. Do not carry it into Arc modules.

## Product model — read before designing anything

The user funds a **Circle Agent Wallet**. The funded balance *is* the agent's
autonomous budget. That is the whole authorization model.

Explicitly rejected by the product owner — do not reintroduce:

- daily allowance / spend caps
- maximum-per-payment settings
- recipient or domain allowlists
- a user approval prompt for every payment

Simplified UX does **not** relax engineering safety. Still mandatory: strict
input/output validation, chain and token checks, idempotency and replay
prevention, single-attempt mutations, exact-integer amount arithmetic, bounded
subprocess and HTTP execution, role/state validation, audit records, and secret
redaction.

Circle login, Terms acceptance, and email OTP are **manual human steps**. Never
automate them, never read a session file, never handle an OTP.

## Architecture

```
apps/mcp-server/     MCP tools, Circle CLI adapter, Viem readers, Supabase repos
apps/setup-web/      setup + review web flow (inherited, Celo-shaped)
packages/shared/     chain/token metadata, Zod schemas, domain helpers
packages/cli/        @agentpay-ai/agentpay-arc installer
packages/skill/      source for the installed SKILL.md agent instructions
contracts/           Foundry contracts + tests (inherited Celo accounts)
supabase/migrations/ tenant, payment, audit, and Arc feature migrations
scripts/             verification gates, manifests, demo/canary scripts
```

Workspace packages: `@agentpay-ai/shared-arc`, `@agentpay-ai/mcp-server-arc`,
`@agentpay-ai/agentpay-arc`.

### Adapter boundaries — non-negotiable

**Writes** go through the existing safe Circle CLI adapter only:

```
apps/mcp-server/src/services/circle-cli.ts   →  CircleCli.executeContract()
```

It already provides a fixed `circle` binary, `execFile` with `shell: false`,
bounded output, timeouts, Zod response validation, secret/OTP/mnemonic
rejection, option-injection rejection, and **exactly one attempt for
mutations**. Never shell out directly, never duplicate it, never wrap it in a
retry.

**Reads** go through an injected Viem public client. Pin the Arc chain ID and
the verified contract address. Tests must never require a live RPC.

**Persistence** goes through an injected repository interface. Never store
private keys, signatures, OTPs, Circle sessions, or raw secret-bearing CLI
output.

Modules export an **isolated registration function plus dependency interfaces**.
Central wiring is done separately by the integrator (see Ownership below).

## Verified Arc Testnet facts

Verified 27 July 2026 against `docs.arc.io` and live RPC. Re-verify before
relying on them in new code.

```
chain name          Arc Testnet
chain ID            5042002            (eth_chainId → 0x4cef52, confirmed live)
CAIP-2              eip155:5042002
Circle CLI chain    ARC-TESTNET
App Kit chain       Arc_Testnet
RPC                 https://rpc.testnet.arc.network   ← canonical per Arc docs
explorer            https://testnet.arcscan.app
USDC ERC-20         0x3600000000000000000000000000000000000000  (6 decimals)
EURC ERC-20         0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (6 decimals)
native USDC gas     18 metadata decimals
CCTP/Gateway domain 26
```

> **Canonical RPC decided 27 Jul 2026:** `https://rpc.testnet.arc.network` — the
> current Primary (Circle) endpoint in Arc's RPC endpoints and Connect to Arc
> docs. `packages/shared/src/chains.ts` still pins the inherited
> `https://rpc.testnet.arc.io`; both hosts answer and both return chain
> `5042002`, so nothing is broken. Aligning `chains.ts` is integrator-owned work
> tracked separately — do not change it opportunistically.

### The 18/6 decimal trap

Arc USDC is the native gas token with **18 metadata decimals** and also exposes
an **ERC-20 interface with 6 decimals**. They are the *same underlying balance*
viewed two ways.

- Never sum the native view and the ERC-20 view.
- Application code uses the 6-decimal ERC-20 interface for balances and
  transfers.
- Gateway confirmed balance, Gateway pending deposits, and onchain wallet
  balance are three separate quantities. Chat may present one combined budget;
  code must not double-count.

See `ARC_TESTNET_USDC.balanceSemantics` in `packages/shared/src/arc.ts`
(`sumViews: false`).

## Engineering rules

### TDD is mandatory

Write the failing test first, capture RED, implement minimum GREEN, then add
negative/boundary/error/retry/rollback coverage. Target ≥80% coverage on new
modules. Immutable data flow, strict Zod validation at every boundary, small
functions, focused files.

### Amounts

- **Never** use JavaScript floating point for token values.
- Arc application USDC is exact 6-decimal atomic units (`parseUnits(x, 6)`).
- Reject zero, negative, malformed, over-precision, and overflowing amounts.

### Mutations

- No blind retry, ever.
- UUID-v4 idempotency keys where the API supports them.
- Persist transaction IDs and hashes *before* claiming completion.
- Fail closed on ambiguous state.
- Never infer success from a submitted command alone.

### HTTP and hosted surfaces

Fixed/allowlisted HTTPS origins, bounded bodies and responses, timeouts, SSRF
and DNS-rebinding defense where arbitrary URLs are accepted, CSP on rendered
HTML, `Cache-Control: no-store` on private activity. Never put a wallet secret,
payment signature, Circle session, OTP, API key, or private activity token in
HTML, logs, receipts, or database rows.

### x402 buyer/seller separation

The Agent Wallet is a smart contract account. Do not force it through an
EOA-only buyer SDK.

- Buyer path → `circle services pay` via the CLI adapter.
- Seller path → `@circle-fin/x402-batching/server` (`createGatewayMiddleware`).
- Never instantiate `GatewayClient` / `BatchEvmScheme` with a private key in the
  Agent Wallet path.

## Ownership map

Central files — **do not edit** unless you are doing integration work:

```
apps/mcp-server/src/mcp/agentpay-mcp.ts
apps/mcp-server/src/runtime/agentpay-runtime.ts
packages/skill/SKILL.md
README.md
.env.example
```

Feature modules export registration functions; the integrator wires them into
the central MCP/runtime files after review.

## Commands

```bash
npm install                                       # required; node_modules is not committed

npm test                                          # all workspaces + scripts + contracts
npm test --workspace @agentpay-ai/shared-arc      # focused
npm test --workspace @agentpay-ai/mcp-server-arc  # focused
npm run typecheck
npm run build
npm run lint
node --test scripts/package-manifests.test.mjs
npm run release:smoke
npm audit --audit-level=high
git diff --check
```

`npm test` also runs `forge test`, so Foundry is required for the full suite.
Some inherited script gates need a running Docker daemon (PostgreSQL).

**Report blocked gates precisely.** If Docker or Foundry is unavailable, say so
— never call the repository green when a gate could not run.

## External actions — require explicit user approval

Local implementation, local commits, mocks, and read-only public docs/RPC calls
are always fine. **Stop and ask** before any of:

- sending a real onchain transaction, or deploying a contract
- requesting a faucet
- a real x402 payment, Gateway deposit/withdrawal, bridge, or swap
- accepting Circle Terms or entering an OTP
- reading private keys, seed phrases, Circle session files, or service-role keys
- applying a remote Supabase migration
- publishing to npm
- `git push`, opening a PR, or changing any third-party resource

Never "solve" a blocker by inventing production state, an ABI, credentials, a
transaction proof, a compliance result, or a passing test. Stop and report
`NEEDS_CONTEXT` or `BLOCKED` instead.

## Primary sources

Verify against these before implementing — not against memory or search
snippets. Blog posts and other hackathon projects never override them.

- Arc docs — https://docs.arc.io/ (index: https://docs.arc.io/llms.txt)
- Arc contract addresses — https://docs.arc.io/arc/references/contract-addresses
- Connect to Arc (RPC) — https://docs.arc.io/arc/references/connect-to-arc
- Agentic Economy — https://docs.arc.io/build/agentic-economy
- App Kit — https://docs.arc.io/app-kit
- Circle CLI reference — https://developers.circle.com/agent-stack/circle-cli/command-reference
- Agent Stack starter kits — https://github.com/circlefin/agent-stack-starter-kits
- ERC-8004 (identity) — https://eips.ethereum.org/EIPS/eip-8004
- ERC-8183 (agentic commerce) — https://eips.ethereum.org/EIPS/eip-8183
- Arcscan — https://testnet.arcscan.app

Before adding a package: `npm view <pkg> version` and check
`peerDependencies dependencies engines`. Record exact versions in the delivery
report. The Circle CLI adapter was validated against `@circle-fin/cli 0.0.6`.

## Delivery report format

Every task hands back:

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Task / Branch / Commit SHA / Base commit
Files changed
RED evidence
GREEN evidence
Coverage
Verification commands and results
Official docs, ABI, addresses, and package versions used
Security/self-review
Integration notes
Known blockers
External actions performed: none
```

One focused Conventional Commit per task. Do not combine tasks in one branch.

## Local-only files

`.gitignore` intentionally excludes `/AGENTS.md`, `/docs/`, `/AGENTPAY_CONCEPT.md`,
and `**/PRODUCT.md`. Private handoff material lives in `docs/handoffs/` and must
stay uncommitted. This repo is **public** — treat everything committed as
published.
