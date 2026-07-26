import {
  batchPayoutTool,
  sendUsdcTool,
} from "../tools/arc-payments.ts";
import {
  createPaymentRequestTool,
  payInvoiceTool,
} from "../tools/invoice.ts";
import {
  getPaymentReceiptTool,
  listAgentActivityTool,
} from "../tools/payment-tracking.ts";

export interface ArcPaymentMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ArcPaymentMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<ArcPaymentMcpToolResult>,
  ): void;
}

export interface ArcPaymentMcpDependencies {
  readonly sendUsdc: (input: unknown) => Promise<unknown>;
  readonly createPaymentRequest: (input: unknown) => Promise<unknown>;
  readonly payInvoice: (input: unknown) => Promise<unknown>;
  readonly batchPayout: (input: unknown) => Promise<unknown>;
  readonly listAgentActivity: (input: unknown) => Promise<unknown>;
  readonly getPaymentReceipt: (input: unknown) => Promise<unknown>;
}

const registrations = [
  {
    title: "Send USDC",
    tool: sendUsdcTool,
    dependency: "sendUsdc",
  },
  {
    title: "Create Payment Request",
    tool: createPaymentRequestTool,
    dependency: "createPaymentRequest",
  },
  {
    title: "Pay Invoice",
    tool: payInvoiceTool,
    dependency: "payInvoice",
  },
  {
    title: "Batch Payout",
    tool: batchPayoutTool,
    dependency: "batchPayout",
  },
  {
    title: "List Agent Activity",
    tool: listAgentActivityTool,
    dependency: "listAgentActivity",
  },
  {
    title: "Get Payment Receipt",
    tool: getPaymentReceiptTool,
    dependency: "getPaymentReceipt",
  },
] as const;

export function registerArcPaymentMcpTools(
  server: ArcPaymentMcpServer,
  dependencies: ArcPaymentMcpDependencies,
): void {
  for (const registration of registrations) {
    server.registerTool(
      registration.tool.name,
      {
        title: registration.title,
        description: registration.tool.description,
        inputSchema: registration.tool.inputSchema,
      },
      async (input) =>
        toMcpResult(await dependencies[registration.dependency](input)),
    );
  }
}

function toMcpResult(output: unknown): ArcPaymentMcpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}
