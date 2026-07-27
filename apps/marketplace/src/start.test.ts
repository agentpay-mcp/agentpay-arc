import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, describe, it } from "node:test";

import { startMarketplaceServer } from "./start.ts";
import type { MarketplaceDependencies } from "./server.ts";

let lastRequestUrl = "";
let resolveCalls = 0;

const dependencies = {
  sessions: {
    resolve: async (request: Request) => {
      lastRequestUrl = request.url;
      resolveCalls += 1;
      // A real session lives in a credential the caller cannot mint. Anything
      // that merely names a tenant is not one.
      return request.headers.get("authorization") === "Bearer valid-token"
        ? { tenantId: "tenant-a" }
        : null;
    },
  },
  services: { search: async () => [], get: async () => null },
  trust: { get: async () => null },
  jobs: { listForSeller: async () => [] },
  activity: {
    listForTenant: async (tenantId: string) => [
      {
        id: "act-1",
        kind: "PAID_SERVICE",
        amount: `9.99000${tenantId.length % 10}`,
        token: "USDC",
        transactionHash: `0x${"cd".repeat(32)}`,
        occurredAt: "2026-07-27T10:00:00.000Z",
      },
    ],
  },
} as unknown as MarketplaceDependencies;

const PORT = 8791;
const server = startMarketplaceServer(dependencies, { port: PORT, origin: `http://127.0.0.1:${PORT}` });

after(() => server.close());

/** Raw socket: an invalid Host cannot be expressed through fetch(). */
function rawRequest(lines: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, "127.0.0.1", () => socket.write(lines));
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString();
    });
    socket.on("end", () => resolve(body));
    socket.on("error", reject);
    setTimeout(() => socket.end(), 500);
  });
}

describe("the listener survives a hostile Host header", () => {
  it("answers rather than crashing on an unparsable Host", async () => {
    // `new Request()` is synchronous, so this once threw past the promise
    // chain and killed the process with exit 1.
    const response = await rawRequest("GET / HTTP/1.1\r\nHost: %\r\n\r\n");

    assert.match(response, /^HTTP\/1\.1 \d{3}/, "the server must answer, not die");
  });

  it("is still serving after the hostile request", async () => {
    await rawRequest("GET / HTTP/1.1\r\nHost: %\r\n\r\n");
    const response = await fetch(`http://127.0.0.1:${PORT}/`);

    assert.equal(response.status, 200);
  });

  it("ignores the Host header entirely when building the request URL", async () => {
    const response = await rawRequest("GET / HTTP/1.1\r\nHost: evil.example.com\r\n\r\n");

    assert.match(response, /^HTTP\/1\.1 200/);
    assert.doesNotMatch(response, /evil\.example\.com/, "the attacker origin must never be reflected");
  });
});

describe("a caller cannot mint a tenant at the listener", () => {
  it("refuses a forged x-tenant header outright", async () => {
    // The previous head forwarded x-tenant and the fixture treated it as the
    // session, so this returned 200 and leaked that tenant's receipt.
    const response = await rawRequest(
      "GET /activity HTTP/1.1\r\nHost: x\r\nx-tenant: forged-tenant\r\n\r\n",
    );

    assert.match(response, /^HTTP\/1\.1 401/);
    assert.doesNotMatch(response, /9\.9900/, "no receipt may reach a forged tenant");
  });

  it("does not forward x-tenant to the handler at all", async () => {
    let forwarded: string | null = "unset";
    const probe = startMarketplaceServer(
      {
        ...dependencies,
        sessions: {
          resolve: async (request: Request) => {
            forwarded = request.headers.get("x-tenant");
            return null;
          },
        },
      } as unknown as MarketplaceDependencies,
      { port: 8793, origin: "http://127.0.0.1:8793" },
    );

    try {
      await fetch("http://127.0.0.1:8793/activity", { headers: { "x-tenant": "forged" } });
      assert.equal(forwarded, null, "x-tenant must never reach session resolution");
    } finally {
      probe.close();
    }
  });

  it("serves activity only for a credential the caller cannot forge", async () => {
    const denied = await fetch(`http://127.0.0.1:${PORT}/activity`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${PORT}/activity`, {
      headers: { authorization: "Bearer valid-token" },
    });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /9\.9900/);
  });
});

describe("the configured origin cannot be overridden by the request target", () => {
  it("rejects an absolute-form request target", async () => {
    // `new URL(incoming.url, origin)` accepted this, so request.url became
    // http://evil.example/activity and reached session resolution.
    const before = lastRequestUrl;
    const response = await rawRequest(
      "GET http://evil.example/activity HTTP/1.1\r\nHost: x\r\n\r\n",
    );

    assert.match(response, /^HTTP\/1\.1 400/);
    assert.equal(lastRequestUrl, before, "the handler must never see the attacker origin");
  });

  it("rejects an authority-form target", async () => {
    const response = await rawRequest("GET //evil.example/activity HTTP/1.1\r\nHost: x\r\n\r\n");

    assert.match(response, /^HTTP\/1\.1 400/);
    assert.doesNotMatch(lastRequestUrl, /evil\.example/);
  });

  it("still serves an ordinary origin-form target", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);

    assert.equal(response.status, 200);
    assert.match(lastRequestUrl === "" ? `http://127.0.0.1:${PORT}/` : lastRequestUrl, /127\.0\.0\.1/);
  });
});
