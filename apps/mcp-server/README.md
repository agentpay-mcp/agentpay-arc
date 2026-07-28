# @agentpay-ai/mcp-server-arc

AgentPay's MCP server exposes Arc payment tools over stdio or Streamable HTTP.
It supports Circle Agent Wallet setup and funding, autonomous budget reads and
withdrawal, direct USDC sends, invoice payments and payment requests, batch
payouts, x402 paid-service discovery and purchase, unified balance and
bridge/swap routes, ERC-8004 identity and reputation, activity receipts with
Arcscan proofs, ERC-8183 escrow jobs, and audit events.

Run the complete config-free local Arc Agent Wallet surface:

```bash
npx @agentpay-ai/agentpay-arc agent-wallet-mcp
```

It registers 31 local Arc tools and persists process-owned operation state at
`~/.agentpay/arc-state.json` with owner-only permissions. It accepts no tenant
ID and no hosted credential. Circle login, Terms, and OTP remain manual.

The package workspace `npm run start` command starts the inherited operator MCP.
Its local/staging startup values are `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CELO_RPC_URL`, and `EXECUTOR_PRIVATE_KEY` — the
keys `parseAgentPayEnv` requires to start this server. `ARC_TESTNET_RPC_URL` is
required by the separate Arc production readiness gate, not by the local startup
parser.

Agent Wallet writes run through the safe Circle CLI adapter in
`src/services/circle-cli.ts`: a fixed `circle` binary, `execFile` with
`shell: false`, bounded output, timeouts, Zod response validation, secret and
OTP rejection, option-injection rejection, and exactly one attempt for every
mutation. The authenticated Circle CLI session stays on the user's machine and
is never sent to a hosted surface.

Reads use an injected Viem public client pinned to Arc Testnet.

For the public x402 seller gate:

```bash
AGENTPAY_A2MCP_PAYMENT_ENABLED=true
AGENTPAY_A2MCP_PAYMENT_PAY_TO=0x...
AGENTPAY_A2MCP_PAYMENT_PRICE=$0.01
```

Unpaid calls receive HTTP `402` with `PAYMENT-REQUIRED`; verified calls are
accepted only when their exact seller terms match configuration, settled before
fulfilment, and returned with `PAYMENT-RESPONSE`. Durable lifecycle rows prevent
duplicate fulfilment and write payer, payee, amount, asset, network, and
settlement transaction evidence to `payment_events`. `/healthz` is never
paywalled.

When `AGENTPAY_ERC8004_ENABLED=true`, the server exposes
`/.well-known/agent-registration.json` without OAuth or x402. Publication
requires a non-zero deployed `AGENTPAY_ERC8004_AGENT_WALLET`;
`AGENTPAY_ERC8004_AGENT_ID` is added only after the registry transaction
confirms. The document is schema-validated and does not advertise unimplemented
trust mechanisms.

The Arc buyer flow uses `search_paid_services` and `inspect_paid_service` for
read-only discovery, then `pay_paid_service` executes `circle services pay`
exactly once against the exact inspected quote. A quote that changed between
inspection and execution stops the payment. Payment signatures are never
persisted or returned.

The inherited Celo owner-signature tools remain registered as compatibility
context on their separate operator surface. They do not define authorization
for Circle Agent Wallet spending.

That legacy path keeps its own x402 flow: search Bazaar with
`search_x402_services`, prepare a result with `prepare_x402_service_request`
when the user has no URL, and pass both `paymentRequired` and the exact request
to `parse_x402_payment_required`. The URL, method, body, and safe headers are bound into the owner-signed purpose before payment.

After completion,
`retry_x402_request` accepts only that request shape, attaches the explicitly
labeled `agentpay-receipt` proof, and includes `payment-identifier` idempotency
data when advertised. This bridge is AgentPay-specific, not a universal
exact-scheme signer.

Two environment validators currently coexist and disagree.

`parseAgentPayEnv` in `src/runtime/agentpay-runtime.ts` is the startup path used
by `mcp/http.ts` and `mcp/stdio.ts`. It still validates the inherited Celo
environment and requires `AGENTPAY_HOME_CHAIN_ID=42220` plus the Celo setup URL
in production. `validateProductionEnvironment` in
`src/runtime/production-readiness.ts` expects the Arc environment instead:
`AGENTPAY_HOME_CHAIN_ID=5042002`, an HTTPS `ARC_TESTNET_RPC_URL`, and the `/arc/`
public routes.

`.env.example` carries the values that satisfy the startup parser, because a
config that cannot start is worse than one that is not yet fully migrated.
`scripts/env-example-runtime.test.ts` enforces this. Reconciling the two
validators is a runtime change and is tracked separately.

`AGENTPAY_ACCOUNT_VERSION=v2` and production-only Supabase aliases are required
by both. A localhost RPC or a mismatched public route is rejected, and `/readyz`
stays closed until every readiness check agrees.

Production stdio is disabled. Setup-web production deployment stays separately
gated, and all broadcast or external provisioning actions require explicit
operator approval.
