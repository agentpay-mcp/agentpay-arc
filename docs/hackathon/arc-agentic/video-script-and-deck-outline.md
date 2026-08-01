# AgentPay Arc — Submission Bundle (draft)

Encode x Arc Programmable Money Hackathon · Agentic Economy
Final deadline: 2026-08-10 11:59 UTC

**Status: draft. Not recordable yet.** The live sequence in Part 1 describes a
journey that does not exist until P0-1 capability enforcement and the P0-2
golden journey are built. Recording it as written today would stage a decision
the software does not yet make.

**Nothing here is final-release evidence.** Every count and balance below is a
snapshot at the commit where it was measured. The submission gate needs a fresh
transaction receipt, its expected state change, and a journey trace, all bound
to the exact release SHA — none of which exists yet.

---

## Two surfaces, and why the distinction matters everywhere below

Conflating them is the easiest way to make a false claim in this document.

| | Hosted surface | Local runtime |
|---|---|---|
| Entry | `hosted-arc-start.ts` | `stdio.ts` / installed CLI |
| Tools | **5** | **31** |
| Writes | Circle **Developer-Controlled Wallets** (`CircleDeveloperWalletsAdapter`) | Circle **CLI** adapter |
| In the demo journey | yes | no |

x402, ERC-8004 identity, ERC-8183 escrowed jobs, and the Foundry account
contracts are **not** part of the hosted five-tool journey. They are real work
in this repository, but they are secondary or inherited context — never
described as the Arc payment path.

---

# PART 1 — Three-Minute Video Script

426 spoken words as written. Two clean rehearsals must land at **180 seconds or
under, including proof-shot pauses and UI latency**; if they do not, cut
narration rather than rushing the evidence.

## 0:00–0:20 · The problem

> "An AI agent can decide what to buy. It cannot pay for it.
>
> Every payment rail assumes a human at checkout — a card, a confirmation, a
> signature. So agents stop where money moves, and a person finishes by hand.
>
> AgentPay closes that gap on Arc."

**On screen:** an agent pausing at a payment step, cursor waiting.

## 0:20–0:45 · What it is

> "AgentPay is an MCP payment runtime. Any MCP client connects and gains a
> balance it can check and spend in USDC on Arc. The hosted surface exposes five
> tools and nothing else — the smaller the surface, the less there is to abuse.
>
> You fund a Circle Agent Wallet once. That balance *is* the agent's budget. No
> allowance screens, no per-payment prompts: you set the ceiling by choosing how
> much to fund."

**On screen:** `npx @agentpay-ai/agentpay-arc`, then the five hosted tools.

## 0:45–1:45 · The live journey — one unbroken take

**Blocked until P0-1 and P0-2 land.** This must be a single capture bound to one
journey ID and the exact release SHA. A cut mid-journey reads as staged.

> "Here is one real run on Arc Testnet.
>
> The agent authenticates through OAuth — dynamic client registration, PKCE, and
> a wallet-signed consent. No token is ever pasted by hand.
>
> It receives an objective, reads the live price and trust signals, and applies
> its policy. This first service fails the rule, so it **declines** — and no
> money moves.
>
> The second passes. It pays, once, with one idempotency key and exactly one
> attempt. The runtime never blindly retries a payment.
>
> The receipt reaches COMPLETE, the protected result comes back, and the balance
> change is read from an Arc RPC node — not from our own database."

**On screen, in order:** consent → objective and observed signals → the
**declined** decision with its reason → `get_agent_budget` → `send_usdc` →
`get_payment_receipt` `COMPLETE` → protected result → `eth_getBalance` against
`rpc.testnet.arc.network`.

The decline is the most important shot in the video. It is what separates a
decision-making agent from a chatbot calling a fixed tool.

## 1:45–2:20 · Why it is trustworthy

> "Payments are easy. Not losing money is hard.
>
> Every hosted write goes through one Circle Developer-Controlled Wallets
> adapter, with one attempt per mutation. Nothing is retried blindly, and an
> ambiguous result is never guessed — the budget stays reserved and waits for
> reconciliation.
>
> Authority is bound to the OAuth client. A client granted read access cannot
> reach the payment tool at all, and every grant is revalidated immediately
> before a transfer."

**On screen:** the one-attempt path, then a read-only client being refused.

*Second paragraph is contingent on P0-1 shipping. Cut it if it does not.*

## 2:20–2:50 · Circle and Arc

> "Funds are held in Circle Agent Wallets and every hosted write is a Circle
> Developer-Controlled Wallets operation. The installable local runtime adds
> thirty-one tools over the Circle CLI, including x402 paid services and
> on-chain agent identity.
>
> On Arc, USDC is the native gas token — an agent holding USDC can pay *and*
> transact without touching a second asset. That is why this belongs on Arc."

**On screen:** chain ID `5042002` and USDC `0x3600…0000`.

## 2:50–3:00 · Close

> "AgentPay Arc. Live, installable from npm, with the transaction on Arcscan to
> prove it."

**On screen:** `https://mcp.arc.agentpay.site/mcp` and the repository URL.

---

## Recording rules

- **0:45–1:45 is one take.** It is the only thing a judge cannot get from the
  README.
- Say **"test USDC"** at least once. Claiming mainnet value would be false.
- Never say "trusted", "verified", or "secure" about anything not on screen in
  the same shot.
- Show the **RPC query**, never our own dashboard. A product displaying its own
  database proves nothing.

---

# PART 2 — Deck Outline

Working draft, eleven slides. Must still be checked against the eight judge
beats in the handoff.

### 1 · Title
**AgentPay Arc — payment infrastructure for autonomous agents**
Agentic Economy · Arc Testnet `5042002`

### 2 · Problem
Agents can decide. They cannot pay.
Every rail assumes a human at checkout.

### 3 · Insight
**Fund once. The balance is the authority.**
No allowance screens, no per-payment prompts.

### 4 · What we built
MCP payment runtime · Circle Agent Wallet custody
Hosted: 5 tools · local runtime: 31
USDC on Arc, where USDC is also the gas

### 5 · Live proof *(pending final journey)*
`arc.agentpay.site` · `mcp.arc.agentpay.site/mcp`
`npx @agentpay-ai/agentpay-arc` — v0.1.18 published
One journey: transaction hash, Arcscan link, release SHA
*Screenshot the RPC query, not our UI*

### 6 · The autonomous journey
OAuth DCR + PKCE + wallet-signed consent
→ observe → **decline** → observe → pay → receipt → result
No hand-pasted token at any step

### 7 · Safety
One adapter, one attempt, no blind retry
Ambiguous state fails closed, waits for reconciliation
Capability bound to OAuth client · tenant isolation · secret redaction

### 8 · Standards *(secondary — not the hosted journey)*
ERC-8004 identity · ERC-8183 escrowed jobs
Selectors read from deployed bytecode; the published ABI omits `reject()`

### 9 · Circle Agent Stack
Agent Wallets · Developer-Controlled Wallets (hosted) · Circle CLI + x402 (local)
Native USDC gas is why this belongs on Arc

### 10 · Engineering evidence
Counts and audit results at the exact release SHA
Reproducible from a clean clone

### 11 · Next
Broader paid-service catalogue · mainnet when Arc opens

**Slide 5 is what judges scrutinise.** Slide 10 matters more than it looks:
"reproducible from a clean clone" is a claim most submissions cannot make.

Do not put the internal `28.2/100` heuristic anywhere. Encode publishes no
numeric weights; quoting our own number invites a question we cannot answer.

---

# Claim-to-source map

Anything not in this table must not appear in public material.

| Claim | Source | Verified |
|---|---|---|
| Chain ID `5042002`, native USDC gas | `ARC_VERIFIED_FACTS.md`, live `eth_chainId` → `0x4cef52` | 27 Jul |
| USDC ERC-20 `0x3600…0000`, 6 decimals | `ARC_VERIFIED_FACTS.md` | 27 Jul |
| Hosted 5 tools | `HOSTED_ARC_TOOL_NAMES`, `hosted-arc-wallet-runtime.ts:44` | 1 Aug |
| Local runtime 31 tools | `stdio.test.ts:133`, `hosted-arc-http.test.ts:1174` | 1 Aug |
| Hosted writes = Developer-Controlled Wallets | `CircleDeveloperWalletsAdapter`, `hosted-arc-start.ts:81` | 1 Aug |
| Local writes = Circle CLI | `CircleCli.executeContract()`, `CLAUDE.md` adapter boundary | 1 Aug |
| npm `0.1.18` published | `npm view @agentpay-ai/agentpay-arc version` | 1 Aug |
| Endpoints `200` | `curl` → `/healthz`, `/readyz`, `/.well-known/oauth-protected-resource` | 1 Aug |
| MCP endpoint is `/mcp` | root returns `404`; `/mcp` returns `405` to GET | 1 Aug |
| DCR + PKCE read-only E2E | integrator record `20260801-0053` (**payment out of scope**) | 1 Aug |
| Payment canary `COMPLETE` | integrator record `20260731-2205` | 31 Jul |
| No high/critical advisories | `npm audit --audit-level=high`, exit 0; 0 high, 0 critical, 18 moderate, 7 low | 1 Aug |
| 864 Node tests, 141 Foundry | clean clone of `63c6c48` | 1 Aug |
| ERC-8183 ABI omits `reject()` | selectors read from deployed bytecode, `ARC_VERIFIED_FACTS.md` | 27 Jul |

## The balance sequence, stated correctly

These are **two separate events**. Presenting the final three balances as the
result of one agent payment would be false.

| Event | B (payer) | A (payee) | B external |
|---|---|---|---|
| After the agent's `0.01` payment B→A | **19.99** | 0.01 | — |
| After a separate **human dashboard** withdrawal | 19.98 | 0.01 | 0.01 |

The DCR + PKCE end-to-end run and the payment canary are also separate: record
`20260801-0053` states payment was out of scope. Until the unified journey
exists, they are two snapshots and must be labelled as such.

## Not claimed anywhere, deliberately

Mainnet deployment · real-money value · audited contracts · any user base ·
"audit clean" · a single run that was actually assembled from separate evidence.
