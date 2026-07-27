import {
  completeAgentJobTool,
  createAgentJobTool,
  fundAgentJobTool,
  getAgentJobTool,
  rejectAgentJobTool,
  setAgentJobBudgetTool,
  submitAgentDeliverableTool,
} from "../tools/arc-agent-jobs.ts";

export interface ArcAgentJobMcpToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
}

export interface ArcAgentJobMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<ArcAgentJobMcpToolResult>,
  ): void;
}

export interface ArcAgentJobMcpDependencies {
  readonly createAgentJob: (input: unknown) => Promise<unknown>;
  readonly setAgentJobBudget: (input: unknown) => Promise<unknown>;
  readonly fundAgentJob: (input: unknown) => Promise<unknown>;
  readonly submitAgentDeliverable: (input: unknown) => Promise<unknown>;
  readonly completeAgentJob: (input: unknown) => Promise<unknown>;
  readonly rejectAgentJob: (input: unknown) => Promise<unknown>;
  readonly getAgentJob: (input: unknown) => Promise<unknown>;
}

const registrations = [
  { title: "Create Agent Job", tool: createAgentJobTool, dependency: "createAgentJob" },
  { title: "Set Agent Job Budget", tool: setAgentJobBudgetTool, dependency: "setAgentJobBudget" },
  { title: "Fund Agent Job", tool: fundAgentJobTool, dependency: "fundAgentJob" },
  {
    title: "Submit Agent Deliverable",
    tool: submitAgentDeliverableTool,
    dependency: "submitAgentDeliverable",
  },
  { title: "Complete Agent Job", tool: completeAgentJobTool, dependency: "completeAgentJob" },
  { title: "Reject Agent Job", tool: rejectAgentJobTool, dependency: "rejectAgentJob" },
  { title: "Get Agent Job", tool: getAgentJobTool, dependency: "getAgentJob" },
] as const satisfies readonly {
  readonly title: string;
  readonly tool: { readonly name: string; readonly description: string; readonly inputSchema: unknown };
  readonly dependency: keyof ArcAgentJobMcpDependencies;
}[];

/**
 * Isolated registrar for the ERC-8183 job tools.
 *
 * The integrator calls this from the central MCP server; nothing here reaches
 * into `agentpay-mcp.ts` or the runtime. Handler output is returned both as
 * `structuredContent` and as a JSON text block, matching the shape the other
 * Arc tool surfaces already use.
 */
export function registerArcAgentJobMcpTools(
  server: ArcAgentJobMcpServer,
  dependencies: ArcAgentJobMcpDependencies,
): void {
  for (const registration of registrations) {
    const handler = dependencies[registration.dependency];

    server.registerTool(
      registration.tool.name,
      {
        title: registration.title,
        description: registration.tool.description,
        inputSchema: registration.tool.inputSchema,
      },
      async (input: unknown) => {
        const result = await handler(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
  }
}

export const arcAgentJobMcpToolNames = Object.freeze(
  registrations.map((registration) => registration.tool.name),
);
