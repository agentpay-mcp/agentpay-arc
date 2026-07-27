import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, describe, it } from "node:test";

import { startMarketplaceServer } from "./start.ts";
import type { MarketplaceDependencies } from "./server.ts";

const dependencies = {
  sessions: { resolve: async () => null },
  services: { search: async () => [], get: async () => null },
  trust: { get: async () => null },
  jobs: { listForSeller: async () => [] },
  activity: { listForTenant: async () => [] },
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
