import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARC_TESTNET_CAIP2,
  createArcPaidServiceQuoteBinding,
  type ArcAgentCommerceReceipt,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";
import {
  createInspectPaidServiceHandler,
  createPayPaidServiceHandler as createPayPaidServiceHandlerUnderTest,
  createSearchPaidServicesHandler,
  createTenantArcAgentCommerceRepository,
  type ArcAgentCommerceRepository,
  type PayPaidServiceDependencies,
} from "./circle-services.ts";

const BUYER = "buyer-agent";
const SELLER = "seller-agent";
const WALLET = "0x1111111111111111111111111111111111111111";
const SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
const IDEMPOTENCY_KEY = "c93cc97f-ff9d-4fe1-a98e-9e6a655bf924";
const URL = "https://seller.example/v1/report";
const NOW = new Date("2026-07-27T01:00:00.000Z");

const allowAllCompliance = {
  screen: async () => ({
    allowed: true,
    engineDecision: "UNAVAILABLE" as const,
    evidence: [],
  }),
};

function createPayPaidServiceHandler(
  dependencies: Omit<PayPaidServiceDependencies, "compliance"> & {
    readonly compliance?: PayPaidServiceDependencies["compliance"];
  },
) {
  return createPayPaidServiceHandlerUnderTest({
    ...dependencies,
    compliance: dependencies.compliance ?? allowAllCompliance,
  });
}

function fakeCircle(overrides: Partial<CircleCli> = {}): CircleCli {
  return {
    status: async () => ({
      type: "agent",
      mainnet: { tokenStatus: "NOT_LOGGED_IN" },
      testnet: { tokenStatus: "VALID" },
    }),
    listAgentWallets: async () => [{ address: WALLET, type: "agent", blockchain: "ARC-TESTNET" }],
    getBalance: async () => ({
      balances: [{
        amount: "2.5",
        token: {
          name: "USD Coin",
          symbol: "USDC",
          blockchain: "ARC-TESTNET",
          decimals: 6,
          isNative: false,
          tokenAddress: "0x3600000000000000000000000000000000000000",
        },
      }],
    }),
    getGatewayBalance: async () => ({
      message: "ok",
      address: WALLET,
      backingEOA: WALLET,
      total: "1.5",
      token: "USDC",
      balances: [],
    }),
    searchServices: async () => [{ url: URL, name: SELLER }],
    inspectService: async (request) => ({
      status: "payable",
      httpStatus: 402,
      url: request.url,
      method: request.method ?? "GET",
      price: { amount: "1250000", formatted: "$1.25" },
      chains: [ARC_TESTNET_CAIP2],
      scheme: "exact",
      seller: SELLER_ADDRESS,
    }),
    payService: async () => ({
      response: { report: "paid content" },
      payment: {
        amount: "1.25",
        chain: "ARC-TESTNET",
        scheme: "exact",
        seller: SELLER_ADDRESS,
        receipt: Buffer.from(JSON.stringify({
          success: true,
          network: ARC_TESTNET_CAIP2,
          transaction: `0x${"a".repeat(64)}`,
          payer: WALLET,
        })).toString("base64"),
      },
    }),
    ...overrides,
  } as CircleCli;
}

function encodeProof(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function memoryRepository(): ArcAgentCommerceRepository & {
  read(): ArcAgentCommerceReceipt | null;
} {
  let receipt: ArcAgentCommerceReceipt | null = null;
  return {
    read: () => receipt ? structuredClone(receipt) : null,
    getByIdempotencyKey: async () => receipt ? structuredClone(receipt) : null,
    async claim(next) {
      if (receipt) {
        return { claimed: false, receipt: structuredClone(receipt) };
      }
      receipt = structuredClone(next);
      return { claimed: true, receipt: structuredClone(receipt) };
    },
    async complete(next, expectedStatus) {
      assert.equal(receipt?.status, expectedStatus);
      receipt = structuredClone(next);
      return structuredClone(receipt);
    },
  };
}

describe("Circle paid service buyer tools", () => {
  it("searches and inspects through Circle CLI as read-only operations", async () => {
    const circleCli = fakeCircle();
    const search = createSearchPaidServicesHandler({ circleCli });
    const inspect = createInspectPaidServiceHandler({ circleCli, clock: () => NOW });

    const services = await search({ query: "report", limit: 5 });
    const quote = await inspect({
      url: URL,
      method: "POST",
      headers: { Accept: "application/json" },
      body: "{\"topic\":\"arc\"}",
    });

    assert.equal(services.services[0]?.url, URL);
    assert.equal(quote.quote.amountAtomic, "1250000");
    assert.equal(quote.quote.amount, "1.25");
    assert.equal(quote.quote.network, ARC_TESTNET_CAIP2);
    assert.equal(Object.isFrozen(quote.quote), true);
  });

  it("re-inspects the exact request, authenticates the selected SCA budget, and pays exactly once", async () => {
    let inspections = 0;
    let payments = 0;
    let paidInput: unknown;
    const circleCli = fakeCircle({
      inspectService: async (request) => {
        inspections += 1;
        return await fakeCircle().inspectService(request);
      },
      payService: async (input) => {
        payments += 1;
        paidInput = input;
        return await fakeCircle().payService(input);
      },
    });
    const repository = memoryRepository();
    const request = { url: URL, method: "POST" as const, headers: {}, body: "{\"topic\":\"arc\"}" };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const pay = createPayPaidServiceHandler({
      circleCli,
      commerce: repository,
      clock: () => NOW,
    });

    const result = await pay({
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      walletAddress: WALLET,
      request,
      inspectedQuote: quote,
    });

    assert.equal(inspections, 1);
    assert.equal(payments, 1);
    assert.deepEqual(paidInput, {
      ...request,
      address: WALLET,
      maxAmount: "1.25",
    });
    assert.equal(result.receipt.status, "SETTLED");
    assert.equal(result.receipt.buyerAgentId, BUYER);
    assert.equal(result.receipt.sellerAgentId, SELLER);
    assert.equal(result.receipt.proof?.network, ARC_TESTNET_CAIP2);
    assert.doesNotMatch(JSON.stringify(repository.read()), /signature|credential/i);
  });

  it("requires a decodable Arc payer and transaction proof before marking settlement", async () => {
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const invalidReceipts: readonly (string | undefined)[] = [
      undefined,
      "x".repeat(16_385),
      "not-base64-json",
      Buffer.from("null").toString("base64"),
      encodeProof({ network: "eip155:1", transaction: `0x${"a".repeat(64)}`, payer: WALLET }),
      encodeProof({ network: ARC_TESTNET_CAIP2, payer: WALLET }),
      encodeProof({ network: ARC_TESTNET_CAIP2, transaction: "0x1234", payer: WALLET }),
      encodeProof({
        network: ARC_TESTNET_CAIP2,
        transaction: `0x${"a".repeat(64)}`,
        payer: "not-an-address",
      }),
      encodeProof({
        network: ARC_TESTNET_CAIP2,
        transaction: `0x${"a".repeat(64)}`,
        payer: SELLER_ADDRESS,
      }),
    ];

    for (const receipt of invalidReceipts) {
      const repository = memoryRepository();
      const pay = createPayPaidServiceHandler({
        circleCli: fakeCircle({
          payService: async () => ({
            response: { report: "paid content without verifiable proof" },
            payment: {
              amount: "1.25",
              chain: "ARC-TESTNET",
              scheme: "exact",
              seller: SELLER_ADDRESS,
              ...(receipt === undefined ? {} : { receipt }),
            },
          }),
        }),
        commerce: repository,
        clock: () => NOW,
      });

      const result = await pay({
        idempotencyKey: IDEMPOTENCY_KEY,
        buyerAgentId: BUYER,
        sellerAgentId: SELLER,
        request,
        inspectedQuote: quote,
      });

      assert.equal(result.receipt.status, "RECONCILIATION_REQUIRED");
      assert.equal(result.receipt.proof, undefined);
      assert.equal(repository.read()?.status, "RECONCILIATION_REQUIRED");
    }
  });

  it("screens the seller after its atomic claim and before paying for a service", async () => {
    let payments = 0;
    const repository = memoryRepository();
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const pay = createPayPaidServiceHandler({
      circleCli: fakeCircle({
        payService: async (input) => {
          payments += 1;
          return fakeCircle().payService(input);
        },
      }),
      commerce: repository,
      compliance: {
        screen: async (input) => {
          assert.deepEqual(input, {
            operationId: IDEMPOTENCY_KEY,
            address: SELLER_ADDRESS,
            direction: "SEND",
            channel: "AGENT_WALLET_PAID_SERVICE",
          });
          throw new Error("Payment blocked by compliance.");
        },
      },
      clock: () => NOW,
    });

    const result = await pay({
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: quote,
    });
    assert.equal(payments, 0);
    assert.equal(result.receipt.status, "RECONCILIATION_REQUIRED");
    assert.equal(result.receipt.settlementResult?.outcome, "COMPLIANCE_BLOCKED");
    assert.equal(repository.read()?.status, "RECONCILIATION_REQUIRED");
  });

  it("atomically elects one concurrent payer before the Circle mutation", async () => {
    const repository = memoryRepository();
    let payments = 0;
    const circleCli = fakeCircle({
      payService: async (input) => {
        payments += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await fakeCircle().payService(input);
      },
    });
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const pay = createPayPaidServiceHandler({ circleCli, commerce: repository, clock: () => NOW });
    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: quote,
    };

    const results = await Promise.all([pay(input), pay(input)]);

    assert.equal(payments, 1);
    assert.ok(results.some((result) => result.receipt.status === "CLAIMED"));
    assert.ok(results.some((result) => result.receipt.status === "SETTLED"));
  });

  it("rejects quote drift, replay mismatch, expiry, incompatible terms, and insufficient budget", async () => {
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const cases: Array<{ circleCli: CircleCli; clock?: () => Date; input?: Record<string, unknown> }> = [
      { circleCli: fakeCircle({ inspectService: async () => ({ ...(await fakeCircle().inspectService(request)), price: { amount: "1250001", formatted: "$1.250001" } }) }) },
      { circleCli: fakeCircle({ inspectService: async () => ({ ...(await fakeCircle().inspectService(request)), chains: ["eip155:84532"] }) }) },
      { circleCli: fakeCircle({ inspectService: async () => ({ ...(await fakeCircle().inspectService(request)), scheme: "eip3009" }) }) },
      { circleCli: fakeCircle(), clock: () => new Date(NOW.getTime() + 120_000) },
      { circleCli: fakeCircle({ getBalance: async () => ({ balances: [] }), getGatewayBalance: async () => ({ ...(await fakeCircle().getGatewayBalance(WALLET)), total: "0.1" }) }) },
      { circleCli: fakeCircle(), input: { request: { ...request, url: "https://other.example/report" } } },
    ];

    for (const testCase of cases) {
      let payments = 0;
      const repository = memoryRepository();
      const circleCli = fakeCircle({
        ...testCase.circleCli,
        payService: async () => {
          payments += 1;
          return await fakeCircle().payService({ ...request, address: WALLET, maxAmount: "1.25" });
        },
      });
      const pay = createPayPaidServiceHandler({
        circleCli,
        commerce: repository,
        clock: testCase.clock ?? (() => NOW),
      });
      await assert.rejects(pay({
        idempotencyKey: IDEMPOTENCY_KEY,
        buyerAgentId: BUYER,
        sellerAgentId: SELLER,
        request,
        inspectedQuote: quote,
        ...testCase.input,
      }));
      assert.equal(payments, 0);
    }
  });

  it("marks a crash-window failure for reconciliation and never retries mutation", async () => {
    const repository = memoryRepository();
    let payments = 0;
    const circleCli = fakeCircle({
      payService: async () => {
        payments += 1;
        throw new Error("unknown mutation outcome with signature=secret");
      },
    });
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const pay = createPayPaidServiceHandler({ circleCli, commerce: repository, clock: () => NOW });
    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: quote,
    };

    const first = await pay(input);
    const second = await pay(input);

    assert.equal(payments, 1);
    assert.equal(first.receipt.status, "RECONCILIATION_REQUIRED");
    assert.equal(second.receipt.status, "RECONCILIATION_REQUIRED");
    assert.doesNotMatch(JSON.stringify(first), /secret|signature/i);
  });

  it("replays a sequential settled receipt without a second mutation", async () => {
    const repository = memoryRepository();
    let payments = 0;
    const circleCli = fakeCircle({
      payService: async (input) => {
        payments += 1;
        return await fakeCircle().payService(input);
      },
    });
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    const pay = createPayPaidServiceHandler({ circleCli, commerce: repository, clock: () => NOW });
    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: quote,
    };
    assert.equal((await pay(input)).receipt.status, "SETTLED");
    assert.equal((await pay(input)).receipt.status, "SETTLED");
    assert.equal(payments, 1);
  });

  it("fails closed for unauthenticated or ambiguous Circle Agent Wallet selection", async () => {
    const request = { url: URL, method: "GET" as const, headers: {} };
    const quote = createArcPaidServiceQuoteBinding({
      request,
      amountAtomic: "1250000",
      seller: SELLER_ADDRESS,
      inspectedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    for (const circleCli of [
      fakeCircle({
        status: async () => ({
          type: "agent",
          mainnet: { tokenStatus: "NOT_LOGGED_IN" },
          testnet: { tokenStatus: "EXPIRED" },
        }),
      }),
      fakeCircle({
        listAgentWallets: async () => [
          { address: WALLET, type: "agent", blockchain: "ARC-TESTNET" },
          { address: SELLER_ADDRESS, type: "agent", blockchain: "ARC-TESTNET" },
        ],
      }),
    ]) {
      const pay = createPayPaidServiceHandler({
        circleCli,
        commerce: memoryRepository(),
        clock: () => NOW,
      });
      await assert.rejects(pay({
        idempotencyKey: IDEMPOTENCY_KEY,
        buyerAgentId: BUYER,
        sellerAgentId: SELLER,
        request,
        inspectedQuote: quote,
      }));
    }
  });

  it("supports an explicit quote TTL and fails closed when durable completion is unavailable", async () => {
    const inspect = createInspectPaidServiceHandler({
      circleCli: fakeCircle({
        inspectService: async (request) => ({
          ...(await fakeCircle().inspectService(request)),
          description: "Premium Arc report",
        }),
      }),
      clock: () => NOW,
      quoteTtlMs: 60_000,
    });
    const inspected = await inspect({ url: URL });
    assert.equal(inspected.description, "Premium Arc report");
    assert.equal(inspected.quote.expiresAt, "2026-07-27T01:01:00.000Z");

    const request = { url: URL, method: "GET" as const, headers: {} };
    const repository = memoryRepository();
    const failingRepository: ArcAgentCommerceRepository = {
      ...repository,
      complete: async () => {
        throw new Error("database unavailable");
      },
    };
    const pay = createPayPaidServiceHandler({
      circleCli: fakeCircle({
        payService: async () => ({
          response: null,
          payment: {
            amount: "1.25",
            chain: "ARC-TESTNET",
            scheme: "exact",
            seller: SELLER_ADDRESS,
          },
        }),
      }),
      commerce: failingRepository,
      clock: () => NOW,
    });
    const result = await pay({
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: createArcPaidServiceQuoteBinding({
        request,
        amountAtomic: "1250000",
        seller: SELLER_ADDRESS,
        inspectedAt: NOW.toISOString(),
        expiresAt: "2026-07-27T01:05:00.000Z",
      }),
    });
    assert.equal(result.receipt.status, "CLAIMED");
  });

  it("re-inspects replay calls and rejects drift or expiry without another mutation", async () => {
    const repository = memoryRepository();
    let payments = 0;
    let drift = false;
    let currentTime = NOW;
    const request = { url: URL, method: "GET" as const, headers: {} };
    const circleCli = fakeCircle({
      inspectService: async () => ({
        ...(await fakeCircle().inspectService(request)),
        price: drift
          ? { amount: "1250001", formatted: "$1.250001" }
          : { amount: "1250000", formatted: "$1.25" },
      }),
      payService: async (input) => {
        payments += 1;
        return await fakeCircle().payService(input);
      },
    });
    const pay = createPayPaidServiceHandler({
      circleCli,
      commerce: repository,
      clock: () => currentTime,
    });
    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      request,
      inspectedQuote: createArcPaidServiceQuoteBinding({
        request,
        amountAtomic: "1250000",
        seller: SELLER_ADDRESS,
        inspectedAt: NOW.toISOString(),
        expiresAt: "2026-07-27T01:05:00.000Z",
      }),
    };

    assert.equal((await pay(input)).receipt.status, "SETTLED");
    drift = true;
    await assert.rejects(pay(input), /quote changed/i);
    drift = false;
    currentTime = new Date("2026-07-27T01:06:00.000Z");
    await assert.rejects(pay(input), /expired/i);
    assert.equal(payments, 1);
  });
});

describe("tenant Arc agent commerce repository", () => {
  it("uses tenant-bound atomic RPCs and maps only sanitized durable records", async () => {
    const tenantId = "8e5d1144-5e2a-4c82-8e91-8cc620be21b8";
    const receipt = {
      idempotencyKey: IDEMPOTENCY_KEY,
      buyerAgentId: BUYER,
      sellerAgentId: SELLER,
      serviceUrl: URL,
      requestHash: `0x${"1".repeat(64)}`,
      quoteHash: `0x${"2".repeat(64)}`,
      inspectedAmountAtomic: "1250000",
      maxAmount: "1.25",
      walletAddress: WALLET,
      paymentIdentifier: "agentpay-c93cc97fff9d4fe1a98e9e6a655bf924",
      status: "CLAIMED" as const,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const row = {
      tenant_id: tenantId,
      idempotency_key: receipt.idempotencyKey,
      buyer_agent_id: receipt.buyerAgentId,
      seller_agent_id: receipt.sellerAgentId,
      service_url: receipt.serviceUrl,
      request_hash: receipt.requestHash,
      quote_hash: receipt.quoteHash,
      inspected_amount_atomic: receipt.inspectedAmountAtomic,
      max_amount: receipt.maxAmount,
      wallet_address: receipt.walletAddress,
      payment_identifier: receipt.paymentIdentifier,
      status: receipt.status,
      settlement_result: null,
      proof: null,
      created_at: receipt.createdAt,
      updated_at: receipt.updatedAt,
    };
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      from() {
        const query: any = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: row, error: null }),
        };
        return query;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return name === "claim_arc_agent_commerce_receipt"
          ? { data: { claimed: true, receipt: row }, error: null }
          : { data: { ...row, status: "RECONCILIATION_REQUIRED", settlement_result: { success: false } }, error: null };
      },
    };
    const repository = createTenantArcAgentCommerceRepository(client, tenantId);

    assert.deepEqual(await repository.getByIdempotencyKey(IDEMPOTENCY_KEY), receipt);
    assert.equal((await repository.claim(receipt)).claimed, true);
    await repository.complete({
      ...receipt,
      status: "RECONCILIATION_REQUIRED",
      settlementResult: { success: false },
    }, "CLAIMED");

    assert.deepEqual(rpcCalls.map((call) => call.name), [
      "claim_arc_agent_commerce_receipt",
      "complete_arc_agent_commerce_receipt",
    ]);
    assert.ok(rpcCalls.every((call) => call.args.p_tenant_id === tenantId));
    assert.doesNotMatch(JSON.stringify(rpcCalls), /signature|credential|private.?key/i);
  });
});
