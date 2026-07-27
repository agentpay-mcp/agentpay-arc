import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  registerArcAgentIdentityMcpTools,
  type ArcAgentIdentityMcpServer,
} from "./arc-agent-identity.ts";

describe("Arc agent identity MCP registrar", () => {
  it("registers six tools with structured and text output", async () => {
    const registered = new Map<string, {
      metadata: Record<string, unknown>;
      handler: (input: unknown) => Promise<unknown>;
    }>();
    const server: ArcAgentIdentityMcpServer = {
      registerTool(name, metadata, handler) {
        registered.set(name, { metadata, handler });
      },
    };
    registerArcAgentIdentityMcpTools(server, {
      registerAgentIdentity: async (input) => ({ action: "register", input }),
      getAgentIdentity: async (input) => ({ action: "identity", input }),
      giveAgentFeedback: async (input) => ({ action: "feedback", input }),
      requestAgentValidation: async (input) => ({ action: "request", input }),
      respondAgentValidation: async (input) => ({ action: "response", input }),
      getAgentTrust: async (input) => ({ action: "trust", input }),
    });

    assert.deepEqual([...registered.keys()], [
      "register_agent_identity",
      "get_agent_identity",
      "give_agent_feedback",
      "request_agent_validation",
      "respond_agent_validation",
      "get_agent_trust",
    ]);
    for (const registration of registered.values()) {
      assert.equal(typeof registration.metadata.title, "string");
      assert.equal(typeof registration.metadata.description, "string");
      assert.equal(typeof registration.metadata.inputSchema, "object");
    }
    const result = await registered.get("get_agent_trust")!.handler({ agentId: "42" }) as {
      content: readonly { type: string; text: string }[];
      structuredContent: unknown;
    };
    assert.deepEqual(result.structuredContent, {
      action: "trust",
      input: { agentId: "42" },
    });
    assert.match(result.content[0]!.text, /"action": "trust"/);
  });
});
