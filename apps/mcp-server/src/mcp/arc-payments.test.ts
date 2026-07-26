import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  registerArcPaymentMcpTools,
  type ArcPaymentMcpDependencies,
  type ArcPaymentMcpServer,
} from "./arc-payments.ts";

describe("registerArcPaymentMcpTools", () => {
  it("registers and invokes all six isolated Arc payment tools", async () => {
    const registrations = new Map<
      string,
      { metadata: Record<string, unknown>; handler: (input: unknown) => Promise<unknown> }
    >();
    const server: ArcPaymentMcpServer = {
      registerTool(name, metadata, handler) {
        registrations.set(name, { metadata, handler });
      },
    };
    const calls: Array<[string, unknown]> = [];
    const handler = (name: string) => async (input: unknown) => {
      calls.push([name, input]);
      return { status: "OK", tool: name };
    };
    const dependencies: ArcPaymentMcpDependencies = {
      sendUsdc: handler("send_usdc"),
      createPaymentRequest: handler("create_payment_request"),
      payInvoice: handler("pay_invoice"),
      batchPayout: handler("batch_payout"),
      listAgentActivity: handler("list_agent_activity"),
      getPaymentReceipt: handler("get_payment_receipt"),
    };

    registerArcPaymentMcpTools(server, dependencies);

    const expectedNames = [
      "send_usdc",
      "create_payment_request",
      "pay_invoice",
      "batch_payout",
      "list_agent_activity",
      "get_payment_receipt",
    ];
    assert.deepEqual([...registrations.keys()], expectedNames);
    for (const name of expectedNames) {
      const registration = registrations.get(name);
      assert.ok(registration);
      assert.equal(typeof registration.metadata.inputSchema, "object");
      const result = await registration.handler({ invocation: name });
      assert.deepEqual(result, {
        content: [{ type: "text", text: JSON.stringify({ status: "OK", tool: name }, null, 2) }],
        structuredContent: { status: "OK", tool: name },
      });
    }
    assert.deepEqual(calls.map(([name]) => name), expectedNames);
  });
});
