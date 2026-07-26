import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as agentPay from "./index.ts";

describe("published MCP server API", () => {
  it("does not expose production readiness test seams", () => {
    assert.equal("resolveProductionReadiness" in agentPay, false);
    assert.equal("shouldVerifyMainnetAccountAtStartup" in agentPay, false);
  });

  it("exports the isolated Arc payment registrar, tools, and tenant repository factory", () => {
    for (const exportName of [
      "registerArcPaymentMcpTools",
      "createTenantArcPaymentRepositories",
    ]) {
      assert.equal(typeof agentPay[exportName as keyof typeof agentPay], "function", exportName);
    }
    for (const exportName of [
      "sendUsdcTool",
      "createPaymentRequestTool",
      "payInvoiceTool",
      "batchPayoutTool",
      "listAgentActivityTool",
      "getPaymentReceiptTool",
    ]) {
      assert.equal(typeof agentPay[exportName as keyof typeof agentPay], "object", exportName);
    }
  });
});
