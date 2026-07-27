import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { z } from "zod";

import { assertMainnetCanaryManifest } from "./mainnet-activation-manifest.mjs";
import { computeArtifactDigests } from "./mainnet-shadow-manifest.mjs";

export const MCP_STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const CELO_MAINNET_CHAIN_ID = 42_220;
const CELO_MAINNET_CAIP2 = "eip155:42220";
const CELO_MAINNET_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const CELO_MAINNET_AGENTPAY_ACCOUNT = "0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121";
const CELO_MAINNET_CANARY_PAYER = "0x98802C2d45284F2bcA06BF3d6bdb41221a7Cc5cD";
const X402_MAX_TIMEOUT_SECONDS = 300;
const MAX_RESPONSE_BYTES = 1_048_576;
const CANARY_MANIFEST_PATH = fileURLToPath(
  new URL("../ops/manifests/celo-mainnet.canary.json", import.meta.url),
);
const PRIVATE_KEY_PATTERN = /^0x[a-f0-9]{64}$/i;
const OWNER_SIGNATURE_PATTERN = /^0x[a-f0-9]{130}$/i;
const PAYMENT_INTENT_ID_PATTERN = /^pay_[a-z0-9_-]+$/i;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const TX_HASH_PATTERN = /^0x[a-f0-9]{64}$/i;

const canaryManifestSchema = z.object({
  status: z.literal("READY"),
  environment: z.literal("production"),
  executionMode: z.literal("CANARY"),
  chain: z.object({
    chainId: z.literal(CELO_MAINNET_CHAIN_ID),
    caip2: z.literal(CELO_MAINNET_CAIP2),
  }),
  contract: z.object({
    address: z.literal(CELO_MAINNET_AGENTPAY_ACCOUNT),
  }),
  domains: z.object({
    publicOrigin: z.literal("https://mcp.agentpay.site"),
  }),
  x402: z.object({
    enabled: z.literal(true),
    network: z.literal(CELO_MAINNET_CAIP2),
    tokenAddress: z.literal(CELO_MAINNET_USDC),
    priceAtomic: z.literal("10000"),
    syncSettle: z.literal(true),
  }),
  canaryPolicy: z.object({
    maxAcceptedLifecycles: z.literal(2),
    allowlistedAccountAddress: z.literal(CELO_MAINNET_AGENTPAY_ACCOUNT),
    payerAddress: z.literal(CELO_MAINNET_CANARY_PAYER),
  }),
});

const paymentRequirementSchema = z.object({
  scheme: z.literal("exact"),
  network: z.literal(CELO_MAINNET_CAIP2),
  amount: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  asset: z.string().regex(ADDRESS_PATTERN),
  payTo: z.string().regex(ADDRESS_PATTERN),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({
    assetTransferMethod: z.literal("eip3009"),
  }).passthrough(),
}).passthrough();

const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({
    url: z.string().url(),
  }).passthrough(),
  accepts: z.array(paymentRequirementSchema).length(1),
}).passthrough();

const settlementSchema = z.object({
  success: z.literal(true),
  transaction: z.string().regex(TX_HASH_PATTERN),
  network: z.literal(CELO_MAINNET_CAIP2),
}).passthrough();

const readinessSchema = z.object({
  code: z.literal("READY"),
  mode: z.literal("CANARY"),
  status: z.literal("READY"),
}).passthrough();

export interface ExpectedCanaryPayment {
  resourceUrl: string;
  scheme: "exact";
  network: typeof CELO_MAINNET_CAIP2;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  assetTransferMethod: "eip3009";
}

export interface CanaryPaymentClient {
  readPaymentRequired(response: Response, body: unknown): unknown;
  createPaymentSignature(paymentRequired: PaymentRequired): Promise<string>;
  readSettlement(response: Response): unknown;
}

export interface CanaryMcpRequest {
  jsonrpc: "2.0";
  id: string;
  method: "tools/call";
  params: {
    name: "execute_payment";
    arguments: {
      paymentIntentId: string;
      signature: string;
    };
  };
}

export interface CanaryCliOptions {
  execute: boolean;
  help: boolean;
  paymentIntentId?: string;
}

export interface CanaryPayerSigner {
  address: `0x${string}`;
  signTypedData(input: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export interface CanaryCliDependencies {
  computeArtifactDigests?: typeof computeArtifactDigests;
  createPayerSigner?: (privateKey: string) => CanaryPayerSigner;
  assertPayerPreflight?: typeof assertPayerPreflight;
  runCanary?: typeof runCeloMainnetCanary;
  write?: (message: string) => void;
}

export function buildExecutePaymentMcpRequest(input: {
  paymentIntentId: string;
  signature: string;
}): CanaryMcpRequest {
  if (!PAYMENT_INTENT_ID_PATTERN.test(input.paymentIntentId)) {
    throw new Error("Canary payment intent id is invalid.");
  }
  if (!OWNER_SIGNATURE_PATTERN.test(input.signature)) {
    throw new Error("Canary owner signature must be a 65-byte EIP-712 signature.");
  }

  return Object.freeze({
    jsonrpc: "2.0",
    id: `agentpay-canary:${input.paymentIntentId}`,
    method: "tools/call",
    params: Object.freeze({
      name: "execute_payment",
      arguments: Object.freeze({
        paymentIntentId: input.paymentIntentId,
        signature: input.signature,
      }),
    }),
  });
}

export function buildMcpRequestHeaders(paymentSignature?: string): Readonly<Record<string, string>> {
  if (
    paymentSignature !== undefined &&
    (
      paymentSignature.length === 0 ||
      paymentSignature.length > 16_384 ||
      /[\u0000-\u001f\u007f]/.test(paymentSignature)
    )
  ) {
    throw new Error("The x402 payment signature header is invalid.");
  }

  return Object.freeze({
    accept: MCP_STREAMABLE_HTTP_ACCEPT,
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(paymentSignature ? { "payment-signature": paymentSignature } : {}),
  });
}

export function parseMcpResponseBody(body: string): Record<string, unknown> {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(body));
  } catch {
    for (const line of body.split(/\r?\n/)) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        throw new Error("MCP SSE response contains an invalid JSON data frame.");
      }
    }
  }

  const response = [...candidates].reverse().find(isRecord);
  if (!response) throw new Error("MCP response did not contain a JSON-RPC object.");
  return response;
}

export async function runCeloMainnetCanary(options: {
  mcpUrl: string;
  readinessUrl: string;
  mcpRequest: CanaryMcpRequest;
  expectedPayment: ExpectedCanaryPayment;
  paymentClient: CanaryPaymentClient;
  fetcher?: typeof fetch;
}) {
  assertPinnedHttpsEndpoints(options.mcpUrl, options.readinessUrl);
  const fetcher = options.fetcher ?? fetch;
  const serializedRequest = JSON.stringify(options.mcpRequest);

  const readiness = await fetchWithContext(
    fetcher,
    options.readinessUrl,
    {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
    "AgentPay readiness check",
  );
  if (!readiness.ok) {
    throw new Error(`AgentPay readiness check returned HTTP ${readiness.status}.`);
  }
  readinessSchema.parse(parseJson(await readBoundedText(readiness), "AgentPay readiness response"));

  const challenge = await fetchWithContext(
    fetcher,
    options.mcpUrl,
    {
      method: "POST",
      headers: buildMcpRequestHeaders(),
      body: serializedRequest,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
    "AgentPay x402 challenge",
  );
  const challengeBody = parseOptionalJson(await readBoundedText(challenge));
  if (challenge.status !== 402) {
    throw new Error(`AgentPay x402 challenge returned HTTP ${challenge.status}; no payment was submitted.`);
  }

  const paymentRequired = paymentRequiredSchema.parse(
    options.paymentClient.readPaymentRequired(challenge, challengeBody),
  ) as PaymentRequired;
  assertExpectedPaymentTerms(paymentRequired, options.expectedPayment);
  const paymentSignature = await options.paymentClient.createPaymentSignature(paymentRequired);
  const paidHeaders = buildMcpRequestHeaders(paymentSignature);

  try {
    const paidResponse = await fetchWithContext(
      fetcher,
      options.mcpUrl,
      {
        method: "POST",
        headers: paidHeaders,
        body: serializedRequest,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
      "AgentPay paid MCP request",
    );
    const paidBody = await readBoundedText(paidResponse);
    if (!paidResponse.ok) {
      throw new Error(`AgentPay paid MCP request returned HTTP ${paidResponse.status}.`);
    }

    const mcpResponse = parseMcpResponseBody(paidBody);
    assertSuccessfulMcpResponse(mcpResponse, options.mcpRequest.id);
    const settlement = settlementSchema.parse(options.paymentClient.readSettlement(paidResponse));

    return Object.freeze({
      httpStatus: paidResponse.status,
      mcpResponse: Object.freeze({ ...mcpResponse }),
      settlement: Object.freeze({ ...settlement }),
    });
  } catch {
    throw new Error(
      "AgentPay paid canary outcome is unresolved; inspect the durable lifecycle before retrying.",
    );
  }
}

export function parseCanaryCliArgs(args: string[]): CanaryCliOptions {
  const options: CanaryCliOptions = { execute: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--payment-intent-id") {
      options.paymentIntentId = requireCliValue(args[index + 1], argument);
      index += 1;
    } else if (argument === "--execute-mainnet-canary") {
      options.execute = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${redactCliArgument(argument)}`);
    }
  }

  if (!options.help) {
    if (!options.paymentIntentId || !PAYMENT_INTENT_ID_PATTERN.test(options.paymentIntentId)) {
      throw new Error("--payment-intent-id must be a valid AgentPay payment intent id.");
    }
    if (!options.execute) {
      throw new Error("--execute-mainnet-canary is required before any x402 payment can be signed.");
    }
  }
  return Object.freeze({ ...options });
}

export async function runCanaryCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  dependencies: CanaryCliDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? console.log;
  const cli = parseCanaryCliArgs(args);
  if (cli.help) {
    write(helpText());
    return;
  }

  const rawManifest: unknown = JSON.parse(await readFile(CANARY_MANIFEST_PATH, "utf8"));
  const artifactDigests = await (dependencies.computeArtifactDigests ?? computeArtifactDigests)();
  assertMainnetCanaryManifest(rawManifest, { artifactDigests });
  const manifest = canaryManifestSchema.parse(rawManifest);
  assertManifestBindings(manifest);

  const ownerSignature = requiredEnv(env, "AGENTPAY_CANARY_OWNER_SIGNATURE");
  const payerPrivateKey = requiredEnv(env, "AGENTPAY_CANARY_PAYER_PRIVATE_KEY");
  if (!PRIVATE_KEY_PATTERN.test(payerPrivateKey)) {
    throw new Error("AGENTPAY_CANARY_PAYER_PRIVATE_KEY must be a 32-byte private key.");
  }
  const rpcUrl = requireHttpsUrl(requiredEnv(env, "CELO_MAINNET_RPC_URL"), "CELO_MAINNET_RPC_URL");
  const payerSigner = (dependencies.createPayerSigner ?? createEthersPayerSigner)(payerPrivateKey);
  if (!addressesEqual(payerSigner.address, manifest.canaryPolicy.payerAddress)) {
    throw new Error("Canary payer key does not match the manifest allowlist.");
  }

  await (dependencies.assertPayerPreflight ?? assertPayerPreflight)({
    rpcUrl,
    payerAddress: payerSigner.address,
    accountAddress: manifest.contract.address,
    amountAtomic: BigInt(manifest.x402.priceAtomic),
  });

  const protocolClient = new x402Client();
  registerExactEvmScheme(protocolClient, {
    signer: payerSigner,
    networks: [CELO_MAINNET_CAIP2],
  });
  const httpClient = new x402HTTPClient(protocolClient);
  const publicOrigin = new URL(manifest.domains.publicOrigin);
  const mcpUrl = new URL("/celo/mcp", publicOrigin).href;
  const readinessUrl = new URL("/celo/readyz", publicOrigin).href;

  const result = await (dependencies.runCanary ?? runCeloMainnetCanary)({
    mcpUrl,
    readinessUrl,
    mcpRequest: buildExecutePaymentMcpRequest({
      paymentIntentId: cli.paymentIntentId!,
      signature: ownerSignature,
    }),
    expectedPayment: {
      resourceUrl: mcpUrl,
      scheme: "exact",
      network: CELO_MAINNET_CAIP2,
      amount: manifest.x402.priceAtomic,
      asset: manifest.x402.tokenAddress,
      payTo: manifest.contract.address,
      maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
      assetTransferMethod: "eip3009",
    },
    paymentClient: createX402PaymentClient(httpClient),
  });

  write("Celo mainnet canary completed.");
  write(`Payment intent: ${cli.paymentIntentId}`);
  write(`MCP HTTP status: ${result.httpStatus}`);
  write(`x402 settlement transaction: ${result.settlement.transaction}`);
}

function createEthersPayerSigner(privateKey: string): CanaryPayerSigner {
  const wallet = new Wallet(privateKey);
  return Object.freeze({
    address: wallet.address as `0x${string}`,
    async signTypedData(input: Parameters<CanaryPayerSigner["signTypedData"]>[0]) {
      return await wallet.signTypedData(
        input.domain as TypedDataDomain,
        input.types as Record<string, TypedDataField[]>,
        input.message,
      ) as `0x${string}`;
    },
  });
}

function createX402PaymentClient(httpClient: x402HTTPClient): CanaryPaymentClient {
  return Object.freeze({
    readPaymentRequired(response: Response, body: unknown) {
      return httpClient.getPaymentRequiredResponse(
        (name) => response.headers.get(name),
        body,
      );
    },
    async createPaymentSignature(paymentRequired: PaymentRequired) {
      const payload = await httpClient.createPaymentPayload(paymentRequired);
      const headers = httpClient.encodePaymentSignatureHeader(payload);
      const signature = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "payment-signature",
      )?.[1];
      if (!signature) throw new Error("x402 client did not create a PAYMENT-SIGNATURE header.");
      return signature;
    },
    readSettlement(response: Response): SettleResponse {
      return httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
    },
  });
}

function assertExpectedPaymentTerms(
  paymentRequired: PaymentRequired,
  expected: ExpectedCanaryPayment,
): void {
  const requirement = paymentRequired.accepts[0];
  const comparisons: Array<[string, unknown, unknown, boolean?]> = [
    ["resource.url", paymentRequired.resource.url, expected.resourceUrl],
    ["scheme", requirement.scheme, expected.scheme],
    ["network", requirement.network, expected.network],
    ["amount", requirement.amount, expected.amount],
    ["asset", requirement.asset, expected.asset, true],
    ["payTo", requirement.payTo, expected.payTo, true],
    ["maxTimeoutSeconds", requirement.maxTimeoutSeconds, expected.maxTimeoutSeconds],
    ["assetTransferMethod", requirement.extra.assetTransferMethod, expected.assetTransferMethod],
  ];
  for (const [field, actual, wanted, address] of comparisons) {
    const matches = address && typeof actual === "string" && typeof wanted === "string"
      ? addressesEqual(actual, wanted)
      : actual === wanted;
    if (!matches) throw new Error(`x402 ${field} does not match the frozen canary terms.`);
  }
}

function assertSuccessfulMcpResponse(response: Record<string, unknown>, requestId: string): void {
  if (response.jsonrpc !== "2.0" || response.id !== requestId) {
    throw new Error("MCP response does not match the submitted JSON-RPC request.");
  }
  if (response.error !== undefined) {
    throw new Error("MCP returned a JSON-RPC execution error; inspect the durable lifecycle before retrying.");
  }
  if (!isRecord(response.result) || response.result.isError === true) {
    throw new Error("MCP execute_payment failed; inspect the durable lifecycle before retrying.");
  }
}

function assertPinnedHttpsEndpoints(mcpUrl: string, readinessUrl: string): void {
  const mcp = requireHttpsUrl(mcpUrl, "MCP URL");
  const readiness = requireHttpsUrl(readinessUrl, "readiness URL");
  if (mcp !== "https://mcp.agentpay.site/celo/mcp") {
    throw new Error("Canary MCP URL must remain pinned to the production Celo endpoint.");
  }
  if (readiness !== "https://mcp.agentpay.site/celo/readyz") {
    throw new Error("Canary readiness URL must remain pinned to the production Celo endpoint.");
  }
}

function assertManifestBindings(manifest: z.infer<typeof canaryManifestSchema>): void {
  if (!addressesEqual(manifest.x402.tokenAddress, CELO_MAINNET_USDC)) {
    throw new Error("Canary manifest is not bound to canonical Celo USDC.");
  }
  if (!addressesEqual(manifest.contract.address, manifest.canaryPolicy.allowlistedAccountAddress)) {
    throw new Error("Canary manifest account binding is inconsistent.");
  }
  if (manifest.domains.publicOrigin !== "https://mcp.agentpay.site") {
    throw new Error("Canary manifest public origin is not the pinned production endpoint.");
  }
}

async function assertPayerPreflight(input: {
  rpcUrl: string;
  payerAddress: string;
  accountAddress: string;
  amountAtomic: bigint;
}): Promise<void> {
  const provider = new JsonRpcProvider(input.rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CELO_MAINNET_CHAIN_ID) {
    throw new Error("CELO_MAINNET_RPC_URL is not connected to Celo mainnet.");
  }
  const token = new Contract(
    CELO_MAINNET_USDC,
    ["function balanceOf(address account) view returns (uint256)"],
    provider,
  );
  const [payerCode, accountCode, payerBalance] = await Promise.all([
    provider.getCode(input.payerAddress),
    provider.getCode(input.accountAddress),
    token.balanceOf(input.payerAddress) as Promise<bigint>,
  ]);
  if (payerCode !== "0x") throw new Error("Canary payer must remain an EOA.");
  if (accountCode === "0x") throw new Error("Canary AgentPay account is not deployed.");
  if (payerBalance < input.amountAtomic) {
    throw new Error("Canary payer USDC balance is below the frozen x402 fee.");
  }
}

async function fetchWithContext(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch {
    throw new Error(`${operation} failed before a valid HTTP response was received.`);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^[0-9]+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("AgentPay response exceeds the operator size limit.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("AgentPay response exceeds the operator size limit.");
  }
  return body;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseOptionalJson(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addressesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requireHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${field} must be a credential-free HTTPS URL.`);
  }
  return url.href;
}

function requireCliValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${option}.`);
  return value;
}

function redactCliArgument(value: string | undefined): string {
  if (!value) return "[missing argument]";
  if (/^0x[a-f0-9]{64,130}$/i.test(value) || value.length > 160) {
    return "[redacted argument]";
  }
  return value;
}

function helpText(): string {
  return [
    "Execute one owner-authorized AgentPay Celo mainnet canary.",
    "",
    "Required environment variables:",
    "  AGENTPAY_CANARY_OWNER_SIGNATURE",
    "  AGENTPAY_CANARY_PAYER_PRIVATE_KEY",
    "  CELO_MAINNET_RPC_URL",
    "",
    "Usage:",
    "  npm run canary:mainnet -- --payment-intent-id pay_... --execute-mainnet-canary",
    "",
    "The server enforces the frozen allowlist and lifecycle cap before issuing an x402 challenge.",
    "Never pass signatures or private keys as command-line arguments.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCanaryCli(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : "Celo mainnet canary failed.");
    process.exitCode = 1;
  });
}
