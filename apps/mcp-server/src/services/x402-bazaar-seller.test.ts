import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createArcGatewayPaidService,
  createTenantArcGatewaySellerSettlementRepository,
  type ArcGatewayMiddlewareLike,
  type ArcGatewaySellerSettlementRepository,
} from "./x402-bazaar.ts";

describe("Arc Gateway paid-service seller", () => {
  it("returns 402 unpaid, settles before delivery, and replays a payment identifier once", async () => {
    const events: string[] = [];
    let beforeSettle: ((context: any) => Promise<any>) | undefined;
    let afterSettle: ((context: any) => Promise<void>) | undefined;
    let settleCalls = 0;
    const middleware: ArcGatewayMiddlewareLike = {
      require: () => async (request, response, next) => {
        const signature = request.headers["payment-signature"];
        if (!signature) {
          response.statusCode = 402;
          response.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify({
            x402Version: 2,
            accepts: [{
              scheme: "exact",
              network: "eip155:5042002",
              asset: "0x3600000000000000000000000000000000000000",
              amount: "10000",
            }],
          })).toString("base64"));
          response.end("{}");
          return;
        }
        const paymentPayload = JSON.parse(
          Buffer.from(String(signature), "base64").toString(),
        );
        const requirements = {
          scheme: "exact",
          network: "eip155:5042002",
          asset: "0x3600000000000000000000000000000000000000",
          amount: "10000",
          payTo: "0x2222222222222222222222222222222222222222",
        };
        const election = await beforeSettle!({ paymentPayload, requirements });
        if (!election?.skip) {
          settleCalls += 1;
          events.push("settle");
          await afterSettle!({
            paymentPayload,
            requirements,
            result: {
              success: true,
              payer: "0x1111111111111111111111111111111111111111",
              transaction: `0x${"a".repeat(64)}`,
              network: "eip155:5042002",
            },
          });
        }
        await next();
      },
      onBeforeSettle(hook) {
        beforeSettle = hook;
        return this;
      },
      onAfterSettle(hook) {
        afterSettle = hook;
        return this;
      },
    };
    const records = new Map<string, any>();
    const repository: ArcGatewaySellerSettlementRepository = {
      async claim(record) {
        const existing = records.get(record.paymentIdentifier);
        if (existing) return { claimed: false, record: structuredClone(existing) };
        records.set(record.paymentIdentifier, structuredClone(record));
        return { claimed: true, record: structuredClone(record) };
      },
      async complete(record) {
        records.set(record.paymentIdentifier, structuredClone(record));
        return structuredClone(record);
      },
    };
    const service = createArcGatewayPaidService({
      sellerAddress: "0x2222222222222222222222222222222222222222",
      sellerAgentId: "seller-agent",
      resourceUrl: "https://seller.example/premium",
      price: "0.01",
      repository,
      gatewayFactory(config) {
        assert.deepEqual(config, {
          sellerAddress: "0x2222222222222222222222222222222222222222",
          networks: "eip155:5042002",
          facilitatorUrl: "https://gateway-api-testnet.circle.com",
          description: "AgentPay paid service",
        });
        return middleware;
      },
      clock: () => new Date("2026-07-27T01:00:00.000Z"),
    });

    const unpaid = await invoke(service.handle, {}, events);
    assert.equal(unpaid.statusCode, 402);
    const challenge = JSON.parse(
      Buffer.from(String(unpaid.headers["PAYMENT-REQUIRED"]), "base64").toString(),
    );
    assert.deepEqual(challenge.accepts[0], {
      scheme: "exact",
      network: "eip155:5042002",
      asset: "0x3600000000000000000000000000000000000000",
      amount: "10000",
    });

    const signature = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: { network: "eip155:5042002" },
      payload: {
        authorization: {
          from: "0x1111111111111111111111111111111111111111",
          nonce: `0x${"b".repeat(64)}`,
        },
        signature: `0x${"c".repeat(130)}`,
      },
    })).toString("base64");
    assert.equal((await invoke(service.handle, { "payment-signature": signature }, events)).statusCode, 200);
    assert.equal((await invoke(service.handle, { "payment-signature": signature }, events)).statusCode, 200);
    assert.equal(settleCalls, 1);
    assert.deepEqual(events, ["settle", "deliver", "deliver"]);
    const record = records.get(`gateway-0x${"b".repeat(64)}`);
    assert.equal(record.buyerAgentId, "circle-agent-wallet:0x1111111111111111111111111111111111111111");
    assert.equal(record.sellerAgentId, "seller-agent");
    assert.equal(record.serviceUrl, "https://seller.example/premium");
    assert.equal(record.status, "SETTLED");
    assert.doesNotMatch(JSON.stringify(record), /signature|credential|private.?key/i);
  });

  it("rejects unsafe URLs and over-precision prices before creating middleware", () => {
    const repository: ArcGatewaySellerSettlementRepository = {
      claim: async (record) => ({ claimed: true, record }),
      complete: async (record) => record,
    };
    for (const config of [
      { resourceUrl: "http://seller.example/premium", price: "0.01" },
      { resourceUrl: "https://127.0.0.1/premium", price: "0.01" },
      { resourceUrl: "https://seller.example/premium", price: "0.0000001" },
    ]) {
      assert.throws(() => createArcGatewayPaidService({
        sellerAddress: "0x2222222222222222222222222222222222222222",
        sellerAgentId: "seller",
        repository,
        gatewayFactory: () => ({
          require: () => async () => {},
          onBeforeSettle() { return this; },
          onAfterSettle() { return this; },
        }),
        clock: () => new Date(),
        ...config,
      }));
    }
  });

  it("rejects unsafe hosted request method, headers, and oversized body before Gateway", async () => {
    let gatewayCalls = 0;
    const service = createArcGatewayPaidService({
      sellerAddress: "0x2222222222222222222222222222222222222222",
      sellerAgentId: "seller",
      resourceUrl: "https://seller.example/premium",
      price: "0.01",
      repository: {
        claim: async (record) => ({ claimed: true, record }),
        complete: async (record) => record,
      },
      gatewayFactory: () => ({
        require: () => async () => { gatewayCalls += 1; },
        onBeforeSettle() { return this; },
        onAfterSettle() { return this; },
      }),
      clock: () => new Date(),
    });
    for (const request of [
      { method: "POST", url: "/premium", headers: {} },
      { method: "GET", url: "/premium", headers: { authorization: "secret" } },
      { method: "GET", url: "/premium", headers: {}, body: "x".repeat(65_537) },
      { method: "GET", url: "/other", headers: {} },
    ]) {
      const response = {
        statusCode: 200,
        setHeader() {},
        end() {},
      };
      await service.handle(request, response, () => {});
      assert.equal(response.statusCode, 400);
    }
    assert.equal(gatewayCalls, 0);
  });

  it("persists seller elections through tenant-bound claim and completion RPCs", async () => {
    const tenantId = "8e5d1144-5e2a-4c82-8e91-8cc620be21b8";
    const record = {
      paymentIdentifier: "payment-identifier-0001",
      buyerAgentId: "buyer-agent",
      sellerAgentId: "seller-agent",
      serviceUrl: "https://seller.example/premium",
      amountAtomic: "10000",
      maxAmount: "0.01",
      network: "eip155:5042002" as const,
      asset: "0x3600000000000000000000000000000000000000" as const,
      status: "CLAIMED" as const,
      createdAt: "2026-07-27T01:00:00.000Z",
      updatedAt: "2026-07-27T01:00:00.000Z",
    };
    const row = {
      tenant_id: tenantId,
      payment_identifier: record.paymentIdentifier,
      buyer_agent_id: record.buyerAgentId,
      seller_agent_id: record.sellerAgentId,
      service_url: record.serviceUrl,
      amount_atomic: record.amountAtomic,
      max_amount: record.maxAmount,
      network: record.network,
      asset: record.asset,
      status: record.status,
      settlement_result: null,
      proof: null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
    const calls: string[] = [];
    const repository = createTenantArcGatewaySellerSettlementRepository({
      async rpc(name) {
        calls.push(name);
        return name === "claim_arc_gateway_seller_settlement"
          ? { data: { claimed: true, record: row }, error: null }
          : {
              data: {
                ...row,
                status: "SETTLED",
                settlement_result: { success: true },
                proof: {
                  network: record.network,
                  scheme: "exact",
                  seller: "0x2222222222222222222222222222222222222222",
                },
              },
              error: null,
            };
      },
    }, tenantId);

    assert.equal((await repository.claim(record)).claimed, true);
    await repository.complete({
      ...record,
      status: "SETTLED",
      settlementResult: { success: true },
      proof: {
        network: record.network,
        scheme: "exact",
        seller: "0x2222222222222222222222222222222222222222",
      },
    });
    assert.deepEqual(calls, [
      "claim_arc_gateway_seller_settlement",
      "complete_arc_gateway_seller_settlement",
    ]);
  });

  it("does not deliver protected content when the SDK swallows durable after-settle failure", async () => {
    let beforeSettle: ((context: any) => Promise<any>) | undefined;
    let afterSettle: ((context: any) => Promise<void>) | undefined;
    let stored: any;
    let delivered = false;
    const middleware: ArcGatewayMiddlewareLike = {
      require: () => async (request, _response, next) => {
        const paymentPayload = JSON.parse(
          Buffer.from(String(request.headers["payment-signature"]), "base64").toString(),
        );
        const requirements = {
          scheme: "exact",
          network: "eip155:5042002",
          asset: "0x3600000000000000000000000000000000000000",
          amount: "10000",
          payTo: "0x2222222222222222222222222222222222222222",
        };
        await beforeSettle!({ paymentPayload, requirements });
        try {
          await afterSettle!({
            paymentPayload,
            requirements,
            result: {
              success: true,
              transaction: `0x${"a".repeat(64)}`,
              network: "eip155:5042002",
            },
          });
        } catch {
          // Matches the installed SDK: after-settle hook errors are swallowed.
        }
        await next();
      },
      onBeforeSettle(hook) { beforeSettle = hook; return this; },
      onAfterSettle(hook) { afterSettle = hook; return this; },
    };
    const service = createArcGatewayPaidService({
      sellerAddress: "0x2222222222222222222222222222222222222222",
      sellerAgentId: "seller",
      resourceUrl: "https://seller.example/premium",
      price: "0.01",
      gatewayFactory: () => middleware,
      repository: {
        async claim(record) {
          if (!stored) stored = structuredClone(record);
          return { claimed: stored.status === "CLAIMED" && stored === record, record: structuredClone(stored) };
        },
        async complete() {
          throw new Error("database unavailable");
        },
      },
      clock: () => new Date("2026-07-27T01:00:00.000Z"),
    });
    const signature = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: { network: "eip155:5042002" },
      payload: {
        authorization: {
          from: "0x1111111111111111111111111111111111111111",
          nonce: `0x${"d".repeat(64)}`,
        },
        signature: `0x${"e".repeat(130)}`,
      },
    })).toString("base64");
    const request = {
      method: "GET",
      url: "/premium",
      headers: { "payment-signature": signature },
    };
    const response = { statusCode: 200, setHeader() {}, end() {} };

    await assert.rejects(
      service.handle(request, response, () => { delivered = true; }),
      /durably recorded/i,
    );
    assert.equal(delivered, false);
  });
});

async function invoke(
  handler: ReturnType<typeof createArcGatewayPaidService>["handle"],
  headers: Record<string, string>,
  events: string[],
) {
  const responseHeaders: Record<string, string | number | readonly string[]> = {};
  let body = "";
  const request = { method: "GET", url: "/premium", headers } as any;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders[name] = value;
    },
    end(chunk?: string) {
      body += chunk ?? "";
    },
  } as any;
  await handler(request, response, async () => {
    events.push("deliver");
    response.statusCode = 200;
    response.end(JSON.stringify({ content: "premium" }));
  });
  return { statusCode: response.statusCode, headers: responseHeaders, body };
}
