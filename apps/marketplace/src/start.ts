import { createServer } from "node:http";

import { createMarketplaceHandler, type MarketplaceDependencies } from "./server.ts";

/**
 * Boots the read-only marketplace. The caller supplies the read models; this
 * module never opens a database connection or holds a credential of its own.
 */
export function startMarketplaceServer(
  dependencies: MarketplaceDependencies,
  port = Number(process.env.MARKETPLACE_PORT ?? 8790),
) {
  const handle = createMarketplaceHandler(dependencies);

  const server = createServer((incoming, outgoing) => {
    const url = `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`;

    handle(new Request(url, { method: incoming.method ?? "GET" }))
      .then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(await response.text());
      })
      .catch(() => {
        outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("Marketplace unavailable.");
      });
  });

  server.listen(port);
  return server;
}
