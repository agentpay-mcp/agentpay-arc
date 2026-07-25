import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  discoverOAuthServerInfo,
  prepareAuthorizationCodeRequest,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Wallet } from "ethers";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, it } from "node:test";

import {
  createAgentPayErc8004Registration,
  createSessionContext,
  type SessionContext,
} from "@agentpay-ai/shared-arc";
import { createConsumerOAuthApi } from "../auth/oauth-api.ts";
import type {
  OAuthAuthorizationRecord,
  OAuthAuthorizationStore,
  OAuthClientRecord,
  OAuthClientStore,
} from "../auth/oauth.ts";
import { authenticateServiceSession, type AuthChallengeStore, type ServiceSessionRecord, type ServiceSessionStore } from "../auth/session.ts";
import type { SiweChallenge } from "../auth/siwe.ts";
import type { AgentPayRuntime } from "../runtime/agentpay-runtime.ts";
import { DEFAULT_CANARY_CAPS } from "../runtime/paid-execution-canary.ts";
import { parseAgentPayEnv } from "../runtime/agentpay-runtime.ts";
import type { RuntimeEnvironmentIdentity } from "../runtime/production-readiness.ts";
import type { CanaryLedgerStore } from "../runtime/paid-execution-canary-ledger.ts";
import { createInMemoryInvoiceExecutionOutboxStore } from "../services/paid-execution-outbox.ts";
import { createInMemoryPaidExecutionLifecycleStore } from "../services/paid-execution-lifecycle.ts";
import type { PaymentIntentRecord } from "@agentpay-ai/shared-arc";
import type {
  AgentPayMcpPaymentProcessor,
  ExpectedX402PaymentRequirements,
} from "./celo-agent-payment.ts";
import {
  loadManifestCanaryPolicy,
  resolveProductionReadiness,
  shouldVerifyMainnetAccountAtStartup,
  startAgentPayHttpServer,
  toConsumerProductionReadiness,
} from "./http.ts";
import type { ConnectableAgentPayMcpServer } from "./stdio.ts";

describe("startAgentPayHttpServer", () => {
  it("rejects a mainnet paid public surface without the production chain boundary", async () => {
    await assert.rejects(
      () =>
        startAgentPayHttpServer({
          env: {
            ...mcpEnv(),
            AGENTPAY_HOME_CHAIN_ID: "11142220",
            AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
            AGENTPAY_A2MCP_PAYMENT_PAY_TO: "0x0000000000000000000000000000000000000002",
            AGENTPAY_A2MCP_PAYMENT_PRICE: "$0.01",
            AGENTPAY_A2MCP_PAYMENT_NETWORK: "eip155:42220",
            AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL: "https://facilitator.example.com",
          },
          hostname: "127.0.0.1",
          port: 0,
        }),
      /mainnet.*production|production.*mainnet/i,
    );
  });

  it("serves health checks and MCP tools over Streamable HTTP", async () => {
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const health = await fetch(server.healthUrl);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        ok: true,
        service: "agentpay-a2mcp",
        transport: "streamable-http",
      });

      const client = new Client({ name: "agentpay-http-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

      await client.connect(transport);
      const tools = await client.listTools();
      await client.close();

      assert.deepEqual(tools.tools.map((tool) => tool.name), ["execute_payment"]);
    } finally {
      await server.close();
    }
  });

  it("serves validated ERC-8004 domain metadata without authentication or payment", async () => {
    const agentRegistration = createAgentPayErc8004Registration({
      agentWalletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      agentId: 42,
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      agentRegistration,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(new URL("/.well-known/agent-registration.json", server.url));

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("cache-control"), "public, max-age=300");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(await response.json(), agentRegistration);

      const post = await fetch(new URL("/.well-known/agent-registration.json", server.url), {
        method: "POST",
      });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET");
    } finally {
      await server.close();
    }
  });

  it("does not publish an ERC-8004 identity before real wallet inputs are configured", async () => {
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(new URL("/.well-known/agent-registration.json", server.url));
      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  });

  it("rejects non-POST MCP requests with a JSON-RPC error", async () => {
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl);

      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      });
    } finally {
      await server.close();
    }
  });

  it("keeps health checks free when MCP payments are enabled", async () => {
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        throw new Error("health checks should not touch the payment processor.");
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.healthUrl);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        service: "agentpay-a2mcp",
        transport: "streamable-http",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects non-public MCP tools before issuing a paid challenge", async () => {
    let paymentCalls = 0;
    let walletSetupWasCalled = false;
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest(context) {
        paymentCalls += 1;
        assert.equal(context.method, "POST");
        assert.equal(context.path, "/mcp");

        return {
          type: "payment-error",
          response: {
            status: 402,
            headers: {
              "content-type": "application/json",
              "PAYMENT-REQUIRED": "tool-call-challenge",
            },
            body: {
              error: "Payment required.",
            },
          },
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async prepareWalletCreation() {
            walletSetupWasCalled = true;
            return {
              status: "PENDING",
              setupIntentId: "setup_http",
              setupUrl: "https://setup.example.com/setup?setup_intent_id=setup_http",
              messageToSign: "AgentPay setup intent setup_http",
              expiresAt: "2026-07-08T00:15:00.000Z",
              homeChainId: 11142220,
              homeChain: "Celo Sepolia",
            };
          },
        });
      },
    });

    try {
      const client = new Client({ name: "agentpay-http-free-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

      await client.connect(transport);
      const tools = await client.listTools();
      await client.close();

      const toolCallResponse = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "prepare_wallet_creation",
            arguments: { network: "testnet" },
          },
        }),
      });

      assert.deepEqual(tools.tools.map((tool) => tool.name), ["execute_payment"]);
      assert.equal(toolCallResponse.status, 400);
      assert.deepEqual(await toolCallResponse.json(), {
        error: "The public paid surface accepts only the execute_payment MCP tool.",
        code: "PAID_TOOL_NOT_ALLOWED",
      });
      assert.equal(paymentCalls, 0);
      assert.equal(walletSetupWasCalled, false);
    } finally {
      await server.close();
    }
  });

  it("rejects non-execute public methods before issuing a Celo x402 challenge", async () => {
    let mcpServerWasCreated = false;
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest(context) {
        assert.equal(context.method, "POST");
        assert.equal(context.path, "/mcp");
        assert.equal(context.paymentHeader, undefined);

        return {
          type: "payment-error",
          response: {
            status: 402,
            headers: {
              "content-type": "application/json",
              "PAYMENT-REQUIRED": Buffer.from(
                JSON.stringify({
                  x402Version: 2,
                  resource: {
                    url: "/mcp",
                    description: "AgentPay public MCP endpoint",
                  },
                  accepts: [
                    {
                      scheme: "exact",
                      network: "eip155:42220",
                      asset: "0x0000000000000000000000000000000000000001",
                      amount: "10000",
                      payTo: "0x0000000000000000000000000000000000000002",
                      maxTimeoutSeconds: 300,
                      extra: {},
                    },
                  ],
                }),
              ).toString("base64"),
            },
            body: {
              error: "Payment required.",
            },
          },
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime();
      },
      createServer(runtime) {
        mcpServerWasCreated = true;
        return createFakeMcpServer(runtime);
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "paid://probe" } }),
      });

      assert.equal(response.status, 400);
      assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
      assert.deepEqual(await response.json(), {
        error: "The public paid surface accepts only the execute_payment MCP tool.",
        code: "PAID_TOOL_NOT_ALLOWED",
      });
      assert.equal(mcpServerWasCreated, false);
    } finally {
      await server.close();
    }
  });

  it("keeps GET probes payable but rejects malformed POSTs before x402", async () => {
    let mcpServerWasCreated = false;
    const challengeHeader = createPaymentRequiredHeader([createPaymentRequirements()]);
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest(context) {
        assert.equal(context.path, "/mcp");

        return {
          type: "payment-error",
          response: {
            status: 402,
            headers: {
              "content-type": "application/json",
              "PAYMENT-REQUIRED": challengeHeader,
            },
            body: {
              error: "Payment required.",
            },
          },
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime();
      },
      createServer(runtime) {
        mcpServerWasCreated = true;
        return createFakeMcpServer(runtime);
      },
    });

    try {
      const getResponse = await fetch(server.mcpUrl);
      const malformedPostResponse = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(getResponse.status, 402);
      assert.equal(getResponse.headers.get("PAYMENT-REQUIRED"), challengeHeader);
      assert.deepEqual(await getResponse.json(), { error: "Payment required." });
      assert.equal(malformedPostResponse.status, 400);
      assert.equal(malformedPostResponse.headers.get("PAYMENT-REQUIRED"), null);
      assert.equal(mcpServerWasCreated, false);
    } finally {
      await server.close();
    }
  });

  it("rejects a paid challenge when any advertised x402 option drifts from seller terms", async () => {
    const expected = createPaymentRequirements();
    const malicious = {
      ...expected,
      payTo: "0x0000000000000000000000000000000000000003",
    };
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        return {
          type: "payment-error",
          response: {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": createPaymentRequiredHeader([expected, malicious]),
            },
            body: { error: "Payment required." },
          },
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute_payment",
            arguments: { paymentIntentId: "pay_challenge_drift", signature: `0x${"11".repeat(65)}` },
          },
        }),
      });

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
      assert.deepEqual(await response.json(), {
        error: "Payment challenge does not match the configured x402 seller terms.",
        code: "PAID_CHALLENGE_INVALID",
      });
    } finally {
      await server.close();
    }
  });

  it("runs signed payment preflight before x402 processing", async () => {
    let processorCalls = 0;
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        processorCalls += 1;
        return {
          type: "payment-error",
          response: {
            status: 402,
            headers: { "PAYMENT-REQUIRED": "must-not-run" },
            body: { error: "Payment required." },
          },
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async preflightPayment() {
            throw new Error("expired intent");
          },
        });
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute_payment",
            arguments: { paymentIntentId: "pay_expired", signature: `0x${"11".repeat(65)}` },
          },
        }),
      });

      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "Paid execution preflight failed.",
        code: "PAID_PREFLIGHT_FAILED",
      });
      assert.equal(processorCalls, 0);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-allowlisted canary intent before issuing an x402 challenge", async () => {
    let processorCalls = 0;
    const policy = canaryPolicy();
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging", AGENTPAY_EXECUTION_MODE: "CANARY" },
      hostname: "127.0.0.1",
      port: 0,
      canaryPolicy: policy,
      canaryLedger: createTestCanaryLedger(),
      paymentProcessor: createPaymentProcessor({
        async processHTTPRequest() {
          processorCalls += 1;
          return { type: "payment-error", response: { status: 402, headers: {}, body: { error: "challenge" } } };
        },
      }),
      createRuntime() {
        return createRuntime({
          async preflightPayment(input) {
            return { paymentIntentId: input.paymentIntentId, intent: { ...canaryIntent(), recipientAddress: "0x9999999999999999999999999999999999999999" }, input };
          },
        });
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_canary", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "Payment recipient is outside the canary allowlist.",
        code: "CANARY_ALLOWLIST",
      });
      assert.equal(processorCalls, 0);
    } finally {
      await server.close();
    }
  });

  it("accepts a Permit2 payer before reserving and completing the canary lifecycle", async () => {
    const calls: string[] = [];
    const policy = canaryPolicy();
    const ledger = createTestCanaryLedger(calls);
    const permit2Requirements = {
      ...createCanaryPaymentRequirements(),
      extra: { assetTransferMethod: "permit2" },
    };
    const paymentProcessor = createPaymentProcessor({
      expectedPaymentRequirements: createExpectedPaymentRequirements("permit2", permit2Requirements),
      async processHTTPRequest() {
        return {
          type: "payment-verified",
          paymentPayload: createPermit2PaymentPayload(policy.allowlist.payerAddress, permit2Requirements),
          paymentRequirements: permit2Requirements,
        };
      },
      async processSettlement() {
        calls.push("settle");
        return {
          success: true,
          status: "success",
          transaction: `0x${"88".repeat(32)}`,
          network: "eip155:42220",
          headers: {},
          requirements: permit2Requirements,
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging", AGENTPAY_EXECUTION_MODE: "CANARY" },
      hostname: "127.0.0.1",
      port: 0,
      canaryPolicy: policy,
      canaryLedger: ledger,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async preflightPayment(input) {
            return { paymentIntentId: input.paymentIntentId, intent: canaryIntent(), input };
          },
          async executePayment() {
            calls.push("execute");
            return {
              paymentIntentId: "pay_canary",
              status: "EXECUTING",
              sourceTxHash: `0x${"99".repeat(32)}`,
              message: "Payment execution started.",
            };
          },
        });
      },
    });

    try {
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute_payment", arguments: { paymentIntentId: "pay_canary", signature: `0x${"11".repeat(65)}` } },
      };
      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": "paid",
      };
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });

      assert.equal(response.status, 200);
      const firstBody = await response.text();
      const replay = await fetch(server.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, id: 2 }),
      });
      assert.equal(replay.status, 200);
      assert.equal(await replay.text(), firstBody);
      assert.deepEqual(calls, ["reserve", "settle", "execute", "complete"]);
    } finally {
      await server.close();
    }
  });

  it("fails closed when a paid public request has no payment processor", async () => {
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_missing_processor", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Paid payment processor unavailable.",
        code: "PAID_PROCESSOR_UNAVAILABLE",
      });
    } finally {
      await server.close();
    }
  });

  it("fails closed when the payment processor returns no-payment-required for a paid request", async () => {
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor: createPaymentProcessor({}),
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_protocol_error", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Paid payment processor returned no payment proof.",
        code: "PAID_PROCESSOR_PROTOCOL_ERROR",
      });
    } finally {
      await server.close();
    }
  });

  it("fails closed when a verified Permit2 proof omits its payer authorization", async () => {
    const permit2Requirements = {
      ...createPaymentRequirements(),
      extra: { assetTransferMethod: "permit2" },
    };
    const paymentProcessor = createPaymentProcessor({
      expectedPaymentRequirements: createExpectedPaymentRequirements("permit2", permit2Requirements),
      async processHTTPRequest() {
        return {
          type: "payment-verified",
          paymentPayload: {
            ...createPaymentPayload(),
            accepted: permit2Requirements,
          },
          paymentRequirements: permit2Requirements,
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "PAYMENT-SIGNATURE": "paid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_permit2_missing_payer", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Verified payment proof does not identify a payer.",
        code: "PAID_PAYER_UNBOUND",
      });
    } finally {
      await server.close();
    }
  });

  it("settles a paid MCP request before serving the MCP response", async () => {
    const calls: string[] = [];
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest(context) {
        calls.push(`process:${context.paymentHeader}`);

        return {
          type: "payment-verified",
          paymentPayload: createPaymentPayload(),
          paymentRequirements: createPaymentRequirements(),
        };
      },
      async processSettlement(_payload, _requirements, _extensions, transportContext) {
        calls.push(`settle:${transportContext?.responseBody?.byteLength ?? 0}`);
        assert.equal(transportContext?.responseBody, undefined);

        return {
          success: true,
          status: "success",
          transaction: `0x${"55".repeat(32)}`,
          network: "eip155:42220",
          headers: {
            "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: `0x${"55".repeat(32)}` })).toString(
              "base64",
            ),
          },
          requirements: createPaymentRequirements(),
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async executePayment() {
            calls.push("execute");
            return {
              paymentIntentId: "pay_x402",
              status: "EXECUTING",
              sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              message: "Payment execution started.",
            };
          },
          async retryX402Request() {
            return {
              status: "RESOURCE_FETCHED",
              proofScheme: "agentpay-receipt",
              paymentIntentId: "pay_x402",
              requestUrl: "https://api.example.com/protected",
              method: "GET",
              httpStatus: 200,
              paymentHeader: "proof",
              bodyText: "paid payload",
              instructionToAgent: "x402 retry succeeded. Return the protected resource response to the user.",
            };
          },
        });
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "PAYMENT-SIGNATURE": "paid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute_payment",
            arguments: {
              paymentIntentId: "pay_x402",
              signature: `0x${"11".repeat(65)}`,
            },
          },
        }),
      });
      const responseText = await response.text();

      assert.equal(response.status, 200);
      assert.equal((response.headers.get("PAYMENT-RESPONSE") ?? "").length > 0, true);
      assert.match(responseText, /Payment execution started/);
      assert.equal(calls[0], "process:paid");
      assert.equal(calls[1], "settle:0");
      assert.equal(calls[2], "execute");
    } finally {
      await server.close();
    }
  });

  it("rejects verified x402 terms that drift from the configured seller terms", async () => {
    const baseline = createPaymentRequirements();
    const expected = createExpectedPaymentRequirements();
    const variants: PaymentRequirements[] = [
      { ...baseline, network: "eip155:11142220" },
      { ...baseline, amount: "2" },
      { ...baseline, payTo: "0x0000000000000000000000000000000000000003" },
      { ...baseline, extra: { assetTransferMethod: "permit2" } },
      { ...baseline, extra: {} },
    ];

    for (const paymentRequirements of variants) {
      let settlementCalls = 0;
      const paymentProcessor = Object.assign(
        createPaymentProcessor({
          async processHTTPRequest() {
            return {
              type: "payment-verified" as const,
              paymentPayload: { ...createPaymentPayload(), accepted: paymentRequirements },
              paymentRequirements,
            };
          },
          async processSettlement() {
            settlementCalls += 1;
            throw new Error("mismatched terms must not settle");
          },
        }),
        { expectedPaymentRequirements: expected },
      );
      const server = await startAgentPayHttpServer({
        env: mcpEnv(),
        hostname: "127.0.0.1",
        port: 0,
        paymentProcessor,
        createRuntime() {
          return createRuntime();
        },
      });

      try {
        const response = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "PAYMENT-SIGNATURE": "paid",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "execute_payment",
              arguments: { paymentIntentId: "pay_x402", signature: `0x${"11".repeat(65)}` },
            },
          }),
        });

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: "Verified payment terms do not match the configured x402 seller terms.",
          code: "PAID_PAYMENT_TERMS_MISMATCH",
        });
        assert.equal(settlementCalls, 0);
      } finally {
        await server.close();
      }
    }
  });

  it("reserves the durable invoice outbox before fee settlement", async () => {
    const calls: string[] = [];
    const outbox = createInMemoryInvoiceExecutionOutboxStore();
    const lifecycle = createInMemoryPaidExecutionLifecycleStore();
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        return {
          type: "payment-verified",
          paymentPayload: createPaymentPayload(),
          paymentRequirements: createPaymentRequirements(),
        };
      },
      async processSettlement() {
        calls.push(`settle:${(await outbox.listRecoverable(new Date().toISOString())).length}`);
        return {
          success: true,
          status: "success",
          transaction: `0x${"56".repeat(32)}`,
          network: "eip155:42220",
          headers: {},
          requirements: createPaymentRequirements(),
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_RAW_TX_ENCRYPTION_KEY: "r".repeat(64) },
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      paidExecutionLifecycle: lifecycle,
      invoiceExecutionOutbox: outbox,
      createRuntime() {
        return createRuntime({
          executorAddress: "0x9999999999999999999999999999999999999999",
          async preflightPayment(input) {
            return { paymentIntentId: input.paymentIntentId, intent: reservationIntent(), input };
          },
          async executePaymentWithContext(_input, context) {
            calls.push(`execute:${(await context.outbox.get(context.outboxId))?.status}`);
            return {
              paymentIntentId: "pay_reservation",
              status: "EXECUTING",
              sourceTxHash: `0x${"aa".repeat(32)}`,
              message: "Payment execution started.",
            };
          },
        });
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "PAYMENT-SIGNATURE": "paid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_reservation", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(calls, ["settle:1", "execute:QUEUED"]);
      const records = await outbox.listRecoverable(new Date().toISOString());
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, "QUEUED");
    } finally {
      await server.close();
    }
  });

  it("replays a completed paid lifecycle without settling or executing twice", async () => {
    let settlementCalls = 0;
    let executeCalls = 0;
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        return {
          type: "payment-verified",
          paymentPayload: createPaymentPayload(),
          paymentRequirements: createPaymentRequirements(),
        };
      },
      async processSettlement() {
        settlementCalls += 1;
        return {
          success: true,
          status: "success",
          transaction: `0x${"33".repeat(32)}`,
          network: "eip155:42220",
          headers: { "PAYMENT-RESPONSE": "receipt" },
          requirements: createPaymentRequirements(),
        };
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async executePayment() {
            executeCalls += 1;
            return {
              paymentIntentId: "pay_x402",
              status: "EXECUTING",
              sourceTxHash: `0x${"44".repeat(32)}`,
              message: "Payment execution started.",
            };
          },
        });
      },
    });

    try {
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "execute_payment",
          arguments: { paymentIntentId: "pay_x402", signature: `0x${"11".repeat(65)}` },
        },
      };
      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": "paid",
      };
      const first = await fetch(server.mcpUrl, { method: "POST", headers, body: JSON.stringify(request) });
      const firstBody = await first.text();
      const second = await fetch(server.mcpUrl, {
        method: "POST",
        headers,
        // JSON-RPC ids are transport correlation values; a lost-response
        // retry may legitimately use a fresh id and must still replay.
        body: JSON.stringify({ ...request, id: 2 }),
      });
      const secondBody = await second.text();

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(secondBody, firstBody);
      assert.equal(settlementCalls, 1);
      assert.equal(executeCalls, 1);
    } finally {
      await server.close();
    }
  });

  it("does not create or execute the MCP request when paid settlement fails", async () => {
    let mcpServerWasCreated = false;
    let executeWasCalled = false;
    const paymentProcessor = createPaymentProcessor({
      async processHTTPRequest() {
        return {
          type: "payment-verified",
          paymentPayload: createPaymentPayload(),
          paymentRequirements: createPaymentRequirements(),
        };
      },
      async processSettlement() {
        return {
          success: false,
          status: "failed",
          errorReason: "FACILITATOR_REJECTED",
          transaction: `0x${"66".repeat(32)}`,
          network: "eip155:42220",
          headers: {},
          response: {
            status: 402,
            headers: { "content-type": "application/json" },
            body: { error: "Payment settlement failed." },
          },
        } as never;
      },
    });
    const server = await startAgentPayHttpServer({
      env: mcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor,
      createRuntime() {
        return createRuntime({
          async executePayment() {
            executeWasCalled = true;
            throw new Error("execution must not run after settlement failure");
          },
        });
      },
      createServer(runtime) {
        mcpServerWasCreated = true;
        return createFakeMcpServer(runtime);
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "PAYMENT-SIGNATURE": "paid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_x402", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(response.status, 402);
      assert.equal(mcpServerWasCreated, false);
      assert.equal(executeWasCalled, false);
    } finally {
      await server.close();
    }
  });

  it("fails closed in consumer mode before creating a runtime and keeps health free", async () => {
    let runtimeCreations = 0;
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate() {
          throw new Error("invalid session");
        },
      },
      createRuntime() {
        runtimeCreations += 1;
        return createRuntime();
      },
    });

    try {
      const health = await fetch(server.healthUrl);
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      const undiscoverable = await fetch(new URL("/.well-known/oauth-protected-resource/celo/mcp", server.url));

      assert.equal(health.status, 200);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal(undiscoverable.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Consumer authentication required." });
      assert.equal(runtimeCreations, 0);
    } finally {
      await server.close();
    }
  });

  it("reports an isolated production consumer as ready without granting execution", () => {
    const readiness = toConsumerProductionReadiness(
      {
        ready: false,
        executionAllowed: false,
        publicPaymentAllowed: false,
        mode: "PUBLIC",
        status: "READY",
        errors: [
          "payment config: public mode requires enabled x402 payment",
          "raw transaction encryption: AGENTPAY_RAW_TX_ENCRYPTION_KEY must be a 32-byte hex key",
          "execution mode: environment value does not match the database identity",
        ],
        checks: {
          environment: true,
          manifest: true,
          identity: true,
          payment: false,
          rawTransactionEncryption: false,
          account: true,
          canaryAdmission: true,
          onboardingMode: true,
          onboarding: true,
        },
        identityFingerprint: "consumer-fingerprint",
      },
      {
        AGENTPAY_EXECUTION_MODE: "OFF",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "false",
      },
    );

    assert.equal(readiness.ready, true);
    assert.equal(readiness.executionAllowed, false);
    assert.equal(readiness.publicPaymentAllowed, false);
    assert.equal(readiness.mode, "PUBLIC");
    assert.equal(readiness.status, "READY");
    assert.equal(readiness.identityFingerprint, "consumer-fingerprint");
    assert.deepEqual(readiness.errors, []);
    assert.deepEqual(readiness.checks, {
      environment: true,
      manifest: true,
      identity: true,
      account: true,
      canaryAdmission: true,
      onboardingMode: true,
      onboarding: true,
      consumerIsolation: true,
    });
  });

  it("keeps production consumer readiness fail-closed on secrets or identity drift", () => {
    const baseReadiness = {
      ready: false,
      executionAllowed: false,
      publicPaymentAllowed: false,
      mode: "PUBLIC" as const,
      status: "READY" as const,
      errors: [
        "payment config: public mode requires enabled x402 payment",
        "raw transaction encryption: AGENTPAY_RAW_TX_ENCRYPTION_KEY must be a 32-byte hex key",
        "execution mode: environment value does not match the database identity",
      ],
      checks: {
        environment: true,
        manifest: true,
        identity: true,
        payment: false,
        rawTransactionEncryption: false,
        account: true,
        canaryAdmission: true,
        onboardingMode: true,
        onboarding: true,
      },
    };

    for (const env of [
      {
        AGENTPAY_EXECUTION_MODE: "PUBLIC",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "false",
      },
      {
        AGENTPAY_EXECUTION_MODE: "OFF",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
      },
      {
        AGENTPAY_EXECUTION_MODE: "OFF",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "false",
        EXECUTOR_PRIVATE_KEY: "must-not-enter-consumer",
      },
      {
        AGENTPAY_EXECUTION_MODE: "OFF",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "false",
        AGENTPAY_RAW_TX_ENCRYPTION_KEY: "must-not-enter-consumer",
      },
    ]) {
      const result = toConsumerProductionReadiness(baseReadiness, env);
      assert.equal(result.ready, false);
      assert.equal(result.executionAllowed, false);
      assert.equal(result.publicPaymentAllowed, false);
      assert.equal(result.checks.consumerIsolation, false);
    }

    const identityDrift = toConsumerProductionReadiness(
      {
        ...baseReadiness,
        errors: [...baseReadiness.errors, "runtime identity: manifest digest does not match"],
        checks: { ...baseReadiness.checks, identity: false },
      },
      {
        AGENTPAY_EXECUTION_MODE: "OFF",
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "false",
      },
    );
    assert.equal(identityDrift.ready, false);
    assert.equal(identityDrift.checks.consumerIsolation, true);
    assert.match(identityDrift.errors.join("; "), /manifest digest/i);
  });

  it("advertises consumer protected-resource and authorization-server metadata", async () => {
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate() {
          throw new Error("MCP auth should not be reached for OAuth discovery.");
        },
      },
      oauthApi: {
        async handle(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/.well-known/oauth-protected-resource/celo/mcp") {
            return new Response(JSON.stringify({
              resource: "https://wallet.agentpay.site/celo/mcp",
              authorization_servers: ["https://wallet.agentpay.site/celo"],
              scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
              bearer_methods_supported: ["header"],
            }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
          }
          return new Response(JSON.stringify({
            issuer: "https://wallet.agentpay.site/celo",
            authorization_endpoint: "https://wallet.agentpay.site/celo/oauth/authorize",
            token_endpoint: "https://wallet.agentpay.site/celo/oauth/token",
            registration_endpoint: "https://wallet.agentpay.site/celo/oauth/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
          }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const rootResourceMetadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", server.url));
      const rootAuthorizationMetadata = await fetch(new URL("/.well-known/oauth-authorization-server", server.url));
      const rootRegistration = await fetch(new URL("/oauth/register", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:4567/callback"] }),
      });
      const resourceMetadata = await fetch(new URL("/.well-known/oauth-protected-resource/celo/mcp", server.url));
      assert.equal(rootResourceMetadata.status, 404);
      assert.equal(rootAuthorizationMetadata.status, 404);
      assert.equal(rootRegistration.status, 404);
      assert.equal(resourceMetadata.status, 200);
      assert.deepEqual(await resourceMetadata.json(), {
        resource: "https://wallet.agentpay.site/celo/mcp",
        authorization_servers: ["https://wallet.agentpay.site/celo"],
        scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
        bearer_methods_supported: ["header"],
      });

      const authorizationMetadata = await fetch(new URL("/.well-known/oauth-authorization-server/celo", server.url));
      assert.equal(authorizationMetadata.status, 200);
      assert.deepEqual(await authorizationMetadata.json(), {
        issuer: "https://wallet.agentpay.site/celo",
        authorization_endpoint: "https://wallet.agentpay.site/celo/oauth/authorize",
        token_endpoint: "https://wallet.agentpay.site/celo/oauth/token",
        registration_endpoint: "https://wallet.agentpay.site/celo/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
      });
      assert.equal(authorizationMetadata.headers.get("cache-control"), "no-store");
    } finally {
      await server.close();
    }
  });

  it("keeps production shadow/OFF liveness separate from readiness and blocks public execution", async () => {
    let runtimeCreations = 0;
    const server = await startAgentPayHttpServer({
      env: productionMcpEnv(),
      hostname: "127.0.0.1",
      port: 0,
      paymentProcessor: {
        expectedPaymentRequirements: createExpectedPaymentRequirements(),
        async processHTTPRequest() {
          throw new Error("injected production payment processor must not bypass readiness");
        },
        async processSettlement() {
          throw new Error("injected production settlement must not run");
        },
      },
      createRuntime() {
        runtimeCreations += 1;
        return createRuntime();
      },
    });

    try {
      const health = await fetch(server.healthUrl);
      const readiness = await fetch(server.readinessUrl);
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_1", signature: `0x${"11".repeat(65)}` } },
        }),
      });

      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      assert.equal(readiness.status, 503);
      assert.equal((await readiness.json()).code, "PRODUCTION_NOT_READY");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Production execution unavailable.",
        code: "PRODUCTION_NOT_READY",
      });
      assert.equal(runtimeCreations, 0);
    } finally {
      await server.close();
    }
  });

  it("skips historical account verification only in OFF mode", () => {
    assert.equal(shouldVerifyMainnetAccountAtStartup("OFF"), false);
    assert.equal(shouldVerifyMainnetAccountAtStartup("CANARY"), true);
    assert.equal(shouldVerifyMainnetAccountAtStartup("PUBLIC"), true);
    assert.equal(shouldVerifyMainnetAccountAtStartup("DRAIN"), true);
    assert.equal(shouldVerifyMainnetAccountAtStartup(undefined), true);
  });

  it("loads the frozen executor gas cap from the canary manifest in wei", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpay-canary-gas-cap-test-"));
    const manifestPath = join(directory, "canary.json");
    const manifest = {
      canaryPolicy: {
        allowlistedTenantId: "11111111-1111-4111-8111-111111111111",
        allowlistedOwnerAddress: "0x1111111111111111111111111111111111111111",
        allowlistedAccountAddress: "0x2222222222222222222222222222222222222222",
        payerAddress: "0x3333333333333333333333333333333333333333",
        recipientAddress: "0x4444444444444444444444444444444444444444",
        invoiceMaxUsdc: "0.05",
        maxNativeFee: "0",
        maxAcceptedLifecycles: 1,
        executorGasMaxCelo: "0.05",
      },
    };

    try {
      await writeFile(manifestPath, JSON.stringify(manifest));
      const policy = await loadManifestCanaryPolicy(manifestPath);

      assert.equal(policy?.caps?.maxExecutorGasCostWei, 50_000_000_000_000_000n);

      manifest.canaryPolicy.executorGasMaxCelo = "0.0500000000000000001";
      await writeFile(manifestPath, JSON.stringify(manifest));
      assert.equal(await loadManifestCanaryPolicy(manifestPath), undefined);

      manifest.canaryPolicy.executorGasMaxCelo = "0.05.1";
      await writeFile(manifestPath, JSON.stringify(manifest));
      assert.equal(await loadManifestCanaryPolicy(manifestPath), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips the historical account scan only when the effective production mode is OFF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpay-off-readiness-test-"));
    const manifestPath = join(directory, "activated.json");
    const manifest = makeDeployedProductionManifest(JSON.parse(
      await readFile(new URL("../../../../test/fixtures/celo-mainnet.shadow.json", import.meta.url), "utf8"),
    ) as Record<string, any>);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const resolve = async (
      identityMode: "OFF" | "PUBLIC" | null,
      environmentMode: "OFF" | "PUBLIC" | " OFF " | "   ",
    ) => {
      let verificationCalls = 0;
      let verificationDeployerAddress: string | undefined;
      const env = {
        ...productionMcpEnv(),
        AGENTPAY_MAINNET_MANIFEST_PATH: manifestPath,
        AGENTPAY_EXECUTION_MODE: environmentMode,
      };
      const readiness = await resolveProductionReadiness(
        parseAgentPayEnv(env),
        env,
        undefined,
        {
          loadRuntimeIdentity: async () => identityMode
            ? productionIdentityFor(manifest, identityMode)
            : null,
          verifyAccount: async (verificationExpected) => {
            verificationCalls += 1;
            verificationDeployerAddress = (verificationExpected as { deployerAddress?: string }).deployerAddress;
            return { valid: false, checks: {}, errors: ["test verifier"] };
          },
          checkOnboardingReady: async () => true,
        },
      );
      return { readiness, verificationCalls, verificationDeployerAddress };
    };

    try {
      const off = await resolve("OFF", "OFF");
      assert.equal(off.verificationCalls, 0);
      assert.equal(off.readiness.executionAllowed, false);

      const environmentPublic = await resolve(null, "PUBLIC");
      assert.equal(environmentPublic.verificationCalls, 1);
      assert.equal(environmentPublic.verificationDeployerAddress, manifest.contract.deployerAddress);

      const paddedEnvironmentOff = await resolve(null, " OFF ");
      assert.equal(paddedEnvironmentOff.verificationCalls, 0);
      assert.equal(paddedEnvironmentOff.readiness.mode, "OFF");

      const blankEnvironmentOff = await resolve(null, "   ");
      assert.equal(blankEnvironmentOff.verificationCalls, 0);
      assert.equal(blankEnvironmentOff.readiness.mode, "OFF");

      const identityPublic = await resolve("PUBLIC", "OFF");
      assert.equal(identityPublic.verificationCalls, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects onboarding mode drift before accepting live setup readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpay-onboarding-mode-test-"));
    const manifestPath = join(directory, "activated.json");
    const manifest = makeDeployedProductionManifest(JSON.parse(
      await readFile(new URL("../../../../test/fixtures/celo-mainnet.shadow.json", import.meta.url), "utf8"),
    ) as Record<string, any>);
    manifest.status = "READY";
    manifest.executionMode = "PUBLIC";
    manifest.x402.enabled = true;
    await writeFile(manifestPath, JSON.stringify(manifest));
    let onboardingChecks = 0;

    try {
      const env = {
        ...productionMcpEnv(),
        AGENTPAY_MAINNET_MANIFEST_PATH: manifestPath,
        AGENTPAY_SETUP_MODE: "CANARY",
      };
      const readiness = await resolveProductionReadiness(
        parseAgentPayEnv(env),
        env,
        undefined,
        {
          loadRuntimeIdentity: async () => productionIdentityFor(manifest, "PUBLIC"),
          verifyAccount: async () => ({ valid: true, checks: {}, errors: [] }),
          checkOnboardingReady: async () => {
            onboardingChecks += 1;
            return true;
          },
        },
      );

      assert.equal(onboardingChecks, 0);
      assert.equal(readiness.ready, false);
      assert.match(readiness.errors.join("; "), /setup mode.*effective production execution mode/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads an explicit production manifest path for the published package layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpay-manifest-test-"));
    const manifestPath = join(directory, "shadow.json");
    const manifest = JSON.parse(
      await readFile(new URL("../../../../test/fixtures/celo-mainnet.shadow.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    manifest.executionMode = "PUBLIC";
    await writeFile(
      manifestPath,
      JSON.stringify(manifest),
    );

    try {
      const server = await startAgentPayHttpServer({
        env: {
          ...productionMcpEnv(),
          AGENTPAY_MAINNET_MANIFEST_PATH: manifestPath,
        },
        hostname: "127.0.0.1",
        port: 0,
      });

      try {
        const readiness = await fetch(server.readinessUrl);
        assert.equal(readiness.status, 503);
        assert.equal((await readiness.json()).mode, "PUBLIC");
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("derives the consumer boundary from runtime env without exposing a global sessionless runtime", async () => {
    const server = await startAgentPayHttpServer({
      env: {
        ...mcpEnv(),
        AGENTPAY_HTTP_MODE: "consumer",
        AGENTPAY_ENVIRONMENT: "staging",
        AGENTPAY_SESSION_HASH_KEY: "consumer-session-secret",
      },
      hostname: "127.0.0.1",
      port: 0,
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(response.status, 401);
    } finally {
      await server.close();
    }
  });

  it("does not expose the legacy SIWE bearer endpoint without an explicit self-hosted opt-in", async () => {
    const paths: string[] = [];
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate() {
          throw new Error("MCP auth should not be reached for the session API route.");
        },
      },
      sessionApi: {
        async handle(request) {
          paths.push(new URL(request.url).pathname);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(new URL("/auth/siwe/challenge", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(paths, []);
    } finally {
      await server.close();
    }
  });

  it("routes the legacy SIWE session API only after an explicit self-hosted opt-in", async () => {
    const paths: string[] = [];
    const server = await startAgentPayHttpServer({
      env: {
        ...mcpEnv(),
        AGENTPAY_ENVIRONMENT: "staging",
        AGENTPAY_ENABLE_LEGACY_SIWE_SESSION_API: "true",
      },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate() {
          throw new Error("MCP auth should not be reached for the legacy session API route.");
        },
      },
      sessionApi: {
        async handle(request) {
          paths.push(new URL(request.url).pathname);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(new URL("/auth/siwe/challenge", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(paths, ["/auth/siwe/challenge"]);
    } finally {
      await server.close();
    }
  });

  it("routes OAuth authorization endpoints before consumer MCP authentication", async () => {
    const paths: string[] = [];
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate() {
          throw new Error("MCP auth should not be reached for OAuth routes.");
        },
      },
      sessionApi: {
        async handle() {
          return new Response(JSON.stringify({ error: "Unexpected session route." }), { status: 500 });
        },
      },
      oauthApi: {
        async preflight(request) {
          paths.push(`preflight:${new URL(request.url).pathname}`);
          assert.equal(request.headers.get("x-agentpay-oauth-client"), "203.0.113.10");
          return undefined;
        },
        async handle(request) {
          paths.push(new URL(request.url).pathname);
          assert.ok(request.headers.get("x-agentpay-oauth-client"));
          return new Response(JSON.stringify({ client_id: "client_test" }), {
            status: 201,
            headers: { "cache-control": "no-store", "content-type": "application/json" },
          });
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const response = await fetch(new URL("/celo/oauth/register", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.10",
          "x-forwarded-for": "198.51.100.200, 203.0.113.250",
        },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:4567/callback"] }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { client_id: "client_test" });
      assert.deepEqual(paths, ["preflight:/celo/oauth/register", "/celo/oauth/register"]);
    } finally {
      await server.close();
    }
  });

  it("completes MCP discovery, DCR, PKCE, SIWE, token exchange, and an authenticated MCP request", async () => {
    const owner = new Wallet(`0x${"3".repeat(64)}`);
    const stores = createOAuthHttpTestStores();
    const serverSecret = "oauth-http-test-session-secret";
    const oauthApi = createConsumerOAuthApi({
      clientStore: stores.clientStore,
      authorizationStore: stores.authorizationStore,
      challengeStore: stores.challengeStore,
      serverSecret,
      audience: "https://wallet.agentpay.site/celo/mcp",
      environment: "staging",
      clock: () => new Date("2026-07-12T00:00:00.000Z"),
      resolveOwner: async (ownerAddress, chainId) => ({
        tenantId: "tenant_oauth_http",
        ownerAddress,
        accountAddress: "0x2222222222222222222222222222222222222222",
        homeChainId: chainId,
        authenticationEpoch: 0,
        environment: "staging",
      }),
      currentAuthenticationEpoch: async () => 0,
    });
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      oauthApi,
      consumerAuth: {
        async authenticate(credential, requiredScope) {
          return authenticateServiceSession({
            credential,
            sessionStore: stores.sessionStore,
            serverSecret,
            audience: "https://wallet.agentpay.site/celo/mcp",
            environment: "staging",
            clock: () => new Date("2026-07-12T00:00:00.000Z"),
            currentAuthenticationEpoch: async () => 0,
            requiredScope,
          });
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    const localize = (url: URL | string) => {
      const remote = new URL(url);
      return new URL(`${remote.pathname}${remote.search}`, server.url);
    };

    try {
      const sdkDiscovery = await discoverOAuthServerInfo("https://wallet.agentpay.site/celo/mcp", {
        fetchFn: async (input, init) => {
          const target = input instanceof Request ? input.url : input.toString();
          return fetch(localize(target), init as RequestInit);
        },
      });
      assert.equal(sdkDiscovery.authorizationServerUrl, "https://wallet.agentpay.site/celo");
      assert.equal(sdkDiscovery.resourceMetadata?.resource, "https://wallet.agentpay.site/celo/mcp");
      assert.equal(sdkDiscovery.authorizationServerMetadata?.issuer, "https://wallet.agentpay.site/celo");

      const unauthenticated = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(unauthenticated.status, 401);
      const resourceMetadataMatch = /resource_metadata="([^"]+)"/.exec(unauthenticated.headers.get("www-authenticate") ?? "");
      assert.ok(resourceMetadataMatch);

      const protectedResource = await fetch(localize(resourceMetadataMatch[1]!));
      assert.equal(protectedResource.status, 200);
      const protectedResourceMetadata = (await protectedResource.json()) as {
        resource: string;
        authorization_servers: string[];
      };
      assert.equal(protectedResourceMetadata.resource, "https://wallet.agentpay.site/celo/mcp");

      const authorizationServer = protectedResourceMetadata.authorization_servers[0]!;
      const authorizationMetadataResponse = await fetch(
        localize(new URL("/.well-known/oauth-authorization-server/celo", authorizationServer)),
      );
      assert.equal(authorizationMetadataResponse.status, 200);
      const authorizationMetadata = await authorizationMetadataResponse.json() as Record<string, unknown>;
      const registrationResponse = await fetch(localize(authorizationMetadata.registration_endpoint as string), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "SDK OAuth HTTP test",
          redirect_uris: ["http://127.0.0.1:4588/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(registrationResponse.status, 201);
      const clientInformation = await registrationResponse.json() as {
        client_id: string;
        redirect_uris: string[];
      };

      const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServer, {
        metadata: authorizationMetadata as never,
        clientInformation: clientInformation as never,
        redirectUrl: clientInformation.redirect_uris[0]!,
        scope: "wallet:read",
        resource: new URL(protectedResourceMetadata.resource),
      });
      assert.equal(authorizationUrl.searchParams.has("state"), false);
      const authorizationPage = await fetch(localize(authorizationUrl));
      assert.equal(authorizationPage.status, 200);
      assert.match(authorizationPage.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
      const browserCookie = authorizationPage.headers.get("set-cookie");
      assert.ok(browserCookie);
      const authorizationId = /authorizationId":"([^"]+)"/.exec(await authorizationPage.text())?.[1];
      assert.ok(authorizationId);

      const challengeResponse = await fetch(localize("https://wallet.agentpay.site/celo/oauth/siwe/challenge"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: browserCookie },
        body: JSON.stringify({ authorizationId, ownerAddress: owner.address, chainId: 11142220 }),
      });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json() as { challengeId: string; message: string };
      const verifiedResponse = await fetch(localize("https://wallet.agentpay.site/celo/oauth/siwe/verify"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: browserCookie },
        body: JSON.stringify({
          authorizationId,
          challengeId: challenge.challengeId,
          signature: await owner.signMessage(challenge.message),
        }),
      });
      assert.equal(verifiedResponse.status, 200);
      const callback = new URL((await verifiedResponse.json() as { redirectUri: string }).redirectUri);
      assert.equal(callback.searchParams.has("state"), false);
      const code = callback.searchParams.get("code");
      assert.ok(code);

      const tokenRequest = prepareAuthorizationCodeRequest(code, codeVerifier, clientInformation.redirect_uris[0]!);
      tokenRequest.set("client_id", clientInformation.client_id);
      tokenRequest.set("resource", protectedResourceMetadata.resource);
      const tokenResponse = await fetch(localize(authorizationMetadata.token_endpoint as string), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenRequest,
      });
      assert.equal(tokenResponse.status, 200);
      const token = await tokenResponse.json() as { access_token: string; token_type: string };
      assert.equal(token.token_type, "Bearer");

      const authenticatedMcp = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(authenticatedMcp.status, 200);
      assert.match(await authenticatedMcp.text(), /execute_payment/);
    } finally {
      await server.close();
    }
  });

  it("authenticates consumer MCP requests and builds a tenant-scoped runtime", async () => {
    const trustedContext: SessionContext = createSessionContext({
      sessionId: "session_123",
      tenantId: "tenant_a",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      homeChainId: 11142220,
      audience: "https://wallet.agentpay.site/celo/mcp",
      environment: "staging",
      scopes: ["wallet:read"],
      authEpoch: 0,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });
    let receivedContext: SessionContext | undefined;
    const credential = "a".repeat(43);
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate(receivedCredential) {
          assert.equal(receivedCredential, credential);
          return trustedContext;
        },
      },
      createRuntime(_config, context) {
        receivedContext = context;
        return createRuntime();
      },
    });

    try {
      const response = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

      assert.equal(response.status, 200);
      assert.equal(receivedContext, trustedContext);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://wallet.agentpay.site");
    } finally {
      await server.close();
    }
  });

  it("enforces scope and owner-signature guards on real consumer MCP tool calls", async () => {
    const trustedContext: SessionContext = createSessionContext({
      sessionId: "session_123",
      tenantId: "tenant_a",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      homeChainId: 11142220,
      audience: "https://wallet.agentpay.site/celo/mcp",
      environment: "staging",
      scopes: ["payment:read"],
      authEpoch: 0,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });
    const credential = "b".repeat(43);
    const server = await startAgentPayHttpServer({
      env: { ...mcpEnv(), AGENTPAY_ENVIRONMENT: "staging" },
      hostname: "127.0.0.1",
      port: 0,
      mode: "consumer",
      consumerAuth: {
        async authenticate(receivedCredential) {
          assert.equal(receivedCredential, credential);
          return trustedContext;
        },
      },
      createRuntime() {
        return createRuntime();
      },
    });

    try {
      const headers = {
        authorization: `Bearer ${credential}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      const scopeResponse = await fetch(server.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_balance", arguments: {} },
        }),
      });
      assert.equal(scopeResponse.status, 200);
      assert.match(await scopeResponse.text(), /scope/i);

      const executionResponse = await fetch(server.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "execute_payment", arguments: { paymentIntentId: "pay_1", approvalText: "x" } },
        }),
      });
      assert.equal(executionResponse.status, 200);
      assert.match(await executionResponse.text(), /public paid ASP/i);
    } finally {
      await server.close();
    }
  });
});

function mcpEnv(): Record<string, string> {
  return {
    SUPABASE_URL: "https://agentpay.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    CELO_RPC_URL: "https://forno.celo-sepolia.celo-testnet.org",
    EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  };
}

function productionMcpEnv(): Record<string, string> {
  return {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_HOME_CHAIN_ID: "42220",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    SUPABASE_PRODUCTION_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "service-role-key",
    DIRECT_URL_PRODUCTION: "postgresql://production.example.invalid/postgres",
    CELO_MAINNET_RPC_URL: "https://rpc.provider.example/celo",
    CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
    CELO_ATTRIBUTION_TAG: "celo_agentpay",
    EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
    AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
    AGENTPAY_CONSUMER_MCP_URL: "https://wallet.agentpay.site/celo/mcp",
    AGENTPAY_PAID_MCP_URL: "https://mcp.agentpay.site/celo/mcp",
    AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
    AGENTPAY_PUBLIC_REVIEW_URL: "https://wallet.agentpay.site/celo/review",
    AGENTPAY_ONBOARDING_MANIFEST_PATH: "/run/agentpay-celo/onboarding.json",
    AGENTPAY_ONBOARDING_MANIFEST_SHA256: "a".repeat(64),
    AGENTPAY_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    AGENTPAY_FACTORY_RUNTIME_CODE_HASH: `0x${"2".repeat(64)}`,
    AGENTPAY_SETUP_SPONSOR_ADDRESS: "0x3333333333333333333333333333333333333333",
    AGENTPAY_SETUP_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    AGENTPAY_SETUP_MODE: "PUBLIC",
    SETUP_WEB_URL: "https://wallet.agentpay.site/celo/review",
  };
}

function productionIdentityFor(
  manifest: Record<string, any>,
  executionMode: "OFF" | "PUBLIC",
): RuntimeEnvironmentIdentity {
  return {
    id: 1,
    environment: "production",
    chainId: 42220,
    caip2: "eip155:42220",
    supabaseProjectRef: manifest.database.projectRef,
    migrationHead: manifest.database.migrationHead,
    releaseCommit: manifest.release.commit,
    manifestSha256: "f".repeat(64),
    accountVersion: "v2",
    accountAddress: manifest.contract.address,
    deploymentTxHash: manifest.contract.deploymentTxHash,
    creationBytecodeHash: manifest.contract.creationBytecodeHash,
    runtimeBytecodeHash: manifest.contract.runtimeBytecodeHash,
    abiSha256: manifest.release.abiSha256,
    ownerAddress: manifest.contract.ownerAddress,
    executorAddress: manifest.contract.executorAddress,
    deployerAddress: manifest.contract.deployerAddress,
    eip712VerifyingContract: manifest.contract.domain.verifyingContract,
    tokenAddress: manifest.token.address,
    tokenCodeHash: manifest.token.codeHash,
    tokenDecimals: manifest.token.decimals,
    x402Network: manifest.x402.network,
    x402Asset: manifest.x402.tokenAddress,
    x402Price: manifest.x402.price,
    x402PriceAtomic: manifest.x402.priceAtomic,
    x402SyncSettle: manifest.x402.syncSettle,
    x402Enabled: manifest.x402.enabled,
    payToAddress: null,
    facilitatorRef: null,
    executionMode,
    status: manifest.status,
  };
}

function makeDeployedProductionManifest(baseManifest: Record<string, any>): Record<string, any> {
  const manifest = structuredClone(baseManifest);
  const accountAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  manifest.kind = "agentpay-mainnet-activated-manifest";
  manifest.status = "DEPLOYED";
  manifest.executionMode = "OFF";
  manifest.database.projectRef = "abcdefghijklmnopqrst";
  manifest.release.commit = "a".repeat(40);
  manifest.release.runtimeBytecodeKeccak256 = `0x${"1".repeat(64)}`;
  manifest.release.abiSha256 = "2".repeat(64);
  manifest.contract.address = accountAddress;
  manifest.contract.deploymentTxHash = `0x${"3".repeat(64)}`;
  manifest.contract.runtimeBytecodeHash = manifest.release.runtimeBytecodeKeccak256;
  manifest.contract.ownerAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  manifest.contract.executorAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
  manifest.contract.deployerAddress = "0xdddddddddddddddddddddddddddddddddddddddd";
  manifest.contract.paused = false;
  manifest.contract.domain.verifyingContract = accountAddress;
  manifest.domains.publicOrigin = "https://mcp.agentpay.site";
  manifest.x402.enabled = false;
  manifest.activation = {
    sourceManifest: "celo-mainnet.shadow.json",
    accountDeployment: "DEPLOYED",
    executionEnabled: false,
  };

  return manifest;
}

function createRuntime(overrides: Partial<AgentPayRuntime> = {}): AgentPayRuntime {
  return {
    async prepareWalletCreation() {
      throw new Error("prepareWalletCreation was not expected.");
    },
    async checkWalletCreation() {
      throw new Error("checkWalletCreation was not expected.");
    },
    async getAgentWallet() {
      throw new Error("getAgentWallet was not expected.");
    },
    async getBalance() {
      throw new Error("getBalance was not expected.");
    },
    async parseInvoicePayment() {
      throw new Error("parseInvoicePayment was not expected.");
    },
    async searchX402Services() {
      throw new Error("searchX402Services was not expected.");
    },
    async prepareX402ServiceRequest() {
      throw new Error("prepareX402ServiceRequest was not expected.");
    },
    async parseX402PaymentRequired() {
      throw new Error("parseX402PaymentRequired was not expected.");
    },
    async retryX402Request() {
      throw new Error("retryX402Request was not expected.");
    },
    async prepareContractCall() {
      throw new Error("prepareContractCall was not expected.");
    },
    async quotePaymentRoute() {
      throw new Error("quotePaymentRoute was not expected.");
    },
    async checkRouteTargetAllowance() {
      throw new Error("checkRouteTargetAllowance was not expected.");
    },
    async prepareRouteTargetAllowance() {
      throw new Error("prepareRouteTargetAllowance was not expected.");
    },
    async prepareAccountAdminTransaction() {
      throw new Error("prepareAccountAdminTransaction was not expected.");
    },
    async preparePayment() {
      throw new Error("preparePayment was not expected.");
    },
    async getPaymentSignature() {
      throw new Error("getPaymentSignature was not expected.");
    },
    async executePayment() {
      throw new Error("executePayment was not expected.");
    },
    async preflightPayment(input) {
      return { paymentIntentId: input.paymentIntentId, intent: {} as never, input };
    },
    async executeAuthorizedPayment() {
      throw new Error("executeAuthorizedPayment was not expected.");
    },
    async trackPayment() {
      throw new Error("trackPayment was not expected.");
    },
    async listTransactions() {
      throw new Error("listTransactions was not expected.");
    },
    async listPaymentEvents() {
      throw new Error("listPaymentEvents was not expected.");
    },
    ...overrides,
  };
}

function createOAuthHttpTestStores(): {
  clientStore: OAuthClientStore;
  authorizationStore: OAuthAuthorizationStore;
  challengeStore: AuthChallengeStore;
  sessionStore: ServiceSessionStore;
} {
  const clients = new Map<string, OAuthClientRecord>();
  const authorizations = new Map<string, OAuthAuthorizationRecord>();
  const challenges = new Map<string, SiweChallenge>();
  const sessions = new Map<string, ServiceSessionRecord>();

  const sessionStore: ServiceSessionStore = {
    async create(record): Promise<void> {
      sessions.set(record.sessionId, record);
    },
    async findByCredentialDigest(digest): Promise<ServiceSessionRecord | null> {
      return [...sessions.values()].find((record) => record.credentialDigest === digest) ?? null;
    },
    async revoke(sessionId, revokedAt): Promise<void> {
      const record = sessions.get(sessionId);
      if (record) sessions.set(sessionId, { ...record, revokedAt });
    },
    async revokeAll(tenantId, revokedAt): Promise<void> {
      for (const [sessionId, record] of sessions) {
        if (record.tenantId === tenantId) sessions.set(sessionId, { ...record, revokedAt });
      }
    },
    async touch(sessionId, lastUsedAt): Promise<void> {
      const record = sessions.get(sessionId);
      if (record) sessions.set(sessionId, { ...record, lastUsedAt });
    },
  };

  return {
    clientStore: {
      async create(record): Promise<void> {
        clients.set(record.clientId, record);
      },
      async get(clientId): Promise<OAuthClientRecord | null> {
        return clients.get(clientId) ?? null;
      },
      async touch(clientId, lastUsedAt): Promise<void> {
        const record = clients.get(clientId);
        if (!record) throw new Error("OAuth client unavailable");
        clients.set(clientId, { ...record, lastUsedAt });
      },
    },
    authorizationStore: {
      async create(record): Promise<void> {
        authorizations.set(record.authorizationId, record);
      },
      async get(authorizationId): Promise<OAuthAuthorizationRecord | null> {
        return authorizations.get(authorizationId) ?? null;
      },
      async bindSiweChallenge(input): Promise<boolean> {
        const record = authorizations.get(input.authorizationId);
        if (!record || record.siweChallengeId || record.codeDigest || Date.parse(record.expiresAt) <= Date.parse(input.at)) return false;
        authorizations.set(input.authorizationId, { ...record, siweChallengeId: input.challengeId });
        return true;
      },
      async issueAuthorizationCode(input): Promise<boolean> {
        const record = authorizations.get(input.authorizationId);
        if (
          !record ||
          record.siweChallengeId !== input.challengeId ||
          record.codeDigest ||
          Date.parse(record.expiresAt) <= Date.parse(input.codeIssuedAt)
        ) return false;
        authorizations.set(input.authorizationId, {
          ...record,
          tenantId: input.tenantId,
          ownerAddress: input.ownerAddress.toLowerCase(),
          accountAddress: input.accountAddress.toLowerCase(),
          homeChainId: input.homeChainId,
          environment: input.environment,
          authenticationEpoch: input.authenticationEpoch,
          codeDigest: input.codeDigest,
          codeIssuedAt: input.codeIssuedAt,
          codeExpiresAt: input.codeExpiresAt,
        });
        return true;
      },
      async findByCodeDigest(codeDigest): Promise<OAuthAuthorizationRecord | null> {
        return [...authorizations.values()].find((record) => record.codeDigest === codeDigest) ?? null;
      },
      async consumeAuthorizationCode(input): Promise<OAuthAuthorizationRecord | null> {
        const record = authorizations.get(input.authorizationId);
        if (
          !record ||
          record.codeDigest !== input.codeDigest ||
          record.consumedAt ||
          !record.codeExpiresAt ||
          Date.parse(record.codeExpiresAt) <= Date.parse(input.consumedAt)
        ) return null;
        const consumed = { ...record, consumedAt: input.consumedAt };
        authorizations.set(input.authorizationId, consumed);
        return consumed;
      },
      async exchangeAuthorizationCode(input): Promise<OAuthAuthorizationRecord | null> {
        const record = authorizations.get(input.authorizationId);
        if (
          !record ||
          record.codeDigest !== input.codeDigest ||
          record.consumedAt ||
          !record.codeExpiresAt ||
          Date.parse(record.codeExpiresAt) <= Date.parse(input.consumedAt)
        ) return null;
        await sessionStore.create(input.session);
        const consumed = { ...record, consumedAt: input.consumedAt };
        authorizations.set(input.authorizationId, consumed);
        return consumed;
      },
    },
    challengeStore: {
      async create(record): Promise<void> {
        challenges.set(record.challengeId, record);
      },
      async get(challengeId): Promise<SiweChallenge | null> {
        return challenges.get(challengeId) ?? null;
      },
      async consume(challengeId, consumedAt): Promise<boolean> {
        const record = challenges.get(challengeId);
        if (!record || record.consumedAt) return false;
        challenges.set(challengeId, { ...record, consumedAt });
        return true;
      },
    },
    sessionStore,
  };
}

function createPaymentProcessor(overrides: Partial<AgentPayMcpPaymentProcessor>) {
  return {
    expectedPaymentRequirements: createExpectedPaymentRequirements(),
    async processHTTPRequest() {
      return {
        type: "no-payment-required",
      } as const;
    },
    async processSettlement() {
      return {
        success: true,
        transaction: `0x${"77".repeat(32)}`,
        network: "eip155:42220",
        headers: {},
        requirements: createPaymentRequirements(),
      };
    },
    ...overrides,
  } satisfies AgentPayMcpPaymentProcessor;
}

function createExpectedPaymentRequirements(
  assetTransferMethod = "eip3009",
  requirements: PaymentRequirements = createPaymentRequirements(),
): ExpectedX402PaymentRequirements {
  return {
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    assetTransferMethod,
  };
}

function createPaymentRequiredHeader(accepts: PaymentRequirements[]): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: "/mcp", description: "AgentPay public MCP endpoint" },
    accepts,
  })).toString("base64");
}

function createPaymentRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:42220",
    asset: "0x0000000000000000000000000000000000000001",
    amount: "1",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009" },
  };
}

function createPaymentPayload(payer = "0x4444444444444444444444444444444444444444"): PaymentPayload {
  return {
    x402Version: 2,
    accepted: createPaymentRequirements(),
    payload: {
      authorization: {
        from: payer,
      },
    },
  };
}

function createPermit2PaymentPayload(
  payer: string,
  requirements: PaymentRequirements = createPaymentRequirements(),
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      ...requirements,
      extra: { assetTransferMethod: "permit2" },
    },
    payload: {
      permit2Authorization: {
        from: payer,
      },
      signature: `0x${"11".repeat(65)}`,
    },
  };
}

function createCanaryPaymentRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:42220",
    asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    amount: "10000",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009" },
  };
}

function canaryPolicy() {
  return {
    allowlist: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      payerAddress: "0x3333333333333333333333333333333333333333",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    },
    caps: DEFAULT_CANARY_CAPS,
  };
}

function canaryIntent(): PaymentIntentRecord {
  const policy = canaryPolicy();
  return {
    id: "pay_canary",
    tenantId: policy.allowlist.tenantId,
    accountAddress: policy.allowlist.accountAddress,
    ownerAddress: policy.allowlist.ownerAddress,
    status: "AWAITING_APPROVAL",
    paymentType: "WALLET_PAYMENT",
    sourceChainId: 42220,
    destinationChainId: 42220,
    sourceTokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    sourceTokenSymbol: "USDC",
    destinationTokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    destinationTokenSymbol: "USDC",
    recipientAddress: policy.allowlist.recipientAddress,
    amountOut: "0.10",
    maxAmountIn: "0.10",
    minAmountOut: "0.10",
    nativeValue: "0",
    maxNativeFee: "0",
    routeProvider: "DIRECT",
    routeTarget: "0x0000000000000000000000000000000000000000",
    routeCalldata: "0x",
    routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    routeSummary: "Direct payment.",
    nonce: "1",
    deadline: "2099-01-01T00:00:00.000Z",
    purpose: "canary invoice",
    approvalPhrase: "APPROVE pay_canary",
  };
}

function createTestCanaryLedger(calls: string[] = []): CanaryLedgerStore {
  let reserved = false;
  return {
    async snapshot() {
      return {
        acceptedLifecycles: reserved ? 1 : 0,
        tenantDailyAtomic: reserved ? 100000n : 0n,
        globalDailyAtomic: reserved ? 100000n : 0n,
        tenantInFlight: reserved ? 1 : 0,
      };
    },
    async reserve() {
      calls.push("reserve");
      if (reserved) return { disposition: "REPLAY", usage: { acceptedLifecycles: 1, tenantDailyAtomic: 100000n, globalDailyAtomic: 100000n, tenantInFlight: 1 } };
      reserved = true;
      return { disposition: "RESERVED", usage: { acceptedLifecycles: 1, tenantDailyAtomic: 100000n, globalDailyAtomic: 100000n, tenantInFlight: 1 } };
    },
    async complete() {
      calls.push("complete");
      return { acceptedLifecycles: 1, tenantDailyAtomic: 100000n, globalDailyAtomic: 100000n, tenantInFlight: 0 };
    },
  };
}

function reservationIntent(): PaymentIntentRecord {
  return {
    id: "pay_reservation",
    tenantId: "tenant_1",
    accountAddress: "0x3333333333333333333333333333333333333333",
    ownerAddress: "0x4444444444444444444444444444444444444444",
    status: "AWAITING_APPROVAL",
    paymentType: "WALLET_PAYMENT",
    sourceChainId: 42220,
    destinationChainId: 42220,
    sourceTokenAddress: "0x5555555555555555555555555555555555555555",
    sourceTokenSymbol: "USDC",
    destinationTokenAddress: "0x5555555555555555555555555555555555555555",
    destinationTokenSymbol: "USDC",
    recipientAddress: "0x6666666666666666666666666666666666666666",
    amountOut: "1",
    maxAmountIn: "1",
    maxNativeFee: "0",
    routeProvider: "DIRECT",
    routeTarget: "0x0000000000000000000000000000000000000000",
    routeCalldata: "0x",
    routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    routeSummary: "Direct payment.",
    nonce: "1",
    deadline: "2099-01-01T00:00:00.000Z",
    purpose: "invoice payment",
    approvalPhrase: "APPROVE pay_reservation",
  };
}

function createFakeMcpServer(_runtime: AgentPayRuntime): ConnectableAgentPayMcpServer {
  return {
    registerTool() {},
    async connect() {},
    async close() {},
  } as unknown as ConnectableAgentPayMcpServer;
}
