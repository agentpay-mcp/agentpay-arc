import {
  bridgeUsdcTool,
  fundFromAnyChainTool,
  getUnifiedBalanceTool,
  swapAndPayTool,
  swapTokensTool,
} from "../tools/arc-liquidity-definitions.ts";

export interface ArcLiquidityMcpToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
}

export interface ArcLiquidityMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<ArcLiquidityMcpToolResult>,
  ): void;
}

export interface ArcLiquidityMcpDependencies {
  readonly getUnifiedBalance: (input: unknown) => Promise<unknown>;
  readonly fundFromAnyChain: (input: unknown) => Promise<unknown>;
  readonly bridgeUsdc: (input: unknown) => Promise<unknown>;
  readonly swapTokens: (input: unknown) => Promise<unknown>;
  readonly swapAndPay: (input: unknown) => Promise<unknown>;
}

const registrations = [
  {
    title: "Get Unified Balance",
    tool: getUnifiedBalanceTool,
    dependency: "getUnifiedBalance",
  },
  {
    title: "Fund From Any Chain",
    tool: fundFromAnyChainTool,
    dependency: "fundFromAnyChain",
  },
  {
    title: "Bridge USDC",
    tool: bridgeUsdcTool,
    dependency: "bridgeUsdc",
  },
  {
    title: "Swap Tokens",
    tool: swapTokensTool,
    dependency: "swapTokens",
  },
  {
    title: "Swap And Pay",
    tool: swapAndPayTool,
    dependency: "swapAndPay",
  },
] as const;

export function registerArcLiquidityMcpTools(
  server: ArcLiquidityMcpServer,
  dependencies: ArcLiquidityMcpDependencies,
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
