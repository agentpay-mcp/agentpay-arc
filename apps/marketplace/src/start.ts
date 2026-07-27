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

    const resolved = resolveRequestUrl(incoming.url ?? "/", origin);

    if (!resolved) {
      outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Bad request.");
      return;
    }

    try {
      // Construction is synchronous, so it must be inside the guard: a promise
      // catch further down would never see it.
      request = new Request(resolved, {
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
 * Resolves a request target against the configured origin, or returns null.
 *
 * Two layers, because pattern-matching the raw target alone kept losing:
 *
 *  1. Reject anything that is not plainly origin-form. Backslashes are
 *     rejected outright — for special schemes the URL parser normalises `\` to
 *     `/`, so `/\evil.example/x` parses as `//evil.example/x`.
 *  2. Then check the PARSED origin against the configured one. This is the
 *     check that holds regardless of which normalisation quirk is used next;
 *     the shape rules above are only there to fail fast.
 */
function resolveRequestUrl(target: string, origin: string): URL | null {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    return null;
  }

  return url.origin === new URL(origin).origin ? url : null;
}

/**
 * Only headers that carry a credential the caller cannot mint.
 *
 * `x-tenant` was forwarded here once. That was the whole bug: it names a tenant
 * without proving anything, so any raw client could ask for another tenant's
 * receipts and get them. A tenant must be *derived* from a verified credential,
 * never *asserted* by the caller. If a trusted proxy ever needs to inject one,
 * it has to strip the client copy first and be configured explicitly -- not
 * inherited by default here.
 */
const FORWARDED_CREDENTIAL_HEADERS = ["authorization", "cookie"] as const;

function forwardableHeaders(source: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();

  for (const name of FORWARDED_CREDENTIAL_HEADERS) {
    const value = source[name];
    if (typeof value === "string") headers.set(name, value);
  }

  return headers;
}
