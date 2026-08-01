# AgentPay Arc — Submission Bundle

Encode x Arc Programmable Money Hackathon · Agentic Economy
Deadline: 10 August 2026, 18:59 WIB

Every number and claim below was verified from a primary source on 1 August
2026. Nothing here is aspirational. Sources are listed at the end so you can
re-check any line before recording.

---

# PART 1 — Three-Minute Video Script

Target 460 spoken words. Timings assume an unhurried pace with pauses on the
proof shots.

## 0:00–0:20 · The problem, stated once

> "An AI agent can decide what to buy. It cannot pay for it.
>
> Every payment rail we have assumes a human is behind the checkout — a card, a
> confirmation, a signature. So today's agents stop at the moment money has to
> move, and a person finishes the job by hand.
>
> AgentPay closes that gap on Arc."

**On screen:** an agent chat pausing at "I need to pay $0.01 to continue" —
then the cursor waiting.

## 0:20–0:50 · What it is

> "AgentPay is an MCP payment runtime. Any MCP-compatible agent — Claude,
> Cursor, an Inspector client — connects to it and gets the ability to hold a
> balance, check it, and pay in USDC on Arc. The hosted surface exposes five
> tools and nothing else: the smaller the surface, the less there is to abuse.
>
> The authorization model is deliberately simple. You fund a Circle Agent
> Wallet once. That funded balance *is* the agent's budget. No allowance
> screens, no per-payment approval prompts. You decide the ceiling by deciding
> how much you fund."

**On screen:** `npx @agentpay-ai/agentpay-arc` installing, then the tool list
appearing in a real MCP client.

## 0:50–1:40 · The live journey — this is the section that wins or loses

Record this as one unbroken screen capture. Do not cut mid-transaction; a cut
here reads as a fake.

> "Here is a real run on Arc Testnet.
>
> The agent authenticates through OAuth — dynamic client registration, PKCE, and
> a wallet-signed consent. No token is ever pasted by hand.
>
> It checks its budget: twenty test USDC.
>
> It decides to pay, and sends one hundredth of a USDC to another agent's
> wallet. One call, one idempotency key, exactly one attempt — the runtime never
> blindly retries a payment.
>
> The receipt reaches COMPLETE. And here are the balances, read straight from an
> Arc RPC node, not from our own database."

**On screen, in order:** consent screen → `get_agent_budget` → `send_usdc` →
`get_payment_receipt` showing `COMPLETE` → a terminal running `eth_getBalance`
against `rpc.testnet.arc.network` for both wallets.

**Exact figures to show** (verified 1 Aug 2026):

| Wallet | Balance |
|---|---|
| Agent B (payer) | 19.98 USDC |
| Agent A (payee) | 0.01 USDC |
| B's external wallet | 0.01 USDC |

## 1:40–2:20 · Why it is trustworthy

> "Payments are the easy part. Not losing money is the hard part.
>
> Every write goes through one adapter with a fixed binary, no shell, bounded
> output, and exactly one attempt per mutation. Ambiguous results are never
> guessed — they fail closed and wait for reconciliation.
>
> Agent identity uses ERC-8004, and escrowed jobs use ERC-8183 against Arc's
> deployed contract — we read the selectors out of the deployed bytecode rather
> than trusting the published ABI, and found one function the docs omit.
>
> The account contracts are UUPS-upgradeable with role separation, and every
> account is created under an owner's signature. One hundred forty-one contract
> tests, at a thousand and twenty-four fuzz runs."

**On screen:** the adapter's one-attempt code path, then `forge test` output
showing `141 passed`.

## 2:20–2:50 · Circle and Arc, specifically

> "This is built on Circle's Agent Stack end to end. Circle Agent Wallets hold
> the funds, the Circle CLI executes every write, and x402 handles paid-service
> buying and selling.
>
> On Arc, USDC is the native gas token — which means an agent that holds USDC
> can pay *and* transact without ever touching a second asset. That is the whole
> reason this product belongs on Arc."

**On screen:** the Arc chain ID `5042002` and the USDC contract
`0x3600...0000` side by side.

## 2:50–3:00 · Close

> "AgentPay Arc. Live, installable from npm today, with the transactions on
> Arcscan to prove it."

**On screen:** `https://mcp.arc.agentpay.site` and the repository URL.

---

## Recording notes

- **The 0:50–1:40 block must be one take.** It is the only part a judge cannot
  get from the README, and a cut destroys its evidential value.
- Do not say "trusted", "verified", or "secure" about anything you are not
  showing on screen in the same shot.
- The 18/6 decimal difference is real but is a distraction in a three-minute
  video. Leave it to the deck appendix.
- Say "test USDC" at least once. Claiming mainnet value would be false.

---

# PART 2 — Deck Outline

Eleven slides. Paste straight into Canva; each block is one slide.

### 1 · Title
**AgentPay Arc — payment infrastructure for autonomous agents**
Encode x Arc · Agentic Economy · Arc Testnet `5042002`

### 2 · The problem
Agents can decide. They cannot pay.
Every rail assumes a human at checkout.
The agent economy stops at the payment step.

### 3 · The insight
**Fund once. The balance is the authority.**
No allowance screens. No per-payment prompts.
You set the ceiling by choosing how much to fund.

### 4 · What we built
MCP payment runtime · any MCP client
Local runtime: 31 tools · hosted surface: 5, deliberately narrow
Circle Agent Wallet custody
USDC on Arc, where USDC is also the gas

### 5 · Live proof
`arc.agentpay.site` · `mcp.arc.agentpay.site`
`npx @agentpay-ai/agentpay-arc` — published, v0.1.18
Real payment settled: 19.98 / 0.01 / 0.01 USDC
*(screenshot the RPC balance query, not a dashboard)*

### 6 · The autonomous journey
OAuth DCR + PKCE + wallet-signed consent
→ budget check → decision → payment → receipt `COMPLETE`
No hand-pasted token at any step

### 7 · Safety
One adapter, one attempt, no blind retry
Ambiguous state fails closed, waits for reconciliation
Tenant isolation · secret redaction · idempotency keys

### 8 · Standards
ERC-8004 agent identity
ERC-8183 escrowed jobs — selectors verified from deployed bytecode
UUPS + AccessControl accounts, owner-signed creation

### 9 · Circle Agent Stack
Agent Wallets · Circle CLI · x402 buyer and seller
Native USDC gas is why this belongs on Arc

### 10 · Engineering evidence
141 Foundry tests @ 1024 fuzz runs
864 Node tests · typecheck, lint, build, audit clean
Every claim reproducible from a clean clone

### 11 · What is next
Client-bound capability grants
Broader paid-service catalogue
Mainnet when Arc opens

---

## Slide notes

Slide 5 is the one judges will scrutinise. Show the **RPC query**, not our own
UI — a product showing its own database proves nothing. Slide 10 matters more
than it looks: "reproducible from a clean clone" is a claim most submissions
cannot make.

Do not put the 28.2/100 internal number anywhere. It is our own heuristic and
Encode publishes no numeric weights; quoting it only invites a question we
cannot answer.

---

# Sources

Verified 1 August 2026 unless noted.

| Claim | How it was checked |
|---|---|
| Balances 19.98 / 0.01 / 0.01 | `eth_getBalance` on `rpc.testnet.arc.network`, three addresses |
| Endpoints live | `curl` → `/healthz`, `/readyz`, `/.well-known/oauth-protected-resource`, all `200` |
| npm v0.1.18 | `npm view @agentpay-ai/agentpay-arc version` |
| DCR + PKCE E2E | live authorization-server metadata + integrator record `20260801-0053` |
| Payment `COMPLETE` | integrator record `20260731-2205`, transaction id and idempotency key recorded |
| 141 Foundry tests | `forge test` from a clean clone of `63c6c48` |
| Chain 5042002, USDC `0x3600…` | `ARC_VERIFIED_FACTS.md`, confirmed against live `eth_chainId` |
| ERC-8183 selectors | read from deployed bytecode; the published ABI omits `reject()` |

**Not claimed anywhere, deliberately:** mainnet deployment, real-money value,
audited contracts, or any user base.
