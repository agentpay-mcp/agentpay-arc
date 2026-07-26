import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  registerArcAgentPaymentMcpTools,
  type ArcAgentPaymentMcpDependencies,
  type ArcAgentPaymentMcpServer,
} from "./arc-agent-payment.ts";

describe("Arc agent commerce MCP registrar", () => {
  it("registers only the isolated search, inspect, and autonomous pay tools", async () => {
    const registrations = new Map<string, (input: unknown) => Promise<unknown>>();
    const server: ArcAgentPaymentMcpServer = {
      registerTool(name, metadata, handler) {
        assert.equal(typeof metadata.inputSchema, "object");
        registrations.set(name, handler);
      },
    };
    const calls: string[] = [];
    const dependencies: ArcAgentPaymentMcpDependencies = {
      searchPaidServices: async () => (calls.push("search"), { services: [] }),
      inspectPaidService: async () => (calls.push("inspect"), { quote: {} }),
      payPaidService: async () => (calls.push("pay"), { receipt: {} }),
    };

    registerArcAgentPaymentMcpTools(server, dependencies);

    assert.deepEqual([...registrations.keys()], [
      "search_paid_services",
      "inspect_paid_service",
      "pay_paid_service",
    ]);
    const output = await registrations.get("pay_paid_service")!({ id: "input" }) as {
      structuredContent: unknown;
      content: Array<{ text: string }>;
    };
    assert.deepEqual(calls, ["pay"]);
    assert.deepEqual(output.structuredContent, { receipt: {} });
    assert.match(output.content[0]!.text, /receipt/);
  });
});
