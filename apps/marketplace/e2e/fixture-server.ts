import { startMarketplaceServer } from "../src/start.ts";
import type { MarketplaceDependencies } from "../src/server.ts";

const SELLER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"cd".repeat(32)}`;

/** Deterministic read models so the e2e run never touches a real database. */
const dependencies: MarketplaceDependencies = {
  // The fixture treats a header as the session so the e2e run can exercise
  // both the anonymous and the authenticated path without a real auth stack.
  // A bearer credential, not a header that merely names a tenant: the listener
  // deliberately refuses to forward anything of the latter kind.
  sessions: {
    resolve: async (request) =>
      request.headers.get("authorization") === "Bearer e2e-tenant-a"
        ? { tenantId: "tenant-a" }
        : null,
  },
  services: {
    search: async ({ query, category }) =>
      [
        {
          id: "svc-weather",
          name: "Weather Oracle",
          description: "Hourly forecasts for any coordinate.",
          category: "data",
          url: "https://weather.example.com/forecast",
          price: "0.010000",
          token: "USDC",
          sellerAddress: SELLER,
          sellerAgentId: "9720",
        },
        {
          id: "svc-translate",
          name: "Translate API",
          description: "Machine translation billed per call.",
          category: "language",
          url: "https://translate.example.com/v1",
          price: "0.002500",
          token: "USDC",
          sellerAddress: SELLER,
          sellerAgentId: "9720",
        },
      ].filter(
        (item) =>
          (!query || item.name.toLowerCase().includes(query.toLowerCase())) &&
          (!category || item.category === category),
      ),
    get: async (id) =>
      id === "svc-weather"
        ? {
            id,
            name: "Weather Oracle",
            description: "Hourly forecasts for any coordinate.",
            category: "data",
            url: "https://weather.example.com/forecast",
            price: "0.010000",
            token: "USDC",
            sellerAddress: SELLER,
            sellerAgentId: "9720",
          }
        : null,
  },
  trust: {
    get: async () => ({
      agentId: "9720",
      registrationFetched: true,
      endpointDomainVerified: false,
      feedbackCount: "12",
      averageScore: "4.5",
      validationResponses: "2",
    }),
  },
  jobs: {
    listForSeller: async () => [
      { jobId: "8183", state: "Funded", budget: "25.000000", expiredAt: "4102444800" },
    ],
  },
  activity: {
    listForTenant: async () => [
      {
        id: "act-1",
        kind: "PAID_SERVICE",
        amount: "0.010000",
        token: "USDC",
        transactionHash: TX,
        occurredAt: "2026-07-27T10:00:00.000Z",
      },
    ],
  },
};

startMarketplaceServer(dependencies);
