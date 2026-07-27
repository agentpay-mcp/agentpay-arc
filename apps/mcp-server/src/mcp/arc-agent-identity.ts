import {
  getAgentIdentityTool,
  getAgentTrustTool,
  giveAgentFeedbackTool,
  registerAgentIdentityTool,
  requestAgentValidationTool,
  respondAgentValidationTool,
} from "../tools/arc-agent-identity.ts";

export interface ArcAgentIdentityMcpToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
}

export interface ArcAgentIdentityMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<ArcAgentIdentityMcpToolResult>,
  ): void;
}

export interface ArcAgentIdentityMcpDependencies {
  readonly registerAgentIdentity: (input: unknown) => Promise<unknown>;
  readonly getAgentIdentity: (input: unknown) => Promise<unknown>;
  readonly giveAgentFeedback: (input: unknown) => Promise<unknown>;
  readonly requestAgentValidation: (input: unknown) => Promise<unknown>;
  readonly respondAgentValidation: (input: unknown) => Promise<unknown>;
  readonly getAgentTrust: (input: unknown) => Promise<unknown>;
}

const registrations = [
  {
    title: "Register Agent Identity",
    tool: registerAgentIdentityTool,
    dependency: "registerAgentIdentity",
  },
  {
    title: "Get Agent Identity",
    tool: getAgentIdentityTool,
    dependency: "getAgentIdentity",
  },
  {
    title: "Give Agent Feedback",
    tool: giveAgentFeedbackTool,
    dependency: "giveAgentFeedback",
  },
  {
    title: "Request Agent Validation",
    tool: requestAgentValidationTool,
    dependency: "requestAgentValidation",
  },
  {
    title: "Respond Agent Validation",
    tool: respondAgentValidationTool,
    dependency: "respondAgentValidation",
  },
  {
    title: "Get Agent Trust",
    tool: getAgentTrustTool,
    dependency: "getAgentTrust",
  },
] as const;

export function registerArcAgentIdentityMcpTools(
  server: ArcAgentIdentityMcpServer,
  dependencies: ArcAgentIdentityMcpDependencies,
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
