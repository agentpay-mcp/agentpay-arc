import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("README", () => {
  it("describes the implemented Arc AgentPay runtime instead of stale scaffold state", async () => {
    const contents = await readFile("README.md", "utf8");
    const quickStart = contents.split("## Chat Flow")[0] ?? contents;

    assert.doesNotMatch(contents, /being scaffolded/i);
    assert.match(contents, /plugin-first, MCP-first/i);
    assert.match(contents, /npm run release:smoke/);
    assert.match(contents, /skills\/agentpay\/SKILL\.md/);
    assert.match(contents, /detects the target runtime/i);
    assert.match(contents, /npx @agentpay-ai\/agentpay-arc install/);
    assert.match(contents, /https:\/\/wallet\.agentpay\.site\/arc\/mcp/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/arc\/mcp/);
    assert.match(contents, /normal users do not need Supabase, RPC, executor, deployer, or bytecode config/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /apps\/mcp-server/);
    assert.match(contents, /packages\/cli/);
    assert.match(contents, /agentpay serve-http/);

    // Arc network identity must stay pinned and verifiable.
    assert.match(quickStart, /Arc Testnet/i);
    assert.match(contents, /5042002/);
    assert.match(contents, /https:\/\/rpc\.testnet\.arc\.network/);
    assert.match(contents, /testnet\.arcscan\.app/);
    assert.match(contents, /0x3600000000000000000000000000000000000000/);
    assert.match(contents, /ARC_TESTNET_RPC_URL/);

    // The runtime env layer is not migrated yet. The README must say so instead
    // of advertising Arc values that make the MCP server refuse to start.
    assert.match(contents, /parseAgentPayEnv/);
    assert.match(contents, /still (?:validates|requires).*(?:inherited )?Celo|Celo-shaped/i);
    assert.match(contents, /42220/);
    assert.match(contents, /two gates currently disagree|validators currently coexist/i);

    // The 18/6 decimal hazard must stay documented.
    assert.match(contents, /6 decimals/i);
    assert.match(contents, /18 (?:metadata )?decimals/i);
    assert.match(contents, /never sums the two views|not sum/i);

    // Balance-is-budget is the authorization model.
    assert.match(contents, /funded balance is the budget|balance is the budget/i);
    assert.match(contents, /Circle Agent Wallet/i);
    assert.match(contents, /exactly once/i);

    assert.doesNotMatch(contents, /docs\//);
    assert.doesNotMatch(contents, /AGENTPAY_CONCEPT/);
    assert.doesNotMatch(contents, /product blueprint/i);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /Fill the generated config/i);
  });

  it("presents the npm CLI as a chat-first Arc install flow", async () => {
    const contents = await readFile("packages/cli/README.md", "utf8");
    const quickStart = contents.split("## Commands")[0] ?? contents;

    assert.match(contents, /^# @agentpay-ai\/agentpay-arc/m);
    assert.match(contents, /npx @agentpay-ai\/agentpay-arc install/);
    assert.match(contents, /return to your agent chat/i);
    assert.match(contents, /--mcp-url/);
    assert.match(contents, /agentpay-wallet/);
    assert.match(contents, /No user secrets are required|do not manage Supabase/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /agent wallet/i);
    assert.match(contents, /Arc Testnet only/i);
    assert.match(contents, /pay 5 USDC/i);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /x402 seller gate/i);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.match(contents, /ARC_TESTNET_RPC_URL/);
    assert.match(contents, /inherited Celo runtime keys|incomplete at the configuration layer/i);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /config\.json/);

    // The published package name must never drift back to the Celo fork source.
    assert.doesNotMatch(contents, /npx @agentpay-ai\/agentpay-celo install/);
  });

  // This fork inherits Celo lineage. Public docs may reference it, but must
  // never drift back to the OKX X Layer origin they were forked away from.
  it("keeps public AgentPay docs free of X Layer origin content", async () => {
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

  it("keeps the agreed hackathon capability scope visible", async () => {
    const contents = await readFile("README.md", "utf8");

    for (const tool of [
      /setup_agent_wallet/,
      /get_agent_budget/,
      /withdraw_agent_budget/,
      /send_usdc/,
      /pay_invoice/,
      /batch_payout/,
      /list_agent_activity/,
      /search_paid_services/,
      /pay_paid_service/,
      /get_unified_balance/,
      /bridge_usdc/,
      /swap_and_pay/,
      /register_agent_identity/,
      /get_agent_trust/,
      /request_agent_validation/,
      /respond_agent_validation/,
      /create_agent_job/,
      /set_agent_job_budget/,
      /fund_agent_job/,
      /submit_agent_deliverable/,
      /complete_agent_job/,
      /reject_agent_job/,
      /get_agent_job/,
    ]) {
      assert.match(contents, tool, `README must document ${tool.source}`);
    }
    assert.match(contents, /19 approved features/i);
    assert.match(contents, /npm run demo:local/);
  });

  it("keeps the installed skill aligned with the complete local Arc surface", async () => {
    const contents = await readFile("packages/skill/SKILL.md", "utf8");

    assert.match(contents, /31 local Arc MCP tools/i);
    assert.match(contents, /process-owned|local.*durable state/i);
    assert.match(contents, /ERC-8183/i);
    assert.match(contents, /marketplace/i);
    assert.doesNotMatch(
      contents,
      /Additional Arc payment, x402, liquidity, identity, job, marketplace, and compliance tools are introduced by later/i,
    );
    assert.doesNotMatch(contents, /four Circle Agent Wallet tools/i);
  });

  it("states Arc testnet status honestly and claims no unverified deployment", async () => {
    const contents = await readFile("README.md", "utf8");

    // Arc has no mainnet; the README must say so rather than imply a launch.
    assert.match(contents, /Arc Testnet only/i);
    assert.match(contents, /no Arc mainnet|has not launched (?:one|a mainnet)/i);

    // The Celo mainnet deployment belongs to the sibling repository. Its
    // evidence must never be pasted here and read as Arc evidence.
    for (const celoEvidence of [
      /0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121/i,
      /0x7e1d7834e57f9e16393329ba37a7c5e7a39f6735/i,
      /celo_442daeb34ae2/,
      /0x900a9cfe473ed82ae15b343a9ca9b6a9919542fa84f83be97b3a934d32a1940f/,
      /0x8820bf87809243afdf028949e30c84abd89b06b388a3b32f762e54bce450a716/,
      /8004scan\.io\/agents\/celo/,
    ]) {
      assert.doesNotMatch(contents, celoEvidence, "Celo deployment evidence must not appear in the Arc README");
    }

    // The fork lineage stays acknowledged so the inherited Celo code is explained.
    assert.match(contents, /isolated fork|inherited/i);
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

  it("keeps the Arc x402 buyer path documented on the public Arc docs", async () => {
    for (const file of ["README.md", "packages/cli/README.md"]) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /search_paid_services/, `${file} must describe paid-service discovery`);
      assert.match(contents, /inspect_paid_service/, `${file} must describe quote inspection`);
      assert.match(contents, /pay_paid_service/, `${file} must describe the buyer execution tool`);
      assert.match(contents, /circle services pay/, `${file} must name the Agent Wallet buyer command`);
      assert.match(contents, /Arcscan/i, `${file} must describe onchain proof links`);
      assert.doesNotMatch(
        contents,
        /GatewayClient|BatchEvmScheme/,
        `${file} must not put the EOA-only buyer SDK in the Agent Wallet path`,
      );
    }
  });

  it("keeps the Arc Circle Agent Wallet contract in every installed instruction file", async () => {
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

      assert.match(contents, /setup_agent_wallet/, `${file} must describe Agent Wallet setup`);
      assert.match(contents, /get_agent_budget/, `${file} must describe the autonomous budget read`);
      assert.match(contents, /ARC-TESTNET/, `${file} must pin the Circle chain`);
      assert.match(
        contents,
        /do not ask the user to choose mainnet versus testnet/i,
        `${file} must not offer a network choice for Agent Wallet tools`,
      );
      assert.match(contents, /READY/, `${file} must gate on the READY session state`);
      assert.match(
        contents,
        /never automate|remain manual|manual (?:local-terminal )?actions/i,
        `${file} must keep Circle login, Terms, and OTP manual`,
      );
      assert.match(
        contents,
        /18-decimal[\s\S]{0,80}(?:six|6)-decimal|(?:six|6)-decimal[\s\S]{0,80}18-decimal/i,
        `${file} must warn about the Arc native vs ERC-20 decimal views`,
      );
      assert.match(
        contents,
        /(?:not sum|never sum|without summing)/i,
        `${file} must forbid summing the two Arc USDC views`,
      );
    }
  });

  // Legacy Celo-shaped surfaces that this Arc migration has not rewritten yet.
  // The central MCP server still registers the Celo owner-signature tool flow,
  // so these files stay under their original contract until that is migrated.
  it("keeps x402 instructions on the AgentPay receipt-proof retry flow", async () => {
    const files = [
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
