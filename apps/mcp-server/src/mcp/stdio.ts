import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  createAgentPayRuntime,
  parseAgentPayEnv,
  type AgentPayRuntime,
  type AgentPayRuntimeConfig,
} from "../runtime/agentpay-runtime.ts";
import { createDefaultArcAgentWalletRuntime } from "../runtime/default-arc-agent-wallet-runtime.ts";
import { createCircleCli } from "../services/circle-cli.ts";
import {
  createFundAgentWalletHandler,
  createGetAgentBudgetHandler,
  createSetupAgentWalletHandler,
  createWithdrawAgentBudgetHandler,
} from "../tools/circle-agent-wallet.ts";
import {
  type AgentPayMcpRegistrationOptions,
  type AgentPayMcpServer,
  type ArcAgentWalletMcpRuntime,
  type CircleAgentWalletMcpRuntime,
  registerAgentPayMcpTools,
  registerArcAgentWalletMcpTools,
  registerCircleAgentWalletMcpTools,
} from "./agentpay-mcp.ts";

export interface ConnectableAgentPayMcpServer extends AgentPayMcpServer {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface AgentPayMcpConnection {
  connect(transport: unknown): Promise<void>;
}

export interface StartAgentPayMcpServerOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createRuntime?: (config: AgentPayRuntimeConfig) => AgentPayRuntime;
  createServer?: (runtime: AgentPayRuntime) => AgentPayMcpConnection;
  createTransport?: () => unknown;
}

export interface StartCircleAgentWalletMcpServerOptions {
  createRuntime?: () => CircleAgentWalletMcpRuntime;
  createServer?: (runtime: CircleAgentWalletMcpRuntime) => AgentPayMcpConnection;
  createTransport?: () => unknown;
}

export interface StartArcAgentWalletMcpServerOptions {
  createRuntime?: () => ArcAgentWalletMcpRuntime;
  createServer?: (runtime: ArcAgentWalletMcpRuntime) => AgentPayMcpConnection;
  createTransport?: () => unknown;
}

export function createAgentPayMcpServer(runtime: AgentPayRuntime): ConnectableAgentPayMcpServer;
export function createAgentPayMcpServer(
  runtime: AgentPayRuntime,
  createServer: undefined,
  options?: AgentPayMcpRegistrationOptions,
): ConnectableAgentPayMcpServer;
export function createAgentPayMcpServer<TServer extends AgentPayMcpServer>(
  runtime: AgentPayRuntime,
  createServer: () => TServer,
  options?: AgentPayMcpRegistrationOptions,
): TServer;
export function createAgentPayMcpServer<TServer extends AgentPayMcpServer>(
  runtime: AgentPayRuntime,
  createServer: () => TServer = createSdkMcpServer as unknown as () => TServer,
  options: AgentPayMcpRegistrationOptions = {},
): TServer | ConnectableAgentPayMcpServer {
  const server = createServer();
  registerAgentPayMcpTools(server, runtime, options);
  return server;
}

export async function startAgentPayMcpServer(options: StartAgentPayMcpServerOptions = {}): Promise<void> {
  const config = parseAgentPayEnv(options.env ?? process.env);
  if (config.environment === "production") {
    throw new Error("Production MCP stdio is disabled; use the readiness-gated HTTP surface.");
  }
  const runtime = options.createRuntime ? options.createRuntime(config) : createAgentPayRuntime(config);
  const server = options.createServer ? options.createServer(runtime) : createAgentPayMcpServer(runtime, createSdkMcpServer);
  const transport = options.createTransport ? options.createTransport() : new StdioServerTransport();

  await server.connect(transport);
}

export function createCircleAgentWalletMcpRuntime(): CircleAgentWalletMcpRuntime {
  const circleCli = createCircleCli();
  return {
    setupAgentWallet: createSetupAgentWalletHandler({ circleCli }),
    getAgentBudget: createGetAgentBudgetHandler({ circleCli }),
    fundAgentWallet: createFundAgentWalletHandler({ circleCli }),
    withdrawAgentBudget: createWithdrawAgentBudgetHandler({ circleCli }),
  };
}

export function createCircleAgentWalletMcpServer(
  runtime: CircleAgentWalletMcpRuntime,
): ConnectableAgentPayMcpServer;
export function createCircleAgentWalletMcpServer<TServer extends AgentPayMcpServer>(
  runtime: CircleAgentWalletMcpRuntime,
  createServer: () => TServer,
): TServer;
export function createCircleAgentWalletMcpServer<TServer extends AgentPayMcpServer>(
  runtime: CircleAgentWalletMcpRuntime,
  createServer: () => TServer = createCircleWalletSdkMcpServer as unknown as () => TServer,
): TServer | ConnectableAgentPayMcpServer {
  const server = createServer();
  registerCircleAgentWalletMcpTools(server, runtime);
  return server;
}

export function createArcAgentWalletMcpServer(
  runtime: ArcAgentWalletMcpRuntime,
): ConnectableAgentPayMcpServer;
export function createArcAgentWalletMcpServer<TServer extends AgentPayMcpServer>(
  runtime: ArcAgentWalletMcpRuntime,
  createServer: () => TServer,
): TServer;
export function createArcAgentWalletMcpServer<TServer extends AgentPayMcpServer>(
  runtime: ArcAgentWalletMcpRuntime,
  createServer: () => TServer = createCircleWalletSdkMcpServer as unknown as () => TServer,
): TServer | ConnectableAgentPayMcpServer {
  const server = createServer();
  registerArcAgentWalletMcpTools(server, runtime);
  return server;
}

export async function startCircleAgentWalletMcpServer(
  options: StartCircleAgentWalletMcpServerOptions = {},
): Promise<void> {
  const runtime = options.createRuntime
    ? options.createRuntime()
    : createCircleAgentWalletMcpRuntime();
  const server = options.createServer
    ? options.createServer(runtime)
    : createCircleAgentWalletMcpServer(runtime, createCircleWalletSdkMcpServer);
  const transport = options.createTransport
    ? options.createTransport()
    : new StdioServerTransport();

  await server.connect(transport);
}

export async function startArcAgentWalletMcpServer(
  options: StartArcAgentWalletMcpServerOptions = {},
): Promise<void> {
  const runtime = options.createRuntime
    ? options.createRuntime()
    : createDefaultArcAgentWalletRuntime();
  const server = options.createServer
    ? options.createServer(runtime)
    : createArcAgentWalletMcpServer(runtime, createCircleWalletSdkMcpServer);
  const transport = options.createTransport
    ? options.createTransport()
    : new StdioServerTransport();

  await server.connect(transport);
}

function createSdkMcpServer(): ConnectableAgentPayMcpServer {
  return createSchemaCompatibleSdkMcpServer("agentpay");
}

function createCircleWalletSdkMcpServer(): ConnectableAgentPayMcpServer {
  return createSchemaCompatibleSdkMcpServer("agentpay-wallet");
}

function createSchemaCompatibleSdkMcpServer(
  name: string,
): ConnectableAgentPayMcpServer {
  const sdkServer = new McpServer({
    name,
    version: "0.1.1",
  });

  return {
    registerTool(toolName, metadata, handler) {
      sdkServer.registerTool(
        toolName,
        {
          ...(typeof metadata.title === "string"
            ? { title: metadata.title }
            : {}),
          ...(typeof metadata.description === "string"
            ? { description: metadata.description }
            : {}),
          inputSchema: normalizeMcpInputSchema(metadata.inputSchema),
        },
        async (input: unknown) => (await handler(input)) as CallToolResult,
      );
    },
    async connect(transport) {
      await sdkServer.connect(
        transport as Parameters<McpServer["connect"]>[0],
      );
    },
    async close() {
      await sdkServer.close();
    },
  };
}

function normalizeMcpInputSchema(inputSchema: unknown) {
  if (inputSchema === undefined || inputSchema instanceof z.ZodType) {
    return inputSchema;
  }
  if (isZodRawShape(inputSchema)) {
    return inputSchema;
  }
  return z.fromJSONSchema(
    inputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
}

function isZodRawShape(
  value: unknown,
): value is Record<string, z.ZodType> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fields = Object.values(value);
  return fields.length === 0 || fields.every((field) => field instanceof z.ZodType);
}
