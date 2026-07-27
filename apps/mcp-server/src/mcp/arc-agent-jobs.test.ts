import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  arcAgentJobMcpToolNames,
  registerArcAgentJobMcpTools,
  type ArcAgentJobMcpDependencies,
  type ArcAgentJobMcpServer,
} from "./arc-agent-jobs.ts";

interface Registered {
  readonly name: string;
  readonly metadata: Record<string, unknown>;
  readonly handler: (input: unknown) => Promise<{ content: unknown; structuredContent?: unknown }>;
}

function harness(overrides: Partial<ArcAgentJobMcpDependencies> = {}) {
  const registered: Registered[] = [];
  const calls: Array<{ dependency: string; input: unknown }> = [];

  const stub =
    (dependency: string) =>
    async (input: unknown) => {
      calls.push({ dependency, input });
      return { ok: dependency };
    };

  const server: ArcAgentJobMcpServer = {
    registerTool: (name, metadata, handler) => {
      registered.push({ name, metadata, handler });
    },
  };

  const dependencies: ArcAgentJobMcpDependencies = {
    createAgentJob: stub("createAgentJob"),
    setAgentJobBudget: stub("setAgentJobBudget"),
    fundAgentJob: stub("fundAgentJob"),
    submitAgentDeliverable: stub("submitAgentDeliverable"),
    completeAgentJob: stub("completeAgentJob"),
    rejectAgentJob: stub("rejectAgentJob"),
    getAgentJob: stub("getAgentJob"),
    ...overrides,
  };

  registerArcAgentJobMcpTools(server, dependencies);
  return { registered, calls };
}

describe("Arc agent job MCP registration", () => {
  it("registers exactly the seven assigned tools, in lifecycle order", () => {
    const { registered } = harness();

    assert.deepEqual(
      registered.map((entry) => entry.name),
      [
        "create_agent_job",
        "set_agent_job_budget",
        "fund_agent_job",
        "submit_agent_deliverable",
        "complete_agent_job",
        "reject_agent_job",
        "get_agent_job",
      ],
    );
    assert.deepEqual([...arcAgentJobMcpToolNames], registered.map((entry) => entry.name));
  });

  it("carries a title, description, and input schema into the registration", () => {
    const { registered } = harness();

    for (const entry of registered) {
      assert.equal(typeof entry.metadata.title, "string");
      assert.ok((entry.metadata.title as string).length > 0, `${entry.name} needs a title`);
      assert.ok((entry.metadata.description as string).length > 0, `${entry.name} needs a description`);
      assert.equal((entry.metadata.inputSchema as { type?: string }).type, "object");
    }
  });

  it("routes each tool to its own dependency and never crosses them", async () => {
    const { registered, calls } = harness();

    for (const entry of registered) {
      await entry.handler({ probe: entry.name });
    }

    assert.deepEqual(
      calls.map((call) => call.dependency),
      [
        "createAgentJob",
        "setAgentJobBudget",
        "fundAgentJob",
        "submitAgentDeliverable",
        "completeAgentJob",
        "rejectAgentJob",
        "getAgentJob",
      ],
    );
  });

  it("returns the handler result as both structured content and JSON text", async () => {
    const { registered } = harness();
    const result = await registered[0]!.handler({});

    assert.deepEqual(result.structuredContent, { ok: "createAgentJob" });
    assert.deepEqual(result.content, [{ type: "text", text: '{"ok":"createAgentJob"}' }]);
  });

  it("passes caller input through untouched", async () => {
    const { registered, calls } = harness();
    const input = Object.freeze({ jobId: "7", expectedBudget: "25.000000" });

    await registered.find((entry) => entry.name === "fund_agent_job")!.handler(input);

    assert.deepEqual(calls[0]!.input, input);
  });

  it("propagates a handler failure instead of reporting a successful tool result", async () => {
    const { registered } = harness({
      fundAgentJob: async () => {
        throw new Error("budget changed");
      },
    });

    await assert.rejects(
      registered.find((entry) => entry.name === "fund_agent_job")!.handler({}),
      /budget changed/,
    );
  });
});
