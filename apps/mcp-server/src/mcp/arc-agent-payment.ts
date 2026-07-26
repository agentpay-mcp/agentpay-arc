import {
  inspectPaidServiceTool,
  payPaidServiceTool,
  searchPaidServicesTool,
} from "../tools/circle-services.ts";

export interface ArcAgentPaymentMcpToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
}

export interface ArcAgentPaymentMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<ArcAgentPaymentMcpToolResult>,
  ): void;
}

export interface ArcAgentPaymentMcpDependencies {
  readonly searchPaidServices: (input: unknown) => Promise<unknown>;
  readonly inspectPaidService: (input: unknown) => Promise<unknown>;
  readonly payPaidService: (input: unknown) => Promise<unknown>;
}

const registrations = [
  {
    title: "Search Paid Services",
    tool: searchPaidServicesTool,
    dependency: "searchPaidServices",
  },
  {
    title: "Inspect Paid Service",
    tool: inspectPaidServiceTool,
    dependency: "inspectPaidService",
  },
  {
    title: "Pay Paid Service",
    tool: payPaidServiceTool,
    dependency: "payPaidService",
  },
] as const;

export function registerArcAgentPaymentMcpTools(
  server: ArcAgentPaymentMcpServer,
  dependencies: ArcAgentPaymentMcpDependencies,
): void {
  for (const registration of registrations) {
    server.registerTool(
      registration.tool.name,
      {
        title: registration.title,
        description: registration.tool.description,
        inputSchema: registration.tool.inputSchema,
      },
      async (input) => {
        const output = await dependencies[registration.dependency](input);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      },
    );
  }
}
