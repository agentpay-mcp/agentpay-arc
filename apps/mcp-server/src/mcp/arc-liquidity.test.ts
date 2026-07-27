import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  registerArcLiquidityMcpTools,
  type ArcLiquidityMcpServer,
} from "./arc-liquidity.ts";

describe("Arc liquidity MCP registrar", () => {
  it("registers all five liquidity tools with structured and text output", async () => {
    const registered = new Map<string, {
      metadata: Record<string, unknown>;
      handler: (input: unknown) => Promise<unknown>;
    }>();
    const server: ArcLiquidityMcpServer = {
      registerTool(name, metadata, handler) {
        registered.set(name, { metadata, handler });
      },
    };
    registerArcLiquidityMcpTools(server, {
      getUnifiedBalance: async (input) => ({ action: "balance", input }),
      fundFromAnyChain: async (input) => ({ action: "fund", input }),
      bridgeUsdc: async (input) => ({ action: "bridge", input }),
      swapTokens: async (input) => ({ action: "swap", input }),
      swapAndPay: async (input) => ({ action: "swap-and-pay", input }),
    });

    assert.deepEqual([...registered.keys()], [
      "get_unified_balance",
      "fund_from_any_chain",
      "bridge_usdc",
      "swap_tokens",
      "swap_and_pay",
    ]);
    for (const registration of registered.values()) {
      assert.equal(typeof registration.metadata.title, "string");
      assert.equal(typeof registration.metadata.description, "string");
      assert.equal(typeof registration.metadata.inputSchema, "object");
    }
    const output = await registered.get("swap_and_pay")!.handler({ idempotencyKey: "id" }) as {
      content: readonly { type: string; text: string }[];
      structuredContent: unknown;
    };
    assert.deepEqual(output.structuredContent, {
      action: "swap-and-pay",
      input: { idempotencyKey: "id" },
    });
    assert.match(output.content[0]!.text, /swap-and-pay/);
  });
});
