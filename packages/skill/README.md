# @agentpay-ai/skill-arc

AgentPay runtime instructions for AI coding agents.

This package contains the AgentPay Arc `SKILL.md` and OpenAI metadata used by `npx @agentpay-ai/agentpay-arc install`. Most users should install the CLI instead of installing this package directly:

```bash
npx @agentpay-ai/agentpay-arc install --runtime <runtime>
```

After installation, users should return to their agent chat and ask for Arc Agent Wallet creation or payment there. The agent uses the local AgentPay Arc MCP tools for wallet, budget, payment, commerce, liquidity, identity, and job workflows.

## Contents

- `SKILL.md` defines AgentPay payment, setup, Review & Sign, and safety workflows.
- `agents/openai.yaml` provides Codex/OpenAI agent metadata.

## Safety Notes

The skill keeps Circle login, Terms acceptance, OTPs, and wallet secrets out of chat; requires explicit approval before installation or external mutations; and preserves the inherited owner-signature requirements only for the separate Celo compatibility path.
