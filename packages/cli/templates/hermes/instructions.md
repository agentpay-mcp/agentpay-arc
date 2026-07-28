# AgentPay Instructions

Use AgentPay MCP tools when the human wants to create a Celo wallet, check balance, send stablecoins, pay invoices, purchase x402 services, prepare batch payouts, handle remittance routes, pay another agent, execute after owner Review & Sign, or track status.

If the human asks you to make a crypto payment and AgentPay tools are not available, install AgentPay yourself only if you have terminal access and explicit approval to modify local runtime configuration:

```bash
npx @agentpay-ai/agentpay-arc install
```

The default install connects to the authenticated consumer AgentPay MCP at `https://wallet.agentpay.site/arc/mcp` and also installs a config-free local `agentpay-wallet` MCP for Circle Agent Wallet tools, so humans do not need Supabase, RPC, executor, deployer, or bytecode config. The separate paid public execution ASP is `https://mcp.agentpay.site/arc/mcp` and is used only after Review & Sign. Ask them to reload or reconnect the runtime if needed, then return to the agent chat. Use `npx @agentpay-ai/agentpay-arc doctor` only for self-hosted/operator diagnostics. Use `npx @agentpay-ai/agentpay-arc setup-web` only for self-hosted/operator fallback when the setup/signing page cannot be served through the hosted agent flow.

Use AgentPay MCP tools only. Never bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, shell scripts, or private-key handling.

AgentPay Arc's primary flow is the local Circle Agent Wallet on Arc Testnet. The user funds it once and that funded USDC balance is the agent's autonomous budget. Do not ask for a separate approval on every payment, and never invent daily allowances, per-payment maximums, recipient allowlists, or domain allowlists.

These Circle Agent Wallet tools support only `ARC-TESTNET`. Do not ask the user to choose mainnet versus testnet for them, and never describe Arc Testnet activity as Arc mainnet. Call `setup_agent_wallet` to check the local session; it returns `LOGIN_REQUIRED`, `TERMS_REQUIRED`, `WALLET_REQUIRED`, or `READY`. Call `fund_agent_wallet` to request Arc Testnet USDC, `get_agent_budget` to report the available autonomous budget, and `withdraw_agent_budget` to return remaining funds to the user.

The config-free local `agentpay-wallet` now exposes the complete 31-tool Arc surface: `send_usdc`, invoice/payment-request, batch payout, activity/receipt, paid-service discovery and purchase, Unified Balance/bridge/swap, ERC-8004 identity/reputation/validation, and ERC-8183 job lifecycle tools. Its process-owned durable state stays local and no tool accepts caller-supplied tenant authority. Use the read-only Agent Marketplace for service, trust, job, and authenticated activity views.

When reporting the budget, never sum Arc's native 18-decimal USDC view and its 6-decimal ERC-20 view of the same onchain balance, and keep confirmed Gateway funds separate from pending deposits. Never use raw wallet balances, exchange balances, or generic RPC balance as the Agent Wallet budget; use only `get_agent_budget`.

Circle login, Terms acceptance, and email OTP are manual actions the user performs in their own terminal. Never automate them, and never ask the user to paste an OTP, private key, seed phrase, or Circle session into chat. Never claim the wallet is ready until `setup_agent_wallet` returns `READY`.

The owner-signed smart-account tools described below are inherited Celo compatibility context. They do not define authorization for Circle Agent Wallet spending.

AgentPay payment and balance tools support Celo mainnet and Celo Sepolia. Self-service chat wallet creation is currently available on Celo Sepolia; mainnet uses an operator-managed, readiness-gated account path. If the human does not clearly name one, ask whether they want mainnet or testnet before wallet, balance, route-target, admin, contract-call, quote, or payment preparation tools. Pass the selected value as `network: "mainnet" | "testnet"` whenever available. Users can switch networks per request; do not treat wallet, balance, allowlist, or payment state from one network as valid on the other.

Cross-chain routes are payment-time choices, not wallet-creation choices. Create a Celo Sepolia wallet through chat, or use an already activated operator-managed Celo mainnet account, then decide during quote or payment preparation whether the payment stays on Celo or uses a remittance route.

Balance workflow: when the user asks to check AgentPay balance, confirm mainnet or testnet if missing, call `get_agent_wallet`, then call `get_balance` with the same network. Report the AgentPay smart account address, network, USDC, USDT, USDm, and native CELO balances. Never use raw wallet balances, exchange balances, or generic RPC balance as AgentPay balance.

Payment workflow: call `quote_payment_route` when previewing direct paths, cross-chain routes, source token, fee, native fee, ETA, or max spend is useful. Then call `prepare_payment`, show all returned details, open the returned `reviewUrl`, and ask the owner to use Review & Sign for the EIP-712 signature. Poll `get_payment_signature`, then hand the signed `paymentIntentId` and signature to the public paid ASP's `execute_payment`; the consumer surface never executes directly. Then call `track_payment` plus `list_payment_events` for status or audit detail. The exact approval phrase is migration-only.

After installation, continue in chat: create the human's AgentPay wallet with `prepare_wallet_creation`; when it returns `PENDING`, provide the setup signing link and use `check_wallet_creation` with the returned setup intent id; when it returns `SETUP_REQUIRED`, open `setupUrl`, wait for hosted setup completion, then call `get_agent_wallet`; help the human fund the wallet, parse invoices with `parse_invoice_payment`, preserve the returned `paymentType` when preparing parsed payments, search Bazaar with `search_x402_services` when the human wants a paid x402/API service but does not provide a URL, prepare the selected Bazaar service with `prepare_x402_service_request`, parse x402 v2 `PAYMENT-REQUIRED` responses with `parse_x402_payment_required`, preserve `paymentType: "X402_PAYMENT"`, run the Review & Sign owner-signature flow, call `retry_x402_request` after `track_payment` returns `COMPLETED`, read V2 `PAYMENT-RESPONSE`, include `payment-identifier` idempotency data when advertised, and explain that AgentPay receipt proof works when the merchant supports this proof bridge, prepare owner controls with `prepare_account_admin_transaction`, prepare payments, show max source spend, minimum output, exact native value, and max native fee before Review & Sign, use `prepare_contract_call` only to prepare a same-chain contract-call review and treat its execution as local/migration-only until a dedicated V2 typed authorization exists, explain the required top-up instead of asking for Review & Sign when AgentPay reports insufficient balance during quote or preparation, call `check_route_target_allowance` for LI.FI targets, call `prepare_route_target_allowance` when the owner needs an allowlist transaction, show target details and calldata hashes when present, call `track_payment` after execution before reporting completion, use `list_payment_events` for audit history, and never execute without a valid owner EIP-712 signature.

Pass the exact x402 request into both parse and retry. Its URL, method, body, and safe headers are bound into the owner-signed purpose; omission is allowed only for the GET-without-body fallback.

Reject vague confirmations like `yes`, `ok`, `go`, or `send it`; chat-only messages are not payment authorization. If balance is insufficient, do not ask for approval or Review & Sign; explain the required top-up.

The setup signature proves ownership only; the setup signature is not payment approval.

If you do not have terminal access, explain that AgentPay cannot be installed from this session.
