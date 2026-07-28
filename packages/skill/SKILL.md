---
name: agentpay
description: Use AgentPay Arc's complete local MCP surface for autonomous wallet, payment, commerce, liquidity, identity, validation, reputation, and ERC-8183 job workflows on Arc Testnet.
---

# AgentPay

AgentPay Arc is a local MCP payment plugin for autonomous USDC spending from an authenticated Circle Agent Wallet on Arc Testnet.

Use this skill for the complete implemented product: wallet and budget,
payments and receipts, x402 commerce, Unified Balance/bridge/swap, ERC-8004
identity/reputation/validation, ERC-8183 escrow jobs, and marketplace activity.
Use AgentPay Arc MCP tools for each of these workflows.

## Scope

Use only AgentPay MCP tools for AgentPay actions.

Do not bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, browser automation, shell scripts, or private-key handling.

The public install command is:

```bash
npx @agentpay-ai/agentpay-arc install
```

The install command only installs/configures the MCP plugin and instructions. It must not create a wallet, deploy a smart account, sign messages, approve payments, or move funds.

The default install configures a config-free local `agentpay-wallet` MCP with 31
local Arc MCP tools and does not require or install a remote hosted MCP. An
explicit `--mcp-url` option adds a remote hosted `agentpay` MCP when supplied.
Circle Agent Wallet commands must run through the local surface because the
authenticated Circle CLI session stays on the user's machine. Its process-owned
durable state is stored at `~/.agentpay/arc-state.json` with owner-only
permissions; tools never accept a tenant ID. Hosted AgentPay surfaces must not
receive Circle OTPs, session credentials, wallet secrets, or mutation authority.

After installation, ask the user to reload or reconnect the agent runtime if needed. Then return to the agent chat and continue with wallet creation or payment using AgentPay MCP tools.

Use this diagnostic command only when checking self-hosted/operator configuration readiness or troubleshooting:

```bash
npx @agentpay-ai/agentpay-arc doctor
```

This checks self-hosted MCP and setup-web readiness without starting services or printing secret values.

Use this fallback command only for self-hosted/operator mode when the setup/signing page needs to be served outside the hosted agent tool flow:

```bash
npx @agentpay-ai/agentpay-arc setup-web
```

## If AgentPay Is Not Installed

If the user asks for a crypto payment and AgentPay MCP tools are unavailable:

1. Do not attempt the payment.
2. If you have terminal/local command access, ask for explicit approval before installing:

```txt
I can install AgentPay by running `npx @agentpay-ai/agentpay-arc install`.
This will modify local MCP/runtime configuration. Do you approve?
```

3. Only after approval, run:

```bash
npx @agentpay-ai/agentpay-arc install
```

4. Ask the user to reload or reconnect the runtime if needed, then return to the agent chat. Do not ask normal users to fill local Supabase, RPC, executor, deployer, or bytecode config.
5. If you do not have terminal/local command access, explain that AgentPay cannot be installed or checked from this session.
6. Use `npx @agentpay-ai/agentpay-arc doctor` only for self-hosted/operator diagnostics.
7. Use `npx @agentpay-ai/agentpay-arc setup-web` only for self-hosted/operator fallback.
8. Continue in chat by calling `setup_agent_wallet`. Never ask the user to paste email, OTP, Terms acceptance, private keys, or a Circle session into chat.

## Available MCP Tools

The 31 local Arc MCP tools are:

- `setup_agent_wallet`: check the local Circle Agent Wallet testnet session and return `LOGIN_REQUIRED`, `TERMS_REQUIRED`, `WALLET_REQUIRED`, or `READY`. Login, Terms, and OTP remain manual local-terminal actions.
- `get_agent_budget`: return canonical Arc onchain USDC plus confirmed Gateway USDC without summing Arc's native 18-decimal and ERC-20 six-decimal views of the same onchain balance.
- `fund_agent_wallet`: request Arc Testnet faucet funding for the selected Agent Wallet. This is a real mutation and must never be retried blindly.
- `withdraw_agent_budget`: withdraw from the onchain wallet to an explicit recipient, or from confirmed Gateway balance back to the selected wallet or an explicit recipient.
- Payments: `send_usdc`, `create_payment_request`, `pay_invoice`, `batch_payout`, `list_agent_activity`, `get_payment_receipt`.
- Paid services: `search_paid_services`, `inspect_paid_service`, `pay_paid_service`.
- Liquidity: `get_unified_balance`, `fund_from_any_chain`, `bridge_usdc`, `swap_tokens`, `swap_and_pay`.
- ERC-8004: `register_agent_identity`, `get_agent_identity`, `give_agent_feedback`, `request_agent_validation`, `respond_agent_validation`, `get_agent_trust`.
- ERC-8183: `create_agent_job`, `set_agent_job_budget`, `fund_agent_job`, `submit_agent_deliverable`, `complete_agent_job`, `reject_agent_job`, `get_agent_job`.

The following names belong to the inherited hosted Celo smart-account surface.
They remain available for compatibility but do not authorize local Arc Agent
Wallet spending:

- `prepare_wallet_creation`: start wallet setup. A legacy `PENDING` response includes a setup intent and signing link; a production `SETUP_REQUIRED` response includes the hosted `setupUrl`.
- `check_wallet_creation`: check whether a legacy `PENDING` setup intent has completed and return the AgentPay smart account address.
- `get_agent_wallet`: return owner, executor, smart account address, home chain, and status.
- `get_balance`: read Celo USDC/USDT/USDm and CELO balances.
- `parse_invoice_payment`: parse structured invoice text into `prepare_payment` fields.
- `search_x402_services`: search x402 Bazaar when the user wants a paid API/service but does not provide a URL.
- `prepare_x402_service_request`: prepare a selected x402 Bazaar HTTP resource and synthetic `PAYMENT-REQUIRED` object.
- `parse_x402_payment_required`: parse a v2 x402 `PAYMENT-REQUIRED` object or header into `prepare_payment` fields.
- `retry_x402_request`: retry a protected x402 HTTP resource with AgentPay receipt-proof headers after the matching payment is complete.
- `prepare_contract_call`: prepare a guarded same-chain contract call intent with calldata hash review.
- `quote_payment_route`: quote a direct or LI.FI swap + bridge + pay route without creating an intent.
- `check_route_target_allowance`: check whether a LI.FI route target is already allowlisted.
- `prepare_route_target_allowance`: prepare the owner transaction that allows or revokes a LI.FI route target.
- `prepare_account_admin_transaction`: prepare owner transactions for pause, unpause, executor rotation, nonce cancellation, token allowlist updates, and withdrawals.
- `prepare_payment`: create a payment intent and, for trusted consumer sessions, return a server-generated Review & Sign URL plus canonical EIP-712 typed data. The legacy approval phrase is migration-only.
- `get_payment_signature`: poll the tenant-scoped Review & Sign handoff and return the verified owner signature without executing a payment.
- `execute_payment`: execute a prepared payment with the owner signature on the public paid ASP. The authenticated consumer only prepares and reviews; approval text is local/migration-only and is not public payment authorization.
- `track_payment`: track source and destination transaction status.
- `list_transactions`: show recent payment intents and transactions.
- `list_payment_events`: show lifecycle audit events for a specific payment intent.

If a tool name differs in the active MCP server, use the closest AgentPay tool with the same purpose.

## Arc Agent Wallet Network

The Circle Agent Wallet tools in this skill support only `ARC-TESTNET`. Do not ask the user to choose mainnet versus testnet for these tools and do not describe Arc Testnet activity as Arc mainnet.

Arc's native 18-decimal USDC metadata and six-decimal ERC-20 application interface represent the same underlying onchain balance. Never sum those two views. Confirmed Gateway balance is separate deposited value and can be shown as a separate budget component.

The inherited owner-signed smart-account tools below are Celo compatibility
context. They do not define authorization for Circle Agent Wallet spending.

## Circle Agent Wallet Setup Workflow

When the user asks to create an AgentPay wallet:

1. Call `setup_agent_wallet`.
2. For `LOGIN_REQUIRED`, tell the user to run Circle Agent Wallet testnet login locally and complete email OTP themselves.
3. For `TERMS_REQUIRED`, show the instruction returned by AgentPay and wait for the user to review and accept Circle CLI Terms locally.
4. For `WALLET_REQUIRED`, ask the user to finish testnet authentication; Circle provisions wallets during login.
5. For `READY`, show the Arc wallet address. If several wallets exist, ask which address to use and pass it as `walletAddress`.
6. Call `fund_agent_wallet` only after the user explicitly asks for a testnet faucet mutation.
7. Call `get_agent_budget` to confirm the resulting available budget.

Never automate Circle login, Terms acceptance, or OTP entry. Never claim the wallet is ready until `setup_agent_wallet` returns `READY`.

## Owner Admin Workflow

Use `prepare_account_admin_transaction` for emergency or owner-control requests such as pause, unpause, executor rotation, nonce cancellation, token allowlist updates, or withdrawals.

Show the action, account address, owner address, chain, transaction target, and calldata before asking the owner wallet to submit it. Make clear that admin transactions are not payment approvals.

## Balance Workflow

When the user asks about the Agent Wallet budget, call `get_agent_budget`. Show:

- Selected Arc Agent Wallet address.
- Canonical onchain USDC.
- Confirmed Gateway USDC.
- Autonomous budget total.
- Gateway pending value as unknown when the tool reports `NOT_AVAILABLE_FROM_CIRCLE_CLI`; never replace unknown with zero.

If wallet selection is ambiguous, ask the user to choose one of the safe wallet addresses returned by `setup_agent_wallet`.

Never use raw wallet balances, exchange balances, or generic RPC balance as the AgentPay Agent Wallet budget. Use only `get_agent_budget`.

## Invoice Workflow

For a local Arc payment request:

1. Call `create_payment_request` with a UUID-v4 request ID and idempotency key,
   exact recipient, six-decimal USDC amount, purpose, and expiry.
2. Give the payer the returned immutable request fields.
3. Call `pay_invoice` only with the exact bound fields. A changed recipient,
   amount, chain, token, purpose, expired request, or replay conflict must stop.
4. Return its receipt and use `get_payment_receipt` for Arcscan proof.

`parse_invoice_payment` belongs to the inherited hosted Celo flow. Do not route a
local Arc Agent Wallet invoice through that owner-signature path.

## Batch Payout Workflow

Validate the complete recipient list, reject duplicates or malformed rows, show
the total USDC exposure, then call `batch_payout` once with a UUID-v4 `batchId`
and idempotency key. Report each item result and partial progress. Never rerun a
failed or ambiguous batch with a new key to hide its existing state.

## Remittance Workflow

Use `get_unified_balance` for confirmed Arc and Gateway USDC. Use
`fund_from_any_chain` to return a source-wallet action plan without signing for
that wallet. Use `bridge_usdc` or `swap_tokens` only with explicit destination,
recipient, protected minimum receive, slippage, and idempotency key.
`swap_and_pay` may execute the payment leg only after Viem verifies that the
actual mined swap receive meets the payment minimum.

## Agent-to-Agent Workflow

Resolve and show the receiving agent's verified payment address, check
`get_agent_budget`, then call `send_usdc` with a UUID-v4 idempotency key and a
purpose naming the receiving agent. Agent identity metadata never replaces
address verification. A replay must return the same receipt; a
`RECONCILIATION_REQUIRED` response must not be retried.

## Arc Paid-Service Workflow

1. Call `search_paid_services`, then let the user choose a service.
2. Call `inspect_paid_service` and preserve the exact request/quote binding.
3. Call `pay_paid_service` once with its UUID-v4 idempotency key, buyer/seller
   agent IDs, selected wallet, original request, and inspected quote.
4. Stop if the quote expires or drifts. Return only the bounded service response
   and the verified Arc payment proof.

The hosted seller endpoint is read-only with respect to the local wallet and
uses its own x402 settlement adapter.

## ERC-8004 Workflow

Use `register_agent_identity` and then `get_agent_identity` to verify the
onchain owner/wallet binding. Use `give_agent_feedback` for reputation, and
`request_agent_validation` / `respond_agent_validation` for validation
credentials. Return `get_agent_trust` results as unavailable when registry reads
fail; never present an outage as verified absence.

## ERC-8183 Job Workflow

Use `create_agent_job` with an explicit provider, evaluator, future expiry, and
zero hook unless a hook is verified whitelisted. Read `get_agent_job` before
each lifecycle write. Follow the role and state sequence:
`create_agent_job` → `set_agent_job_budget` → `fund_agent_job` →
`submit_agent_deliverable` → `complete_agent_job` or `reject_agent_job`.

The deployed escrow uses Arc USDC and an upgradeable ERC-1967 proxy. AgentPay
verifies the proxy implementation, transaction target, decoded function input,
receipt, and job ID before advancing durable state. The deployed
`fund(uint256,bytes)` function has no atomic expected-budget argument, so
funding retains a documented read/write race and must never be described as
race-free.

## Marketplace Workflow

The Agent Marketplace is a read-only UI for service discovery, seller trust,
ERC-8183 jobs, and session-scoped activity. It must never receive the local
Circle CLI session. Anonymous catalogue pages are allowed; `/activity` requires
a verified server-side session and never accepts tenant identity from a query
parameter or header.

## Inherited Celo x402 Workflow

If the user asks for a paid x402/API service but does not provide a URL, call `search_x402_services` first. Show the Bazaar candidates, ask the user to choose one, collect required parameters, then call `prepare_x402_service_request`. Use the returned `paymentRequired` and `request` with the normal x402 flow below.

When an HTTP endpoint returns an x402 v2 `PAYMENT-REQUIRED` response:

1. Call `parse_x402_payment_required` with the copied response object or base64 header and the exact original request. Its URL, method, body, and safe headers are bound into the owner-signed purpose. If the original request is unavailable, omit it only for the secure GET-without-body fallback.
2. Show the resource, scheme, network, token, amount, recipient, and timeout.
3. Tell the user that AgentPay can prepare the stablecoin transfer with the returned `paymentInput`.
4. Continue with the normal payment workflow using the full returned `paymentInput`, including its `paymentType`.
5. After `execute_payment` and `track_payment` return `COMPLETED`, call `retry_x402_request` with the original `PAYMENT-REQUIRED` object/header, the exact same request, and the completed `paymentIntentId`.
6. Return the protected resource response to the user when the retry succeeds.

`retry_x402_request` attaches the AgentPay receipt proof as both `X-PAYMENT` and `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE` with legacy `X-PAYMENT-RESPONSE` fallback, and adds `payment-identifier` idempotency data when the server advertises it. Do not claim universal x402 exact facilitator compatibility unless the merchant supports this AgentPay receipt-proof bridge or the integration uses a native x402 signer/facilitator path.

## Contract Call Workflow

Use `prepare_contract_call` only for same-chain Celo contract calls where the user provides or confirms the target address, calldata, maximum token spend, and purpose.

Before execution:

1. Show the target address, source token, max token spend, max native fee, calldata hash, deadline, and purpose.
2. Call `check_route_target_allowance` for the contract target.
3. If the target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit that owner transaction first.
4. Treat contract-call execution as legacy/local-only until a dedicated owner-signed V2 authorization exists. Do not expose phrase-based contract-call execution on the public surface.

Never prepare contract calls from vague prose, never modify calldata after preparation, and never execute against a target that AgentPay reports as not allowlisted.

## Payment Workflow

For every payment:

1. Understand the requested recipient, amount, token, Celo source network, destination chain, and purpose. Ask for mainnet or testnet if omitted.
2. Call `quote_payment_route` when route preview is useful or the source/destination token or chain may differ.
3. Call `prepare_payment`.
4. Show the returned payment summary to the user. When `authorization` is present, show the canonical typed-data details and exact `authorizationHash`.
5. Open the returned `reviewUrl` for the owner. The connected wallet must use **Review & Sign** to sign the server-derived EIP-712 authorization. Do not let the agent, session, or x402 credential replace this signature.
6. Poll `get_payment_signature` until it returns the verified 65-byte owner signature, then hand the `paymentIntentId` and signature to the public paid ASP and call its `execute_payment` tool. The authenticated consumer does not execute payments directly.
7. Call `track_payment` until the payment reaches a clear completed, failed, or still-executing state.
8. Call `list_payment_events` when the user asks for audit history, failure detail, or lifecycle evidence for a payment.

The summary shown before approval must include:

- Recipient address.
- Amount and destination token.
- Source token and source chain.
- Destination chain.
- Max source spend.
- Max native fee.
- Payment path/provider and route summary.
- Route target and calldata hash for LI.FI routes.
- Estimated fee.
- Estimated ETA.
- Deadline or expiry.
- Purpose.
- Authorization hash and owner-signature status.

## Approval Rules

Circle Agent Wallet spending does not use the inherited AgentPay per-payment Review & Sign flow. The user grants autonomous authority by funding the Agent Wallet, and can reclaim remaining funds through `withdraw_agent_budget`. AgentPay still validates amounts, wallet ownership, exact chain, single-attempt mutations, and audit data.

The rules below apply only to the inherited owner-signed smart-account `prepare_payment` and `execute_payment` path:

Payment authorization must be a valid owner EIP-712 signature over the immutable typed data returned by `prepare_payment`.

Reject vague confirmations or other chat-only messages as payment authorization:

```txt
yes
ok
go
approve
looks good
send it
```

If the owner has not signed Review & Sign, do not execute. The old `APPROVE pay_123` phrase is accepted only by an explicitly enabled local/migration adapter.

Never execute a payment if:

- The owner signature is missing, malformed, or does not recover to the verified owner.
- The intent expired.
- The recipient, amount, route, token, or chain changed after preparation.
- The user asks to skip confirmation.
- Balance is insufficient.
- AgentPay returns an error.

If the public paid ASP's `execute_payment` says the intent is already being executed or is no longer awaiting approval, do not retry the same signature. Call `track_payment` or `list_payment_events` for the current status.

## Insufficient Balance

If balance is insufficient, do not ask for approval and do not create pressure to proceed.

AgentPay checks source-token balance during `quote_payment_route`, `prepare_payment`, and `prepare_contract_call`, then checks again at signed execution. If a preparation tool reports insufficient balance, no Review & Sign request should be made.

Explain:

- Required source token amount.
- Available source token amount.
- Required native fee if relevant.
- Available native balance if relevant.
- Minimum top-up needed.

Then wait for the user to fund the wallet before preparing a new intent.

## Cross-Chain Route Rules

For LI.FI swap + bridge + pay routes:

- After quoting, call `check_route_target_allowance` for the returned route target.
- If the route target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit the returned transaction before execution.
- Explain that cross-chain delivery can take time.
- Do not guarantee completion until `track_payment` confirms it.
- Track both source and destination transaction hashes when available.
- If the route is delayed, report the current status and continue tracking if requested.

## Error Handling

Use these responses:

- AgentPay tools unavailable: follow the install workflow.
- Wallet not created: follow wallet creation workflow.
- Setup intent expired: create a new setup intent.
- Quote unavailable: explain that no supported route is available and ask for a different token/chain/amount.
- Insufficient balance: follow insufficient balance workflow.
- Signature mismatch: return to Review & Sign and prepare a fresh intent if any signed field changed.
- Intent expired: prepare a fresh payment intent.
- Execution failed: show the error, do not retry automatically, and ask whether to prepare a new intent.
- Payment executing: call `track_payment` and report the latest status.

## Security Rules

- Never request or display private keys or seed phrases.
- Never ask the user to send funds to an address that was not returned by AgentPay.
- Never modify payment details after approval.
- Never execute payment outside AgentPay MCP tools.
- Never run `npx @agentpay-ai/agentpay-arc install` without explicit user approval when acting on the user's machine.
- Never expose the local Circle CLI session through a hosted MCP surface.
- Never accept email, OTP, Terms acceptance, private keys, mnemonics, or Circle session data as Agent Wallet tool inputs.
- Never retry `fund_agent_wallet` or `withdraw_agent_budget` after a transient or ambiguous failure.
- Never treat installation approval as payment approval.
- Never treat setup signature as payment approval.
- Never treat an x402 parse result as payment approval or protocol settlement; retry x402 resources only after the matching payment intent is `COMPLETED`.
- Never promise that a bridge is complete until tracking confirms destination delivery.
