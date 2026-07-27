import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMarketplaceHandler,
  type MarketplaceDependencies,
  type MarketplaceService,
} from "./server.ts";

const SELLER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"cd".repeat(32)}`;

function service(overrides: Partial<MarketplaceService> = {}): MarketplaceService {
  return {
    id: "svc-weather",
    name: "Weather Oracle",
    description: "Hourly forecasts for any coordinate.",
    category: "data",
    url: "https://weather.example.com/forecast",
    price: "0.010000",
    token: "USDC",
    sellerAddress: SELLER,
    sellerAgentId: "9720",
    ...overrides,
  };
}

function deps(overrides: Partial<MarketplaceDependencies> = {}): MarketplaceDependencies {
  return {
    services: {
      search: async () => [service()],
      get: async (id) => (id === "svc-weather" ? service() : null),
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
    sessions: {
      // A credential the caller cannot mint. Naming a tenant is not a session.
      resolve: async (request: Request) => {
        const token = request.headers.get("authorization");
        if (token === "Bearer tenant-a-token") return { tenantId: "tenant-a" };
        if (token === "Bearer tenant-b-token") return { tenantId: "tenant-b" };
        return null;
      },
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
    ...overrides,
  };
}

async function get(
  handler: (request: Request) => Promise<Response>,
  path: string,
  headers: Record<string, string> = { authorization: "Bearer tenant-a-token" },
) {
  return handler(new Request(`https://marketplace.test${path}`, { headers }));
}

describe("marketplace security posture", () => {
  it("serves a strict CSP that forbids scripts and framing", async () => {
    const response = await get(createMarketplaceHandler(deps()), "/");
    const csp = response.headers.get("content-security-policy") ?? "";

    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  it("marks private activity no-store while the public catalogue may be cached", async () => {
    const handler = createMarketplaceHandler(deps());

    assert.equal((await get(handler, "/activity")).headers.get("cache-control"), "no-store");
    assert.notEqual((await get(handler, "/")).headers.get("cache-control"), "no-store");
  });

  it("ships no script tag, wallet bundle, or Circle credential path in the HTML", async () => {
    const handler = createMarketplaceHandler(deps());

    for (const path of ["/", "/services/svc-weather", "/activity"]) {
      const html = await (await get(handler, path)).text();

      assert.doesNotMatch(html, /<script/i, `${path} must not ship script`);
      assert.doesNotMatch(html, /ethereum|window\.web3|walletconnect|privateKey|mnemonic/i);
      assert.doesNotMatch(html, /circle[_-]?(?:api[_-]?key|session|token)/i);
      assert.doesNotMatch(html, /SUPABASE|SERVICE_ROLE/i);
    }
  });

  it("escapes agent-supplied metadata instead of rendering it as markup", async () => {
    const handler = createMarketplaceHandler(
      deps({
        services: {
          search: async () => [
            service({ name: "<img src=x onerror=alert(1)>", description: "\"><script>alert(2)</script>" }),
          ],
          get: async () => null,
        },
      }),
    );

    const html = await (await get(handler, "/")).text();

    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img src=x/);
  });

  it("never renders a trust claim the data does not support", async () => {
    const handler = createMarketplaceHandler(
      deps({
        trust: {
          get: async () => ({
            agentId: "9720",
            registrationFetched: false,
            endpointDomainVerified: false,
            feedbackCount: "0",
            averageScore: null,
            validationResponses: "0",
          }),
        },
      }),
    );

    const html = await (await get(handler, "/services/svc-weather")).text();

    // Only negative statements are permitted when nothing was actually checked.
    assert.doesNotMatch(html, /fetched and validated/i);
    assert.doesNotMatch(html, /control verified/i);
    assert.match(html, /Registration metadata not verified/i);
    assert.match(html, /Endpoint domain control not verified/i);
  });
});

describe("marketplace catalogue", () => {
  it("lists services with price, token, and the Arc network", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/")).text();

    assert.match(html, /Weather Oracle/);
    assert.match(html, /0\.010000/);
    assert.match(html, /USDC/);
    assert.match(html, /Arc Testnet/);
  });

  it("passes the search term and category through to the read model", async () => {
    const seen: Array<{ query?: string; category?: string }> = [];
    const handler = createMarketplaceHandler(
      deps({
        services: {
          search: async (input) => {
            seen.push(input);
            return [];
          },
          get: async () => null,
        },
      }),
    );

    await get(handler, "/?q=weather&category=data");

    assert.deepEqual(seen, [{ query: "weather", category: "data" }]);
  });

  it("renders an empty state rather than a blank page when nothing matches", async () => {
    const handler = createMarketplaceHandler(
      deps({ services: { search: async () => [], get: async () => null } }),
    );

    const response = await get(handler, "/?q=nothing");
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /no services|nothing matched/i);
  });

  it("masks a read-model failure as a generic error state", async () => {
    const handler = createMarketplaceHandler(
      deps({
        services: {
          search: async () => {
            throw new Error("supabase: relation public.services does not exist");
          },
          get: async () => null,
        },
      }),
    );

    const response = await get(handler, "/");
    const html = await response.text();

    assert.equal(response.status, 503);
    assert.doesNotMatch(html, /supabase|relation|does not exist/i);
    assert.match(html, /unavailable/i);
  });
});

describe("service detail", () => {
  it("shows seller trust, job status, and a copyable agent prompt", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/services/svc-weather")).text();

    assert.match(html, /9720/);
    assert.match(html, /8183/);
    assert.match(html, /Funded/);
    assert.match(html, /25\.000000/);
    assert.match(html, /pay_paid_service/);
  });

  it("offers a copyable prompt instead of anything that could execute a payment", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/services/svc-weather")).text();

    assert.doesNotMatch(html, /<form/i);
    assert.doesNotMatch(html, /<button[^>]*type=["']?submit/i);
    assert.match(html, /readonly/i, "the prompt is presented as copyable text, not an action");
  });

  it("returns 404 for an unknown service without leaking internals", async () => {
    const response = await get(createMarketplaceHandler(deps()), "/services/missing");

    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /supabase|stack|Error:/i);
  });
});

describe("activity receipts", () => {
  it("renders receipts with valid Arcscan proof links", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/activity")).text();

    assert.match(html, new RegExp(`https://testnet\\.arcscan\\.app/tx/${TX}`));
    assert.match(html, /0\.010000/);
  });

  it("renders an empty state when the tenant has no activity", async () => {
    const handler = createMarketplaceHandler(deps({ activity: { listForTenant: async () => [] } }));
    const html = await (await get(handler, "/activity")).text();

    assert.match(html, /no activity/i);
  });

  it("never renders a proof link for a malformed transaction hash", async () => {
    const handler = createMarketplaceHandler(
      deps({
        activity: {
          listForTenant: async () => [
            {
              id: "act-2",
              kind: "PAID_SERVICE",
              amount: "0.010000",
              token: "USDC",
              transactionHash: "not-a-hash",
              occurredAt: "2026-07-27T10:00:00.000Z",
            },
          ],
        },
      }),
    );

    const html = await (await get(handler, "/activity")).text();

    assert.doesNotMatch(html, /arcscan\.app\/tx\/not-a-hash/);
    assert.match(html, /proof pending|no proof/i);
  });
});

describe("accessibility and layout", () => {
  it("renders a landmark structure and a labelled search control", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/")).text();

    assert.match(html, /<main\b/);
    assert.match(html, /<nav\b/);
    assert.match(html, /<h1\b/);
    assert.match(html, /<label[^>]*for=["']q["']/);
    assert.match(html, /lang=["']en["']/);
  });

  it("declares a responsive viewport so the mobile layout is not zoomed out", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/")).text();

    assert.match(html, /<meta name=["']viewport["'][^>]*width=device-width/);
  });

  it("gives every proof link an accessible name rather than a bare URL", async () => {
    const html = await (await get(createMarketplaceHandler(deps()), "/activity")).text();

    assert.match(html, /<a[^>]*href=["']https:\/\/testnet\.arcscan\.app\/tx\/[^"']+["'][^>]*>[^<]*\w/);
    assert.match(html, /rel=["'][^"']*noopener/);
  });
});

describe("activity is bound to a verified tenant", () => {
  it("refuses an anonymous request instead of serving receipts", async () => {
    const response = await get(createMarketplaceHandler(deps()), "/activity", {});
    const html = await response.text();

    assert.equal(response.status, 401);
    assert.doesNotMatch(html, new RegExp(TX), "no receipt may reach an unauthenticated caller");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("passes the resolved tenant to the read model and never a caller-supplied one", async () => {
    const seen: string[] = [];
    const handler = createMarketplaceHandler(
      deps({
        sessions: { resolve: async () => ({ tenantId: "tenant-from-session" }) },
        activity: {
          listForTenant: async (tenantId) => {
            seen.push(tenantId);
            return [];
          },
        },
      }),
    );

    await get(handler, "/activity?tenantId=tenant-injected", { authorization: "Bearer tenant-a-token" });

    assert.deepEqual(seen, ["tenant-from-session"]);
  });

  it("isolates two tenants", async () => {
    const byTenant: Record<string, string> = { "tenant-a": "0.010000", "tenant-b": "9.990000" };
    const handler = createMarketplaceHandler(
      deps({
        activity: {
          listForTenant: async (tenantId) => [
            {
              id: `act-${tenantId}`,
              kind: "PAID_SERVICE",
              amount: byTenant[tenantId] ?? "0",
              token: "USDC",
              transactionHash: TX,
              occurredAt: "2026-07-27T10:00:00.000Z",
            },
          ],
        },
      }),
    );

    const a = await (await get(handler, "/activity", { authorization: "Bearer tenant-a-token" })).text();
    const b = await (await get(handler, "/activity", { authorization: "Bearer tenant-b-token" })).text();

    assert.match(a, /0\.010000/);
    assert.doesNotMatch(a, /9\.990000/, "tenant A must never see tenant B's activity");
    assert.match(b, /9\.990000/);
    assert.doesNotMatch(b, /0\.010000/);
  });
});

describe("the search form can actually submit", () => {
  it("allows same-origin form submission in the CSP", async () => {
    const response = await get(createMarketplaceHandler(deps()), "/");
    const csp = response.headers.get("content-security-policy") ?? "";

    assert.match(csp, /form-action 'self'/, "the rendered GET filter must be submittable");
    assert.doesNotMatch(csp, /form-action 'none'/);
  });
});

describe("a dependency outage is not rendered as confirmed absence", () => {
  it("says trust is unavailable rather than that no identity exists", async () => {
    const handler = createMarketplaceHandler(
      deps({
        trust: {
          get: async () => {
            throw new Error("erc8004 reader timeout");
          },
        },
      }),
    );

    const html = await (await get(handler, "/services/svc-weather")).text();

    assert.doesNotMatch(html, /No ERC-8004 identity found/i);
    assert.match(html, /trust data (?:is )?unavailable/i);
    assert.doesNotMatch(html, /timeout|erc8004 reader/i, "internal errors must not surface");
  });

  it("says job data is unavailable rather than that there are no jobs", async () => {
    const handler = createMarketplaceHandler(
      deps({
        jobs: {
          listForSeller: async () => {
            throw new Error("supabase down");
          },
        },
      }),
    );

    const html = await (await get(handler, "/services/svc-weather")).text();

    assert.doesNotMatch(html, /no ERC-8183 jobs on record/i);
    assert.match(html, /job data (?:is )?unavailable/i);
    assert.doesNotMatch(html, /supabase/i);
  });
});
