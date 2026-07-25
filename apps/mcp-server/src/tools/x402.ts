import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import {
  createAgentPayX402PaymentHeader,
  parseX402PaymentRequired,
  type ParsedX402PaymentRequired,
  type ParseX402PaymentRequiredInput,
  parseX402PaymentRequiredInputSchema,
  type PaymentIntentRecord,
  type RetryX402RequestInput,
  retryX402RequestInputSchema,
} from "@agentpay-ai/shared-arc";

export interface ParseX402PaymentRequiredOutput extends ParsedX402PaymentRequired {
  status: "PARSED";
  instructionToAgent: string;
}

export async function parseX402PaymentRequiredForAgent(
  rawInput: ParseX402PaymentRequiredInput,
): Promise<ParseX402PaymentRequiredOutput> {
  const parsed = parseX402PaymentRequired(rawInput);
  assertSafePublicHttpsUrl(parsed.resource.url);

  return {
    status: "PARSED",
    ...parsed,
    instructionToAgent:
      "Review the x402 requirement and bound request with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, send the owner to Review & Sign for the EIP-712 authorization, execute with the verified signature, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response, exact same request, and paymentIntentId.",
  };
}

export interface RetryX402PaymentIntentRepository {
  getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
}

export interface RetryX402RequestDependencies {
  paymentIntents: RetryX402PaymentIntentRepository;
  httpClient: X402RetryHttpClient;
}

export interface X402RetryHttpClient {
  request(url: string, init: RequestInit): Promise<Response>;
}

export interface CreatePinnedX402HttpClientOptions {
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RetryX402RequestOutput {
  status: "RESOURCE_FETCHED";
  proofScheme: "agentpay-receipt";
  paymentIntentId: string;
  requestUrl: string;
  method: string;
  httpStatus: number;
  paymentResponse?: string;
  bodyText: string;
  instructionToAgent: string;
}

export async function retryX402Request(
  rawInput: RetryX402RequestInput,
  dependencies: RetryX402RequestDependencies,
): Promise<RetryX402RequestOutput> {
  const input = retryX402RequestInputSchema.parse(rawInput);
  const parsed = parseX402PaymentRequired({
    paymentRequired: input.paymentRequired,
    request: input.request,
  });
  const paymentIntent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!paymentIntent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }

  const requestUrl = input.request.url ?? parsed.resource.url;

  if (requestUrl !== parsed.resource.url) {
    throw new Error("x402 retry URL must match the resource URL from the PAYMENT-REQUIRED response.");
  }

  const paymentHeader = createAgentPayX402PaymentHeader({ parsed, paymentIntent });
  assertSafePublicHttpsUrl(requestUrl);
  const headers = createRetryHeaders(input.request.headers, paymentHeader);
  const response = await dependencies.httpClient.request(requestUrl, {
    method: input.request.method,
    headers,
    redirect: "manual",
    ...(input.request.body !== undefined ? { body: input.request.body } : {}),
  });
  const bodyText = await response.text();
  const paymentResponse = response.headers.get("payment-response") ?? response.headers.get("x-payment-response") ?? undefined;

  return {
    status: "RESOURCE_FETCHED",
    proofScheme: "agentpay-receipt",
    paymentIntentId: paymentIntent.id,
    requestUrl,
    method: input.request.method,
    httpStatus: response.status,
    ...(paymentResponse ? { paymentResponse } : {}),
    bodyText,
    instructionToAgent:
      response.ok
        ? "x402 retry succeeded. Return the protected resource response to the user."
        : "x402 retry returned a non-2xx response. Show the HTTP status and response body to the user.",
  };
}

export const parseX402PaymentRequiredTool = {
  name: "parse_x402_payment_required",
  description: "Parse a v2 x402 PAYMENT-REQUIRED object or header into AgentPay payment fields.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentRequired"],
    properties: {
      paymentRequired: {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
      sourceTokenSymbol: { type: "string", enum: ["USDC"] },
      request: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
        },
      },
    },
  },
} as const;

export const retryX402RequestTool = {
  name: "retry_x402_request",
  description:
    "Retry an x402-protected HTTP request after the AgentPay payment intent is COMPLETED, attaching AgentPay payment proof headers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentRequired", "paymentIntentId"],
    properties: {
      paymentRequired: {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
      paymentIntentId: { type: "string" },
      request: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
        },
      },
    },
  },
} as const;

export function createParseX402PaymentRequiredHandler() {
  return (input: ParseX402PaymentRequiredInput) => parseX402PaymentRequiredForAgent(input);
}

export function createRetryX402RequestHandler(dependencies: RetryX402RequestDependencies) {
  return (input: RetryX402RequestInput) => retryX402Request(input, dependencies);
}

export { parseX402PaymentRequiredInputSchema, retryX402RequestInputSchema };

function createRetryHeaders(inputHeaders: Record<string, string>, paymentHeader: string): Record<string, string> {
  return {
    ...inputHeaders,
    "X-PAYMENT": paymentHeader,
    "PAYMENT-SIGNATURE": paymentHeader,
  };
}

async function resolveHostname(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export function createPinnedX402HttpClient(
  options: CreatePinnedX402HttpClientOptions = {},
): X402RetryHttpClient {
  const hostnameResolver = options.resolveHostname ?? resolveHostname;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;

  return {
    async request(rawUrl, init) {
      assertSafePublicHttpsUrl(rawUrl);
      return requestWithPinnedLookup(rawUrl, init, {
        hostnameResolver,
        timeoutMs,
        maxResponseBytes,
      });
    },
  };
}

function assertSafePublicHttpsUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();

  if (
    url.protocol !== "https:"
    || url.username.length > 0
    || url.password.length > 0
    || isBlockedHostname(hostname)
  ) {
    throw new Error("x402 retry requires a safe public HTTPS URL.");
  }

  if (isIP(hostname) > 0 && !isPublicIpAddress(hostname)) {
    throw new Error("x402 retry requires a safe public HTTPS URL.");
  }
}

function requestWithPinnedLookup(
  rawUrl: string,
  init: RequestInit,
  options: {
    hostnameResolver: (hostname: string) => Promise<readonly string[]>;
    timeoutMs: number;
    maxResponseBytes: number;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(rawUrl, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup: createPinnedLookup(options.hostnameResolver),
    }, (response) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;

      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.byteLength;

        if (responseBytes > options.maxResponseBytes) {
          request.destroy(new Error("x402 retry response exceeded the maximum allowed size."));
          return;
        }

        chunks.push(buffer);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        const responseHeaders = new Headers();

        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [String(value)]) {
            responseHeaders.append(name, entry);
          }
        }

        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error("x402 retry request timed out."));
    });
    request.on("error", reject);
    init.signal?.addEventListener("abort", () => request.destroy(new Error("x402 retry request was aborted.")), {
      once: true,
    });

    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      request.write(init.body);
    }
    request.end();
  });
}

function createPinnedLookup(
  hostnameResolver: (hostname: string) => Promise<readonly string[]>,
): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    hostnameResolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
          throw new Error("x402 retry requires a safe public HTTPS URL.");
        }

        const requestedFamily = lookupOptions.family ?? 0;
        const selectedAddress = addresses.find((address) =>
          requestedFamily === 0 || isIP(address) === requestedFamily);

        if (!selectedAddress) {
          throw new Error("x402 retry could not resolve a safe address for the requested IP family.");
        }

        const family = isIP(selectedAddress);

        callback(
          null,
          lookupOptions.all ? [{ address: selectedAddress, family }] : selectedAddress,
          lookupOptions.all ? undefined : family,
        );
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error("x402 retry DNS resolution failed."), "", 0);
      });
  };
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".test")
    || hostname.endsWith(".invalid");
}

function isPublicIpAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress).toLowerCase();
  const ipVersion = isIP(address);

  if (ipVersion === 4) {
    return !NON_PUBLIC_IPV4_RANGES.check(address, "ipv4");
  }
  if (ipVersion === 6) {
    return !NON_PUBLIC_IPV6_RANGES.check(address, "ipv6");
  }
  return false;
}

function createNonPublicIpv4BlockList(): BlockList {
  const blockList = new BlockList();
  const ipv4Ranges: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];

  for (const [address, prefix] of ipv4Ranges) {
    blockList.addSubnet(address, prefix, "ipv4");
  }

  return blockList;
}

function createNonPublicIpv6BlockList(): BlockList {
  const blockList = new BlockList();
  const ipv6Ranges: ReadonlyArray<readonly [string, number]> = [
    ["::", 96],
    ["::ffff:0.0.0.0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];

  for (const [address, prefix] of ipv6Ranges) {
    blockList.addSubnet(address, prefix, "ipv6");
  }

  return blockList;
}

const NON_PUBLIC_IPV4_RANGES = createNonPublicIpv4BlockList();
const NON_PUBLIC_IPV6_RANGES = createNonPublicIpv6BlockList();
