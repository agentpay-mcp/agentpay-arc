# @agentpay-ai/agentpay-arc

AgentPay installs MCP tools and runtime instructions that let an AI agent hold a
Circle Agent Wallet and transact autonomously in USDC on **Arc**, Circle's
stablecoin-native L1. The default install configures the config-free local
`agentpay-wallet` MCP that exposes the 31 Arc tools. An explicit `--mcp-url`
option adds a remote hosted `agentpay` MCP when supplied. Normal users do not
manage Supabase, RPC, executor, deployer, or bytecode configuration.

## Install

```bash
npx @agentpay-ai/agentpay-arc install
```

To configure a remote hosted MCP alongside the local wallet MCP:

```bash
npx @agentpay-ai/agentpay-arc install --mcp-url https://wallet.agentpay.site/arc/mcp
```

Then return to your agent chat:

```text
Set up an Arc agent wallet for me.
Pay 5 USDC to 0x... on Arc Testnet for invoice INV-001.
```

No user secrets are required for default local-first mode.

AgentPay runs on **Arc Testnet only** — Arc has no mainnet — so there is no
network to choose. Circle login, Terms acceptance, and email OTP stay manual
human steps, and the authenticated Circle CLI session never leaves the user's
machine.

The funded Agent Wallet balance is the agent's budget. AgentPay does not ask for
a separate approval on every payment, and it does not add daily allowances,
per-payment maximums, or recipient allowlists. Cross-chain funding is selected at
payment time after the Arc wallet exists.

AgentPay covers agent wallet setup and funding, direct USDC sends, invoice
payments and payment requests, x402 service purchases, batch payouts, unified
balance and bridge/swap routes, agent-to-agent payments, and ERC-8004 identity
and reputation/validation, ERC-8183 escrow jobs, a read-only marketplace, and
durable compliance evidence. The local `agentpay-wallet` process registers all
31 Arc MCP tools for the 19 approved hackathon features.

For x402 discovery without a URL, the agent uses `search_paid_services` and
`inspect_paid_service`, then `pay_paid_service` executes the buyer path through
`circle services pay` exactly once. Receipts carry an Arcscan proof link.

## Commands

```bash
agentpay install [--mcp-url <url>]
agentpay install --self-hosted
agentpay agent-wallet-mcp
agentpay mcp
agentpay serve-http
agentpay setup-web
agentpay doctor
```

`install` detects the target runtime. `--self-hosted` additionally writes a local
config. `doctor` and `setup-web` are operator diagnostics and fallbacks, not the
normal hosted-user flow.

The public x402 seller gate is enabled with `AGENTPAY_A2MCP_PAYMENT_ENABLED=true`
plus pay-to, price, network, and asset values. `/healthz` remains free.

Hosted mode needs no configuration at all, and the Circle Agent Wallet tools run
on a config-free local MCP surface either way. That surface stores process-owned
operation state at `~/.agentpay/arc-state.json` with owner-only permissions and
does not accept caller-supplied tenant authority.

`install --self-hosted` and `doctor` require the inherited Celo config surface,
not an Arc one. `requiredConfigKeys` in `src/index.ts` is:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CELO_RPC_URL`
- `EXECUTOR_PRIVATE_KEY`

Plus Review & Sign secrets when the setup web flow is enabled. Optional values
include `SETUP_WEB_URL`, `LIFI_API_KEY`, and `X402_BAZAAR_FACILITATOR_URL`.

`ARC_TESTNET_RPC_URL` is **not** read by this CLI. It is required by the MCP
server's Arc readiness gate, so `.env.example` carries it, but `doctor` will not
ask for it and will not report it missing.

The Arc migration is incomplete at the configuration layer: the parser that
starts the MCP server, this CLI's generator, and `doctor` all still require the
inherited Celo environment, while a separate Arc readiness gate expects Arc
values. Use the values committed in `.env.example`; they are covered by a
regression test that runs them through the real startup parser.

This package is an isolated Arc fork of AgentPay. The separate Celo and OKX
X Layer deployments are unaffected by it.
