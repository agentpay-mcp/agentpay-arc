import { createServer } from "node:http";

import { createMarketplaceHandler, type MarketplaceDependencies } from "./server.ts";

/**
 * Boots the read-only marketplace. The caller supplies the read models; this
 * module never opens a database connection or holds a credential of its own.
 */
export interface StartMarketplaceOptions {
  readonly port?: number;
  /**
   * Fixed origin used to build the request URL. The Host header is attacker
   * controlled and is never used: `Host: %` alone was enough to throw out of
   * `new Request(...)` and take the process down.
   */
  readonly origin?: string;
}

export function startMarketplaceServer(
  dependencies: MarketplaceDependencies,
  options: StartMarketplaceOptions | number = {},
) {
  const settings = typeof options === "number" ? { port: options } : options;
  const port = settings.port ?? Number(process.env.MARKETPLACE_PORT ?? 8790);
  const origin = settings.origin ?? process.env.MARKETPLACE_ORIGIN ?? `http://127.0.0.1:${port}`;

  const handle = createMarketplaceHandler(dependencies);

  const server = createServer((incoming, outgoing) => {
    let request: Request;

    try {
      // Construction is synchronous, so it must be inside the guard: a promise
      // catch further down would never see it.
      request = new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method ?? "GET",
        headers: forwardableHeaders(incoming.headers),
      });
    } catch {
      outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Bad request.");
      return;
    }

    handle(request)
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

/**
 * Session resolution needs the credential headers, so they are forwarded --
 * but only the ones a session can legitimately live in, and never the Host
 * header we deliberately ignore.
 */
function forwardableHeaders(source: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();

  for (const name of ["authorization", "cookie", "x-tenant"]) {
    const value = source[name];
    if (typeof value === "string") headers.set(name, value);
  }

  return headers;
}
