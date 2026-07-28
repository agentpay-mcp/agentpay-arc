import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  registerAgentPayMcpTools,
  registerArcAgentWalletMcpTools,
  type AgentPayMcpServer,
  type ArcAgentWalletMcpRuntime,
} from "./agentpay-mcp.ts";
import { createSessionContext } from "@agentpay-ai/shared-arc";
import type { AgentPayRuntime } from "../runtime/agentpay-runtime.ts";

class FakeMcpServer implements AgentPayMcpServer {
  readonly tools = new Map<
    string,
    {
      readonly metadata: Record<string, unknown>;
      readonly handler: (input: unknown) => Promise<unknown>;
    }
  >();

  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<unknown>,
  ): void {
    this.tools.set(name, { metadata, handler });
  }
}

const expectedLocalArcTools = [
  "setup_agent_wallet",
  "get_agent_budget",
  "fund_agent_wallet",
  "withdraw_agent_budget",
  "send_usdc",
  "create_payment_request",
  "pay_invoice",
  "batch_payout",
  "list_agent_activity",
  "get_payment_receipt",
  "search_paid_services",
  "inspect_paid_service",
  "pay_paid_service",
  "get_unified_balance",
  "fund_from_any_chain",
  "bridge_usdc",
  "swap_tokens",
  "swap_and_pay",
  "register_agent_identity",
  "get_agent_identity",
  "give_agent_feedback",
  "request_agent_validation",
  "respond_agent_validation",
  "get_agent_trust",
  "create_agent_job",
  "set_agent_job_budget",
  "fund_agent_job",
  "submit_agent_deliverable",
  "complete_agent_job",
  "reject_agent_job",
  "get_agent_job",
] as const;

describe("registerArcAgentWalletMcpTools", () => {
  it("wires every reviewed Arc feature registrar into the local wallet MCP", async () => {
    const server = new FakeMcpServer();
    const calls: Array<{ readonly tool: string; readonly input: unknown }> = [];
    const runtime = Object.fromEntries(
      [
        ["setupAgentWallet", "setup_agent_wallet"],
        ["getAgentBudget", "get_agent_budget"],
        ["fundAgentWallet", "fund_agent_wallet"],
        ["withdrawAgentBudget", "withdraw_agent_budget"],
        ["sendUsdc", "send_usdc"],
        ["createPaymentRequest", "create_payment_request"],
        ["payInvoice", "pay_invoice"],
        ["batchPayout", "batch_payout"],
        ["listAgentActivity", "list_agent_activity"],
        ["getPaymentReceipt", "get_payment_receipt"],
        ["searchPaidServices", "search_paid_services"],
        ["inspectPaidService", "inspect_paid_service"],
        ["payPaidService", "pay_paid_service"],
        ["getUnifiedBalance", "get_unified_balance"],
        ["fundFromAnyChain", "fund_from_any_chain"],
        ["bridgeUsdc", "bridge_usdc"],
        ["swapTokens", "swap_tokens"],
        ["swapAndPay", "swap_and_pay"],
        ["registerAgentIdentity", "register_agent_identity"],
        ["getAgentIdentity", "get_agent_identity"],
        ["giveAgentFeedback", "give_agent_feedback"],
        ["requestAgentValidation", "request_agent_validation"],
        ["respondAgentValidation", "respond_agent_validation"],
        ["getAgentTrust", "get_agent_trust"],
        ["createAgentJob", "create_agent_job"],
        ["setAgentJobBudget", "set_agent_job_budget"],
        ["fundAgentJob", "fund_agent_job"],
        ["submitAgentDeliverable", "submit_agent_deliverable"],
        ["completeAgentJob", "complete_agent_job"],
        ["rejectAgentJob", "reject_agent_job"],
        ["getAgentJob", "get_agent_job"],
      ].map(([method, tool]) => [
        method,
        async (input: unknown) => {
          calls.push({ tool, input });
          return { tool };
        },
      ]),
    ) as unknown as ArcAgentWalletMcpRuntime;

    registerArcAgentWalletMcpTools(server, runtime);

    assert.deepEqual([...server.tools.keys()], expectedLocalArcTools);
    assert.equal(new Set(server.tools.keys()).size, expectedLocalArcTools.length);

    const result = await server.tools.get("send_usdc")!.handler({ amount: "1" });
    assert.deepEqual(calls, [{ tool: "send_usdc", input: { amount: "1" } }]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      tool: "send_usdc",
    });
  });

  it("keeps the complete local Arc surface off hosted and public MCP registration", () => {
    const runtime = new Proxy({} as AgentPayRuntime, {
      get() {
        return async () => ({ ok: true });
      },
    });
    const consumerServer = new FakeMcpServer();
    registerAgentPayMcpTools(consumerServer, runtime, {
      sessionContext: createSessionContext({
        sessionId: "session_arc_local_boundary",
        tenantId: "11111111-1111-4111-8111-111111111111",
        ownerAddress: "0x1111111111111111111111111111111111111111",
        accountAddress: "0x2222222222222222222222222222222222222222",
        homeChainId: 5_042_002,
        audience: "https://wallet.agentpay.site/arc/mcp",
        scopes: [
          "wallet:read",
          "payment:prepare",
          "payment:read",
          "payment:review",
          "session:manage",
        ],
        authEpoch: 1,
        issuedAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2026-07-28T01:00:00.000Z",
        environment: "staging",
      }),
    });
    for (const tool of expectedLocalArcTools) {
      assert.equal(
        consumerServer.tools.has(tool),
        false,
        `${tool} must stay local to the Circle CLI process`,
      );
    }

    const publicServer = new FakeMcpServer();
    registerAgentPayMcpTools(publicServer, runtime, {
      publicExecutionOnly: true,
    });
    assert.deepEqual([...publicServer.tools.keys()], ["execute_payment"]);
  });
});
