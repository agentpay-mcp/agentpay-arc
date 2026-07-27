import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MCP_STREAMABLE_HTTP_ACCEPT,
  buildExecutePaymentMcpRequest,
  buildMcpRequestHeaders,
  parseCanaryCliArgs,
  parseMcpResponseBody,
  runCeloMainnetCanary,
  runCanaryCli,
} from "./celo-mainnet-canary.ts";

const mcpUrl = "https://mcp.agentpay.site/celo/mcp";
const readinessUrl = "https://mcp.agentpay.site/celo/readyz";
const ownerSignature = `0x${"11".repeat(65)}`;
const paymentRequired = Object.freeze({
  x402Version: 2 as const,
  resource: {
    url: mcpUrl,
    description: "AgentPay Celo MCP",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:42220",
      amount: "10000",
      asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      payTo: "0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121",
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "eip3009" },
    },
  ],
});
const expectedPayment = Object.freeze({
  resourceUrl: mcpUrl,
  scheme: "exact",
  network: "eip155:42220",
  amount: "10000",
  asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  payTo: "0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121",
  maxTimeoutSeconds: 300,
  assetTransferMethod: "eip3009",
});

describe("Celo mainnet canary operator", () => {
  it("sends the full Streamable HTTP Accept header on both challenge and paid requests", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let paymentSignatureCalls = 0;
    const mcpRequest = buildExecutePaymentMcpRequest({
      paymentIntentId: "pay_canary",
      signature: ownerSignature,
    });

    const result = await runCeloMainnetCanary({
      mcpUrl,
      readinessUrl,
      mcpRequest,
      expectedPayment,
      fetcher: async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url) === readinessUrl) {
          return jsonResponse({ code: "READY", mode: "CANARY", status: "READY" });
        }
        if (requests.filter((request) => request.url === mcpUrl).length === 1) {
          return jsonResponse({ error: "Payment required." }, 402, {
            "payment-required": "encoded",
          });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: mcpRequest.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ status: "EXECUTING" }) }],
          },
        }, 200, {
          "payment-response": "settled",
        });
      },
      paymentClient: {
        readPaymentRequired() {
          return paymentRequired;
        },
        async createPaymentSignature() {
          paymentSignatureCalls += 1;
          return "signed-x402-payload";
        },
        readSettlement() {
          return {
            success: true,
            transaction: `0x${"22".repeat(32)}`,
            network: "eip155:42220",
          };
        },
      },
    });

    const mcpRequests = requests.filter((request) => request.url === mcpUrl);
    assert.equal(mcpRequests.length, 2);
    for (const request of mcpRequests) {
      const headers = new Headers(request.init.headers);
      assert.equal(headers.get("accept"), MCP_STREAMABLE_HTTP_ACCEPT);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
    }
    assert.equal(new Headers(mcpRequests[0].init.headers).has("payment-signature"), false);
    assert.equal(
      new Headers(mcpRequests[1].init.headers).get("payment-signature"),
      "signed-x402-payload",
    );
    assert.equal(mcpRequests[0].init.body, mcpRequests[1].init.body);
    assert.equal(paymentSignatureCalls, 1);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.settlement.transaction, `0x${"22".repeat(32)}`);
  });

  it("refuses drifted x402 terms before creating a payer signature", async () => {
    let paymentSignatureCalls = 0;
    let paidRequests = 0;

    await assert.rejects(
      runCeloMainnetCanary({
        mcpUrl,
        readinessUrl,
        mcpRequest: buildExecutePaymentMcpRequest({
          paymentIntentId: "pay_canary",
          signature: ownerSignature,
        }),
        expectedPayment,
        fetcher: async (url) => {
          if (String(url) === readinessUrl) {
            return jsonResponse({ code: "READY", mode: "CANARY", status: "READY" });
          }
          paidRequests += 1;
          return jsonResponse({ error: "Payment required." }, 402);
        },
        paymentClient: {
          readPaymentRequired() {
            return {
              ...paymentRequired,
              accepts: [{ ...paymentRequired.accepts[0], payTo: "0x9999999999999999999999999999999999999999" }],
            };
          },
          async createPaymentSignature() {
            paymentSignatureCalls += 1;
            return "must-not-be-created";
          },
          readSettlement() {
            throw new Error("Settlement must not be read.");
          },
        },
      }),
      /payTo/i,
    );

    assert.equal(paidRequests, 1);
    assert.equal(paymentSignatureCalls, 0);
  });

  it("parses a successful MCP JSON-RPC response from an SSE envelope", () => {
    const parsed = parseMcpResponseBody([
      "event: message",
      'data: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}',
      "",
    ].join("\n"));

    assert.deepEqual(parsed, {
      jsonrpc: "2.0",
      id: 7,
      result: { content: [] },
    });
  });

  it("rejects unsafe payment header values instead of changing request semantics", () => {
    assert.throws(
      () => buildMcpRequestHeaders("signed\r\nx-injected: yes"),
      /payment signature/i,
    );
  });

  it("requires an explicit mainnet execution flag and never accepts signatures as CLI arguments", () => {
    assert.throws(
      () => parseCanaryCliArgs(["--payment-intent-id", "pay_canary"]),
      /execute-mainnet-canary/i,
    );
    assert.throws(
      () => parseCanaryCliArgs([
        "--payment-intent-id",
        "pay_canary",
        "--execute-mainnet-canary",
        "--signature",
        ownerSignature,
      ]),
      /unknown option/i,
    );
    assert.throws(
      () => parseCanaryCliArgs([
        "--payment-intent-id",
        "pay_canary",
        "--execute-mainnet-canary",
        "--manifest",
        "/tmp/untrusted.json",
      ]),
      /unknown option/i,
    );
    const accidentallyPastedKey = `0x${"12".repeat(32)}`;
    assert.throws(
      () => parseCanaryCliArgs([accidentallyPastedKey]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unknown option/i);
        assert.doesNotMatch(error.message, new RegExp(accidentallyPastedKey));
        return true;
      },
    );
    assert.deepEqual(
      parseCanaryCliArgs(["--payment-intent-id", "pay_canary", "--execute-mainnet-canary"]),
      {
        execute: true,
        help: false,
        paymentIntentId: "pay_canary",
      },
    );
  });

  it("treats a lost paid response as ambiguous and requires durable review before retry", async () => {
    let mcpCalls = 0;

    await assert.rejects(
      runCeloMainnetCanary({
        mcpUrl,
        readinessUrl,
        mcpRequest: buildExecutePaymentMcpRequest({
          paymentIntentId: "pay_canary",
          signature: ownerSignature,
        }),
        expectedPayment,
        fetcher: async (url) => {
          if (String(url) === readinessUrl) {
            return jsonResponse({ code: "READY", mode: "CANARY", status: "READY" });
          }
          mcpCalls += 1;
          if (mcpCalls === 1) return jsonResponse({ error: "Payment required." }, 402);
          throw new Error("socket closed");
        },
        paymentClient: {
          readPaymentRequired() {
            return paymentRequired;
          },
          async createPaymentSignature() {
            return "signed-x402-payload";
          },
          readSettlement() {
            throw new Error("Settlement must not be read.");
          },
        },
      }),
      /durable lifecycle.*before retrying/i,
    );
  });

  it("runs the tracked-manifest CLI path through injectable offline operator dependencies", async () => {
    const output: string[] = [];
    let preflightInput: Record<string, unknown> | undefined;
    let runInput: Record<string, unknown> | undefined;

    await runCanaryCli(
      ["--payment-intent-id", "pay_canary", "--execute-mainnet-canary"],
      {
        AGENTPAY_CANARY_OWNER_SIGNATURE: ownerSignature,
        AGENTPAY_CANARY_PAYER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
        CELO_MAINNET_RPC_URL: "https://forno.celo.org",
      },
      {
        async computeArtifactDigests() {
          return {
            packageLockSha256: "91b857d17fb7c7e65d312135595275b72887c0b73510f935de9a8a26d09fe68e",
            creationBytecodeKeccak256: "0x2ede9e46a03a9b3d8e8dc322905443b0fedfabd324c54c73fe1c748f10d0152a",
          };
        },
        createPayerSigner() {
          return {
            address: "0x98802C2d45284F2bcA06BF3d6bdb41221a7Cc5cD",
            async signTypedData() {
              return `0x${"33".repeat(65)}`;
            },
          };
        },
        async assertPayerPreflight(input) {
          preflightInput = { ...input };
        },
        async runCanary(input) {
          runInput = { ...input };
          return {
            httpStatus: 200,
            mcpResponse: {},
            settlement: {
              success: true,
              transaction: `0x${"44".repeat(32)}`,
              network: "eip155:42220",
            },
          };
        },
        write(message) {
          output.push(message);
        },
      },
    );

    assert.deepEqual(preflightInput, {
      rpcUrl: "https://forno.celo.org/",
      payerAddress: "0x98802C2d45284F2bcA06BF3d6bdb41221a7Cc5cD",
      accountAddress: "0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121",
      amountAtomic: 10_000n,
    });
    assert.equal(runInput?.mcpUrl, mcpUrl);
    assert.equal(runInput?.readinessUrl, readinessUrl);
    assert.deepEqual(output, [
      "Celo mainnet canary completed.",
      "Payment intent: pay_canary",
      "MCP HTTP status: 200",
      `x402 settlement transaction: 0x${"44".repeat(32)}`,
    ]);
  });
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
