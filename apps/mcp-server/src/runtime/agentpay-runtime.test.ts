import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaymentIntentRecord, RouteQuote, SetupIntentRecord } from "@agentpay-ai/shared-arc";

import {
  createAgentPayRuntime,
  createPaymentIntentId,
  createPaymentNonce,
  parseAgentPayEnv,
  type AgentPayRuntimeFactories,
} from "./agentpay-runtime.ts";
import type { CircleCli } from "../services/circle-cli.ts";

const validPrivateKey = `0x${"1".repeat(64)}`;

describe("parseAgentPayEnv", () => {
  it("parses required runtime config and trims optional LI.FI settings", () => {
    const config = parseAgentPayEnv({
      SUPABASE_URL: " https://agentpay.supabase.co ",
      SUPABASE_SERVICE_ROLE_KEY: " service-role-key ",
      CELO_RPC_URL: " https://rpc.celo.tech ",
      CELO_MAINNET_RPC_URL: " https://mainnet.celo.tech ",
      CELO_MAINNET_RPC_FALLBACK_URL: " https://forno.celo.org ",
      CELO_SEPOLIA_RPC_URL: " https://testnet.celo.tech ",
      EXECUTOR_PRIVATE_KEY: ` ${validPrivateKey} `,
      LIFI_API_KEY: " lifi-key ",
      LIFI_BASE_URL: " https://li.quest ",
      SETUP_WEB_URL: " https://setup.agentpay.dev/setup ",
      AGENTPAY_HOME_CHAIN_ID: " 11142220 ",
      AGENTPAY_HTTP_MODE: " consumer ",
      AGENTPAY_ENVIRONMENT: " staging ",
      AGENTPAY_SESSION_HASH_KEY: " session-hash-secret ",
      AGENTPAY_REVIEW_TOKEN_SECRET: " review-token-secret-012345678901234567890123 ",
      AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS: " 0x1111111111111111111111111111111111111111 ",
      AGENTPAY_CELO_SEPOLIA_USDT_ADDRESS: " 0x2222222222222222222222222222222222222222 ",
      CELO_ATTRIBUTION_TAG: " celo_agentpay ",
    });

    assert.deepEqual(config, {
      supabaseUrl: "https://agentpay.supabase.co",
      serviceRoleKey: "service-role-key",
      celoRpcUrl: "https://rpc.celo.tech",
      celoRpcUrls: {
        42220: "https://mainnet.celo.tech",
        11142220: "https://testnet.celo.tech",
      },
      celoRpcFallbackUrls: {
        42220: "https://forno.celo.org",
      },
      executorPrivateKey: validPrivateKey,
      lifiApiKey: "lifi-key",
      lifiBaseUrl: "https://li.quest",
      setupWebUrl: "https://setup.agentpay.dev/setup",
      homeChainId: 11142220,
      httpMode: "consumer",
      environment: "staging",
      sessionHashKey: "session-hash-secret",
      reviewTokenSecret: "review-token-secret-012345678901234567890123",
      celoAttributionTag: "celo_agentpay",
      stableTokenOverrides: {
        11142220: {
          USDC: {
            address: "0x1111111111111111111111111111111111111111",
          },
          USDT: {
            address: "0x2222222222222222222222222222222222222222",
          },
        },
      },
    });
  });

  it("reports missing and invalid variable names without leaking secret values", () => {
    const sensitiveFixtureValue = "fixture-value-that-must-not-appear";

    assert.throws(
      () =>
        parseAgentPayEnv({
          SUPABASE_URL: "notaurl",
          SUPABASE_SERVICE_ROLE_KEY: sensitiveFixtureValue,
          CELO_RPC_URL: "",
          CELO_MAINNET_RPC_URL: "mainnet-rpc",
          CELO_SEPOLIA_RPC_URL: "testnet-rpc",
          EXECUTOR_PRIVATE_KEY: "0xabc123",
          AGENTPAY_HOME_CHAIN_ID: "98",
          AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS: "not-an-address",
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /CELO_RPC_URL/);
        assert.match(error.message, /CELO_MAINNET_RPC_URL/);
        assert.match(error.message, /CELO_SEPOLIA_RPC_URL/);
        assert.match(error.message, /SUPABASE_URL/);
        assert.match(error.message, /EXECUTOR_PRIVATE_KEY/);
        assert.match(error.message, /AGENTPAY_HOME_CHAIN_ID/);
        assert.match(error.message, /AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS/);
        assert.doesNotMatch(error.message, new RegExp(sensitiveFixtureValue));
        assert.doesNotMatch(error.message, /0xabc123/);
        return true;
      },
    );
  });

  it("allows loopback HTTP for local Review & Sign but requires HTTPS for remote hosts", () => {
    const baseEnv = {
      SUPABASE_URL: "https://agentpay.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CELO_RPC_URL: "https://rpc.celo.tech",
      EXECUTOR_PRIVATE_KEY: validPrivateKey,
    };

    assert.equal(
      parseAgentPayEnv({ ...baseEnv, SETUP_WEB_URL: "http://127.0.0.1:3000/setup" }).setupWebUrl,
      "http://127.0.0.1:3000/setup",
    );
    assert.throws(
      () => parseAgentPayEnv({ ...baseEnv, SETUP_WEB_URL: "http://wallet.agentpay.site/setup" }),
      /SETUP_WEB_URL/,
    );
  });

  it("rejects an invalid configured Celo attribution tag", () => {
    assert.throws(
      () =>
        parseAgentPayEnv({
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          CELO_RPC_URL: "https://rpc.celo.tech",
          EXECUTOR_PRIVATE_KEY: validPrivateKey,
          CELO_ATTRIBUTION_TAG: "celo_AgentPay",
        }),
      /CELO_ATTRIBUTION_TAG/,
    );
  });

  it("uses only explicit production Supabase and mainnet RPC aliases", () => {
    const config = parseAgentPayEnv({
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ACCOUNT_VERSION: "v2",
      SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
      SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-key",
      CELO_MAINNET_RPC_URL: "https://rpc.celo.tech/terigon",
      CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
      EXECUTOR_PRIVATE_KEY: validPrivateKey,
      AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
      AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
      AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
      CELO_ATTRIBUTION_TAG: "celo_agentpay",
      SETUP_WEB_URL: "https://setup.agentpay.site/review",
    });

    assert.equal(config.supabaseUrl, "https://production-project.supabase.co");
    assert.equal(config.serviceRoleKey, "production-service-key");
    assert.equal(config.celoRpcUrl, "https://rpc.celo.tech/terigon");
    assert.equal(config.homeChainId, 42220);
    assert.equal(config.environment, "production");
    assert.equal(config.productionOnboardingUrl, "https://wallet.agentpay.site/celo/setup");
    assert.equal(config.celoAttributionTag, "celo_agentpay");

    assert.throws(
      () => parseAgentPayEnv({
        AGENTPAY_ENVIRONMENT: "production",
        AGENTPAY_HOME_CHAIN_ID: "42220",
        AGENTPAY_ACCOUNT_VERSION: "v2",
        SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
        SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-key",
        CELO_MAINNET_RPC_URL: "https://rpc.celo.tech/terigon",
        CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
        EXECUTOR_PRIVATE_KEY: validPrivateKey,
        AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
        AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
        AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
        SETUP_WEB_URL: "http://localhost:3000/review",
      }),
      /SETUP_WEB_URL/,
    );

    assert.throws(
      () => parseAgentPayEnv({
        AGENTPAY_ENVIRONMENT: "production",
        AGENTPAY_HOME_CHAIN_ID: "42220",
        AGENTPAY_ACCOUNT_VERSION: "v2",
        SUPABASE_URL: "https://qwywcungxmhoctmehcze.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "staging-service-key",
        CELO_RPC_URL: "https://testrpc.celo.tech/terigon",
        EXECUTOR_PRIVATE_KEY: validPrivateKey,
      }),
      /SUPABASE_PRODUCTION_URL|CELO_MAINNET_RPC_URL|production/i,
    );
  });

  it("allows a production consumer to use the pinned executor address without a signing key", () => {
    const config = parseAgentPayEnv({
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HTTP_MODE: "consumer",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ACCOUNT_VERSION: "v2",
      SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
      SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-key",
      CELO_MAINNET_RPC_URL: "https://rpc.celo.tech/terigon",
      CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
      CELO_ATTRIBUTION_TAG: "celo_agentpay",
      AGENTPAY_EXECUTOR_ADDRESS: "0x645d39b3943D27cfE53184a446f551a69a4b1FDe",
      AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
      AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
      AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
      SETUP_WEB_URL: "https://wallet.agentpay.site/celo/review",
    });

    assert.equal(config.executorPrivateKey, undefined);
    assert.equal(config.executorAddress, "0x645d39b3943D27cfE53184a446f551a69a4b1FDe");
  });

  it("still requires the executor signing key for the production public surface", () => {
    assert.throws(
      () => parseAgentPayEnv({
        AGENTPAY_ENVIRONMENT: "production",
        AGENTPAY_HTTP_MODE: "public",
        AGENTPAY_HOME_CHAIN_ID: "42220",
        AGENTPAY_ACCOUNT_VERSION: "v2",
        SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
        SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-key",
        CELO_MAINNET_RPC_URL: "https://rpc.celo.tech/terigon",
        CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
        CELO_ATTRIBUTION_TAG: "celo_agentpay",
        AGENTPAY_EXECUTOR_ADDRESS: "0x645d39b3943D27cfE53184a446f551a69a4b1FDe",
        AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
        AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
        AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
        SETUP_WEB_URL: "https://wallet.agentpay.site/celo/review",
      }),
      /EXECUTOR_PRIVATE_KEY/,
    );
  });

  it("rejects executor-grade secrets in the production consumer boundary", () => {
    const consumerEnv = {
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HTTP_MODE: "consumer",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ACCOUNT_VERSION: "v2",
      SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
      SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-key",
      CELO_MAINNET_RPC_URL: "https://rpc.celo.tech/terigon",
      CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
      CELO_ATTRIBUTION_TAG: "celo_agentpay",
      AGENTPAY_EXECUTOR_ADDRESS: "0x645d39b3943D27cfE53184a446f551a69a4b1FDe",
      AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
      AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
      AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
      SETUP_WEB_URL: "https://wallet.agentpay.site/celo/review",
    };

    assert.throws(
      () => parseAgentPayEnv({ ...consumerEnv, EXECUTOR_PRIVATE_KEY: validPrivateKey }),
      /consumer secret isolation/,
    );
    assert.throws(
      () => parseAgentPayEnv({ ...consumerEnv, AGENTPAY_RAW_TX_ENCRYPTION_KEY: "a".repeat(64) }),
      /consumer secret isolation/,
    );
  });
});

describe("runtime identifiers", () => {
  it("creates hex payment IDs and decimal nonce strings from random bytes", () => {
    const incrementalBytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => index);
    const nonceBytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index === size - 1 ? 42 : 0));

    assert.equal(createPaymentIntentId(incrementalBytes), "pay_000102030405060708090a0b");
    assert.equal(createPaymentNonce(nonceBytes), "42");
  });
});

describe("createAgentPayRuntime", () => {
  it("wires configured adapters into prepare and execute payment handlers", async () => {
    const createdIntents: PaymentIntentRecord[] = [];
    const createdSetups: SetupIntentRecord[] = [];
    const calls: Array<[string, unknown]> = [];
    const x402PaymentRequired = {
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const completedX402Intent: PaymentIntentRecord = {
      id: "pay_x402",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "COMPLETED",
      paymentType: "X402_PAYMENT",
      sourceChainId: 42220,
      destinationChainId: 8453,
      sourceTokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      sourceTokenSymbol: "USDC",
      destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "0.01",
      maxAmountIn: "0.011",
      maxNativeFee: "0",
      routeProvider: "LI.FI",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "Route to Base.",
      nonce: "43",
      deadline: "2026-07-02T14:45:00.000Z",
      purpose: "x402 payment for Market API: Premium market data [x402-request:0x6883a5441c9fbe43f06d78857957414b515c003f7ba89a4bde6a9ef665874dbe]",
      approvalPhrase: "APPROVE pay_x402",
      sourceTxHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      destinationTxHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      completedAt: "2026-07-02T14:31:00.000Z",
    };
    const routeQuote: RouteQuote = {
      routeProvider: "LI.FI",
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      destinationTokenAddress: "0x6666666666666666666666666666666666666666",
      maxAmountIn: "10.2",
      maxNativeFee: "0",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "LI.FI route prepared.",
      estimatedEtaSeconds: 120,
    };

    const factories: AgentPayRuntimeFactories = {
      createRepositories(config) {
        calls.push(["supabase", config]);
        return {
          wallets: {
            async getActiveWallet() {
              return {
                ownerAddress: "0x2222222222222222222222222222222222222222",
                accountAddress: "0x3333333333333333333333333333333333333333",
                homeChainId: 42220,
                executorAddress: "0x4444444444444444444444444444444444444444",
                status: "ACTIVE",
              };
            },
          },
          setupIntents: {
            async createSetupIntent(intent) {
              createdSetups.push(intent);
            },
            async getSetupIntent(setupIntentId) {
              assert.equal(setupIntentId, "setup_runtime");
              return createdSetups.at(0) ?? null;
            },
          },
          paymentIntents: {
            async createPaymentIntent(intent) {
              createdIntents.push(intent);
            },
            async getPaymentIntent(paymentIntentId) {
              if (paymentIntentId === "pay_x402") {
                return completedX402Intent;
              }
              assert.equal(paymentIntentId, "pay_runtime");
              return createdIntents.at(0) ?? null;
            },
            async claimPaymentApproval(paymentIntentId, approvedAt) {
              if (createdIntents[0]?.status !== "AWAITING_APPROVAL") {
                return false;
              }
              createdIntents[0] = {
                ...createdIntents[0],
                status: "APPROVED",
                approvedAt,
              };
              calls.push(["approved", { paymentIntentId, approvedAt }]);
              return true;
            },
            async markPaymentExecuting(paymentIntentId, sourceTxHash, approvedAt) {
              if (createdIntents[0]) {
                createdIntents[0] = {
                  ...createdIntents[0],
                  status: "EXECUTING",
                  sourceTxHash,
                  approvedAt,
                };
              }
              calls.push(["executing", { paymentIntentId, sourceTxHash, approvedAt }]);
            },
            async markPaymentFailed(paymentIntentId, errorCode, errorMessage) {
              calls.push(["failed", { paymentIntentId, errorCode, errorMessage }]);
            },
            async markPaymentExpired(paymentIntentId) {
              calls.push(["expired", paymentIntentId]);
            },
            async markPaymentCompleted(paymentIntentId, destinationTxHash, completedAt) {
              if (createdIntents[0]) {
                createdIntents[0] = {
                  ...createdIntents[0],
                  status: "COMPLETED",
                  destinationTxHash,
                };
              }
              calls.push(["completed", { paymentIntentId, destinationTxHash, completedAt }]);
            },
            async listPaymentIntents(request) {
              calls.push(["listPaymentIntents", request]);
              return createdIntents;
            },
          },
          paymentEvents: {
            async listPaymentEvents(request) {
              calls.push(["listPaymentEvents", request]);
              return [
                {
                  id: "event_runtime",
                  paymentIntentId: "pay_runtime",
                  eventType: "PAYMENT_CREATED",
                  message: "Payment intent created.",
                  metadata: { status: "AWAITING_APPROVAL" },
                  createdAt: "2026-07-02T14:30:00.000Z",
                },
              ];
            },
          },
        };
      },
      createRoutes(config) {
        calls.push(["lifi", config]);
        return {
          async quotePaymentRoute() {
            return routeQuote;
          },
          async getRouteStatus(request) {
            calls.push(["getRouteStatus", request]);
            return {
              status: "DONE",
              substatus: "COMPLETED",
              substatusMessage: "The transfer is complete.",
              destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            };
          },
        };
      },
      createX402BazaarDiscovery(config) {
        calls.push(["x402Bazaar", config]);
        return {
          async search(request) {
            calls.push(["searchX402Services", request]);
            return {
              resources: [
                {
                  resource: "https://api.market.example.com/prices",
                  type: "http",
                  x402Version: 2,
                  serviceName: "Market Bazaar",
                  description: "Paid market prices",
                  lastUpdated: "2026-07-05T08:00:00.000Z",
                  accepts: [
                    {
                      scheme: "exact",
                      network: "eip155:42220",
                      amount: "250000",
                      asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
                      payTo: "0x1111111111111111111111111111111111111111",
                      maxTimeoutSeconds: 60,
                    },
                  ],
                  extensions: {
                    bazaar: {
                      info: {
                        input: {
                          type: "http",
                          method: "GET",
                          queryParams: {
                            symbol: "BTC-USDT",
                          },
                        },
                      },
                    },
                  },
                },
              ],
            };
          },
        };
      },
      createChainAdapters(config) {
        calls.push(["ethers", config]);
        return {
          balances: {
            async hasSufficientTokenBalance() {
              return true;
            },
          },
          sourceTransactions: {
            async getSourceTransactionStatus(request) {
              calls.push(["getSourceTransactionStatus", request]);
              return { status: "SUCCESS" };
            },
          },
          tokenBalances: {
            async getTokenBalance(request) {
              calls.push(["getTokenBalance", request]);
              return { amount: "12.5" };
            },
          },
          nativeBalances: {
            async getNativeBalance(request) {
              calls.push(["getNativeBalance", request]);
              return { amount: "0.03" };
            },
          },
          routeTargetAllowances: {
            async isRouteTargetAllowed(request) {
              calls.push(["isRouteTargetAllowed", request]);
              return false;
            },
          },
          executor: {
            async executeDirectPayment(request) {
              calls.push(["executeDirectPayment", request]);
              return { sourceTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" };
            },
            async executeRoutePayment(request) {
              calls.push(["executeRoutePayment", request]);
              return { sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
            },
            async executeContractCall(request) {
              calls.push(["executeContractCall", request]);
              return { sourceTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };
            },
          },
        };
      },
    };

    const circleCli = {} as CircleCli;
    const runtime = createAgentPayRuntime(
      {
        supabaseUrl: "https://agentpay.supabase.co",
        serviceRoleKey: "service-role-key",
        celoRpcUrl: "https://rpc.celo.tech",
        celoRpcUrls: {
          42220: "https://mainnet.celo.tech",
          11142220: "https://testnet.celo.tech",
        },
        celoRpcFallbackUrls: {
          42220: "https://forno.celo.org",
        },
        executorGasMaxWei: 50_000_000_000_000_000n,
        executorPrivateKey: validPrivateKey,
        lifiApiKey: "lifi-key",
        x402BazaarFacilitatorUrl: "https://facilitator.example.com",
        setupWebUrl: "https://setup.agentpay.dev/setup",
      },
      {
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_runtime",
        createNonce: () => "42",
        createSetupIntentId: () => "setup_runtime",
        executorAddress: "0x4444444444444444444444444444444444444444",
        circleCli,
        x402HttpClient: {
          async request(url, init) {
            calls.push([
              "x402Fetch",
              {
                url: String(url),
                method: init.method,
                headers: init.headers,
              },
            ]);
            return new Response("premium payload", {
              status: 200,
              headers: {
                "x-payment-response": "settled",
              },
            });
          },
        },
        factories,
      },
    );

    const setup = await runtime.prepareWalletCreation({});
    const wallet = await runtime.getAgentWallet({});
    const balance = await runtime.getBalance({ tokenSymbols: ["USDC"] });
    const invoice = await runtime.parseInvoicePayment({
      invoice: [
        "Invoice ID: inv_runtime",
        "Recipient: 0x1111111111111111111111111111111111111111",
        "Destination Chain: Base",
        "Token: USDC",
        "Amount: 10",
        "Purpose: design bounty",
      ].join("\n"),
    });
    const x402 = await runtime.parseX402PaymentRequired({
      paymentRequired: JSON.stringify(x402PaymentRequired),
    });
    const x402Services = await runtime.searchX402Services({
      query: "celo payment services",
      limit: 3,
    });
    const x402ServiceRequest = await runtime.prepareX402ServiceRequest({
      resource: x402Services.results[0]!.resource,
      parameters: {
        symbol: "ETH-USDT",
      },
    });
    const retriedX402 = await runtime.retryX402Request({
      paymentRequired: x402PaymentRequired,
      paymentIntentId: "pay_x402",
    });
    const quoted = await runtime.quotePaymentRoute({
      recipientAddress: "0x1111111111111111111111111111111111111111",
      destinationChainId: 8453,
      destinationTokenSymbol: "USDC",
      amountOut: "10",
      sourceTokenSymbol: "USDC",
    });
    const allowance = await runtime.prepareRouteTargetAllowance({
      routeTarget: "0x7777777777777777777777777777777777777777",
    });
    const allowanceStatus = await runtime.checkRouteTargetAllowance({
      routeTarget: "0x7777777777777777777777777777777777777777",
    });
    const adminTransaction = await runtime.prepareAccountAdminTransaction({ action: "PAUSE" });
    const prepared = await runtime.preparePayment({
      recipientAddress: "0x1111111111111111111111111111111111111111",
      destinationChainId: 8453,
      destinationTokenSymbol: "USDC",
      amountOut: "10",
      purpose: "design bounty",
      sourceTokenSymbol: "USDC",
    });

    const executed = await runtime.executePayment({
      paymentIntentId: prepared.paymentIntentId,
      approvalText: prepared.approvalPhrase,
    });
    const tracked = await runtime.trackPayment({ paymentIntentId: prepared.paymentIntentId });
    const transactions = await runtime.listTransactions({ limit: 3 });
    const events = await runtime.listPaymentEvents({ paymentIntentId: prepared.paymentIntentId, limit: 1 });
    const contractCall = await runtime.prepareContractCall({
      targetAddress: "0x8888888888888888888888888888888888888888",
      callData: "0xaabbccdd",
      maxTokenSpend: "7.5",
      purpose: "mint access pass",
    });

    assert.equal(setup.status, "PENDING");
    assert.equal(runtime.circleCli, circleCli);
    if (setup.status !== "PENDING") assert.fail("Expected the staging setup intent path.");
    assert.equal(setup.setupIntentId, "setup_runtime");
    assert.equal(setup.setupUrl, "https://setup.agentpay.dev/setup?setup_intent_id=setup_runtime");
    assert.equal(createdSetups[0]?.executorAddress, "0x4444444444444444444444444444444444444444");
    assert.equal(wallet.status, "ACTIVE");
    assert.deepEqual(balance, {
      status: "ACTIVE",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      chainId: 42220,
      chain: "Celo",
      balances: [
        {
          tokenSymbol: "USDC",
          tokenAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          amount: "12.5",
          decimals: 6,
        },
      ],
      nativeBalance: {
        tokenSymbol: "CELO",
        tokenAddress: "native",
        amount: "0.03",
        decimals: 18,
      },
    });
    assert.equal(invoice.status, "PARSED");
    assert.equal(invoice.invoiceId, "inv_runtime");
    assert.equal(invoice.paymentInput.destinationChain, "Base");
    assert.equal(x402.status, "PARSED");
    assert.equal(x402.resource.serviceName, "Market API");
    assert.equal(x402.paymentInput.destinationChain, "Base");
    assert.equal(x402.standardX402SignatureRequired, true);
    assert.equal(x402Services.status, "FOUND");
    assert.equal(x402Services.results[0]?.serviceName, "Market Bazaar");
    assert.equal(x402ServiceRequest.status, "REQUEST_READY");
    assert.equal(x402ServiceRequest.request?.url, "https://api.market.example.com/prices?symbol=ETH-USDT");
    assert.equal(x402ServiceRequest.paymentRequired?.resource.url, "https://api.market.example.com/prices?symbol=ETH-USDT");
    assert.equal(retriedX402.status, "RESOURCE_FETCHED");
    assert.equal(retriedX402.httpStatus, 200);
    assert.equal(retriedX402.paymentResponse, "settled");
    assert.equal(retriedX402.bodyText, "premium payload");
    assert.equal((calls.find(([name]) => name === "x402Fetch")?.[1] as { method: string }).method, "GET");
    assert.equal(contractCall.paymentIntentId, "pay_runtime");
    assert.equal(contractCall.summary.callDataHash, "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6");
    assert.equal(quoted.paymentType, "SWAP_BRIDGE_PAY");
    assert.equal(quoted.maxAmountIn, "10.2");
    assert.equal(allowance.status, "READY");
    assert.equal(allowance.transaction?.to, "0x3333333333333333333333333333333333333333");
    assert.match(allowance.transaction?.data ?? "", /^0x/);
    assert.equal(allowanceStatus.status, "ACTIVE");
    assert.equal(allowanceStatus.routeTargetAllowed, false);
    assert.equal(adminTransaction.status, "READY");
    assert.equal(adminTransaction.transaction?.to, "0x3333333333333333333333333333333333333333");
    assert.equal(prepared.paymentIntentId, "pay_runtime");
    assert.equal(createdIntents[0]?.nonce, "42");
    assert.equal(executed.sourceTxHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(tracked.status, "COMPLETED");
    assert.equal(tracked.destinationTxHash, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(transactions.transactions.length, 1);
    assert.deepEqual(events.events, [
      {
        eventId: "event_runtime",
        paymentIntentId: "pay_runtime",
        eventType: "PAYMENT_CREATED",
        message: "Payment intent created.",
        metadata: { status: "AWAITING_APPROVAL" },
        createdAt: "2026-07-02T14:30:00.000Z",
      },
    ]);
    assert.deepEqual(calls.slice(0, 4), [
      [
        "supabase",
        {
          supabaseUrl: "https://agentpay.supabase.co",
          serviceRoleKey: "service-role-key",
        },
      ],
      [
        "lifi",
        {
          apiKey: "lifi-key",
          integrator: "agentpay",
        },
      ],
      [
        "ethers",
        {
          rpcUrl: "https://rpc.celo.tech",
          rpcUrls: {
            42220: "https://mainnet.celo.tech",
            11142220: "https://testnet.celo.tech",
          },
          rpcFallbackUrls: {
            42220: "https://forno.celo.org",
          },
          executorGasMaxWei: 50_000_000_000_000_000n,
          executorPrivateKey: validPrivateKey,
        },
      ],
      [
        "x402Bazaar",
        {
          facilitatorUrl: "https://facilitator.example.com",
        },
      ],
    ]);
  });
});
