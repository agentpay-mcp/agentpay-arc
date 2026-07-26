import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("README", () => {
  it("describes the implemented local AgentPay runtime instead of stale scaffold state", async () => {
    const contents = await readFile("README.md", "utf8");
    const quickStart = contents.split("## Chat Flow")[0] ?? contents;

    assert.doesNotMatch(contents, /being scaffolded/i);
    assert.match(contents, /plugin-first, MCP-first/i);
    assert.match(contents, /npm run release:smoke/);
    assert.match(contents, /skills\/agentpay\/SKILL\.md/);
    assert.match(contents, /detects the target runtime/i);
    assert.match(contents, /npx @agentpay-ai\/agentpay-celo install/);
    assert.match(quickStart, /https:\/\/wallet\.agentpay\.site\/celo\/mcp/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/celo\/mcp/);
    assert.match(contents, /normal users do not need Supabase, RPC, executor, deployer, or bytecode config/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /Create an AgentPay wallet/i);
    assert.match(contents, /mainnet or testnet/i);
    assert.match(contents, /network: "mainnet" \| "testnet"/);
    assert.match(contents, /AgentPay smart account address/i);
    assert.match(contents, /Owner.*Executor/s);
    assert.match(contents, /apps\/mcp-server/);
    assert.match(contents, /packages\/cli/);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /public HTTPS A2MCP|public MCP endpoint/i);
    assert.match(contents, /Celo x402|x402 seller gate/i);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.match(contents, /PAYMENT-REQUIRED/);
    assert.match(contents, /ERC-8021/);
    assert.match(contents, /CELO_ATTRIBUTION_TAG/);
    assert.match(contents, /x402 facilitator settlements.*not tagged|does not tag x402 facilitator settlements/i);
    assert.match(contents, /ERC-8004 Agent Identity/i);
    assert.match(contents, /\.well-known\/agent-registration\.json/);
    assert.match(contents, /ERC-1271/);
    assert.match(contents, /npm run erc8004 -- verify/);
    assert.match(contents, /CELO_MAINNET_RPC_FALLBACK_URL/);
    assert.match(contents, /npm run canary:mainnet/);
    assert.match(contents, /--execute-mainnet-canary/);
    assert.match(contents, /application\/json, text\/event-stream/);
    assert.match(contents, /Never pass signatures or private keys as command-line arguments/i);
    assert.doesNotMatch(contents, /docs\//);
    assert.doesNotMatch(contents, /AGENTPAY_CONCEPT/);
    assert.doesNotMatch(contents, /product blueprint/i);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /Fill the generated config/i);
  });

  it("presents the npm CLI as a chat-first install flow", async () => {
    const contents = await readFile("packages/cli/README.md", "utf8");
    const quickStart = contents.split("## Commands")[0] ?? contents;

    assert.match(contents, /npx @agentpay-ai\/agentpay-celo install/);
    assert.match(contents, /return to your agent chat/i);
    assert.match(quickStart, /https:\/\/wallet\.agentpay\.site\/celo\/mcp/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/celo\/mcp/);
    assert.match(contents, /No user secrets are required|do not manage Supabase/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /create an AgentPay wallet/i);
    assert.match(contents, /mainnet or testnet/i);
    assert.match(contents, /network: "mainnet" \| "testnet"/);
    assert.match(contents, /pay 5 USDT/i);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /Celo x402|x402 seller gate/i);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /config\.json/);
  });

  it("keeps public AgentPay docs aligned to Celo for the standalone hackathon branch", async () => {
    const files = [
      "README.md",
      "packages/cli/README.md",
      "packages/skill/SKILL.md",
      "apps/mcp-server/README.md",
      "packages/shared/README.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /Celo|CELO_RPC_URL|USDm/);
      assert.doesNotMatch(contents, /XLAYER_RPC_URL|OKX Agent Payments Protocol/);
    }
  });

  it("keeps installed agent instructions explicit about network selection", async () => {
    const files = [
      "packages/skill/SKILL.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      if (file === "packages/skill/SKILL.md") {
        assert.match(contents, /support only `ARC-TESTNET`/i);
        assert.match(contents, /do not ask the user to choose mainnet versus testnet/i);
        assert.match(contents, /walletAddress/);
        assert.match(contents, /Circle Agent Wallet/i);
        continue;
      }

      assert.match(contents, /mainnet or (?:testnet|Sepolia)/i, `${file} must ask for Celo network choice`);
      assert.match(contents, /network: "mainnet" \| "testnet"/, `${file} must mention tool network input`);
      assert.match(contents, /switch networks per request/i, `${file} must describe per-request network switching`);
      assert.match(contents, /Cross-chain.*payment/i, `${file} must keep cross-chain as a payment-time choice`);
      assert.match(contents, /(?:self-service|chat).*wallet creation.*Celo Sepolia/i, `${file} must keep public wallet creation on Sepolia`);
      assert.match(contents, /mainnet.*operator-managed/i, `${file} must identify the gated mainnet account path`);
      assert.doesNotMatch(
        contents,
        /cross-chain route,? before creating an AgentPay wallet/i,
        `${file} must not present cross-chain as a wallet-creation option`,
      );
    }
  });

  it("keeps the agreed hackathon payment scope visible", async () => {
    const contents = await readFile("README.md", "utf8");

    for (const capability of [
      /send payments/i,
      /invoice/i,
      /x402/i,
      /batch payout/i,
      /remittance/i,
      /agent-to-agent/i,
    ]) {
      assert.match(contents, capability);
    }
  });

  it("documents the verified PUBLIC Celo deployment and onchain evidence", async () => {
    const contents = await readFile("README.md", "utf8");

    assert.match(contents, /READY\s*\/\s*PUBLIC/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/celo\/readyz/);
    assert.match(contents, /https:\/\/wallet\.agentpay\.site\/celo\/readyz/);
    assert.match(contents, /https:\/\/8004scan\.io\/agents\/celo\/9720/);
    assert.match(contents, /0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121/i);
    assert.match(contents, /0x7e1d7834e57f9e16393329ba37a7c5e7a39f6735/i);
    assert.match(contents, /celo_442daeb34ae2/);
    assert.match(contents, /0x900a9cfe473ed82ae15b343a9ca9b6a9919542fa84f83be97b3a934d32a1940f/);
    assert.match(contents, /0x8820bf87809243afdf028949e30c84abd89b06b388a3b32f762e54bce450a716/);
    assert.match(contents, /0\.01 USDC/);
    assert.match(contents, /canonical Celo USDC|USDC-only/i);
  });

  it("keeps installed agent instructions aligned to the Codex operational workflows", async () => {
    const files = [
      "packages/skill/SKILL.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /Use AgentPay(?: Arc)? MCP tools|Use AgentPay when/i, `${file} must route requests to AgentPay`);
      assert.match(contents, /prepare_wallet_creation/, `${file} must describe wallet setup`);
      assert.match(contents, /check_wallet_creation/, `${file} must describe wallet completion checks`);
      assert.match(
        contents,
        /PENDING[\s\S]*check_wallet_creation/i,
        `${file} must limit setup-intent polling to legacy PENDING responses`,
      );
      assert.match(
        contents,
        /SETUP_REQUIRED[\s\S]*setupUrl[\s\S]*get_agent_wallet/i,
        `${file} must describe the production onboarding handoff`,
      );
      assert.match(contents, /get_agent_wallet[\s\S]*get_balance|get_balance[\s\S]*get_agent_wallet/, `${file} must describe balance reads through AgentPay tools`);
      assert.match(contents, /Never use raw wallet balances, exchange balances, or generic RPC balance/i, `${file} must forbid non-AgentPay balance sources`);
      assert.match(contents, /quote_payment_route/, `${file} must describe route previews`);
      assert.match(contents, /prepare_payment/, `${file} must describe payment preparation`);
      assert.match(contents, /prepare_contract_call/, `${file} must describe guarded contract calls`);
      assert.match(contents, /check_route_target_allowance/, `${file} must describe route target checks`);
      assert.match(contents, /prepare_route_target_allowance/, `${file} must describe route target owner transactions`);
      assert.match(contents, /execute_payment/, `${file} must describe execution`);
      assert.match(contents, /track_payment/, `${file} must describe tracking`);
      assert.match(contents, /list_payment_events/, `${file} must describe audit events`);
      assert.match(contents, /Reject vague confirmations|Never accept vague confirmations/i, `${file} must reject vague approvals`);
      assert.match(contents, /insufficient balance[\s\S]*do not ask for approval|do not request approval[\s\S]*insufficient balance/i, `${file} must stop on insufficient balance`);
    }
  });

  it("keeps x402 instructions on the AgentPay receipt-proof retry flow", async () => {
    const files = [
      "README.md",
      "packages/skill/SKILL.md",
      "apps/mcp-server/README.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /retry_x402_request|receipt-proof retry|receipt proof/i, `${file} must describe x402 retry`);
      assert.match(contents, /PAYMENT-RESPONSE/, `${file} must mention the x402 V2 settlement response header`);
      assert.match(contents, /payment-identifier/i, `${file} must mention x402 idempotency support`);
      assert.match(contents, /(?:method.*body.*bound|bound.*method.*body)/i, `${file} must bind the x402 request shape`);
      assert.match(contents, /search_x402_services|Bazaar/i, `${file} must describe x402 Bazaar discovery`);
      assert.match(
        contents,
        /prepare_x402_service_request|no URL|without a URL/i,
        `${file} must describe the no-URL x402 flow`,
      );
      assert.doesNotMatch(
        contents,
        /AgentPay can prepare the returned transfer, but standard x402 exact endpoints still require/i,
        `${file} must not describe x402 as parse-only`,
      );
    }
  });
});
