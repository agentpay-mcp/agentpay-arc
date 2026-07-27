import {
  renderActivity,
  renderCatalogue,
  renderError,
  renderNotFound,
  renderUnauthorized,
  renderServiceDetail,
  type RenderedActivity,
  type RenderedJob,
  type RenderedService,
  type RenderedTrust,
} from "./page.ts";

export type MarketplaceService = RenderedService;
export type MarketplaceTrust = RenderedTrust;
export type MarketplaceJob = RenderedJob;
export type MarketplaceActivity = RenderedActivity;

/**
 * Read-only dependencies, injected by the integrator.
 *
 * There is deliberately no write surface and no direct database client here.
 * The hosted marketplace can display state; it can never change it, and it
 * never holds a credential that could.
 */
export interface MarketplaceSession {
  readonly tenantId: string;
}

export interface MarketplaceDependencies {
  /**
   * Resolves a verified server-side session from the request. Returning null
   * means anonymous. Tenant identity is never taken from a query parameter or
   * any other caller-supplied value.
   */
  readonly sessions: {
    resolve(request: Request): Promise<MarketplaceSession | null>;
  };
  readonly services: {
    search(input: { readonly query?: string; readonly category?: string }): Promise<
      readonly MarketplaceService[]
    >;
    get(id: string): Promise<MarketplaceService | null>;
  };
  readonly trust: {
    get(sellerAgentId: string): Promise<MarketplaceTrust | null>;
  };
  readonly jobs: {
    listForSeller(sellerAddress: string): Promise<readonly MarketplaceJob[]>;
  };
  readonly activity: {
    listForTenant(tenantId: string): Promise<readonly MarketplaceActivity[]>;
  };
}

/**
 * `script-src 'none'` is the load-bearing line: it makes "this page cannot
 * execute a wallet action" a property the browser enforces, not just a
 * convention we followed while writing the markup.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "connect-src 'none'",
  // The catalogue renders a same-origin GET filter; 'none' would silently
  // break it in a real browser while every direct-URL test still passed.
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function htmlResponse(html: string, status: number, cacheControl: string): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": cacheControl,
    },
  });
}

/** The public catalogue is cacheable; anything tenant-scoped is not. */
const PUBLIC_CACHE = "public, max-age=30";
const PRIVATE_CACHE = "no-store";

function optionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

export function createMarketplaceHandler(dependencies: MarketplaceDependencies) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return htmlResponse(renderNotFound(), 405, PRIVATE_CACHE);
    }

    try {
      if (url.pathname === "/") {
        const filters = {
          ...(optionalParam(url, "q") === undefined ? {} : { query: optionalParam(url, "q") }),
          ...(optionalParam(url, "category") === undefined
            ? {}
            : { category: optionalParam(url, "category") }),
        };
        const services = await dependencies.services.search(filters);
        return htmlResponse(renderCatalogue(services, filters), 200, PUBLIC_CACHE);
      }

      if (url.pathname === "/activity") {
        // Receipts are tenant data. Without a verified session there is nothing
        // to scope them to, so the answer is 401 rather than "everyone's".
        const session = await dependencies.sessions.resolve(request);
        if (!session) {
          return htmlResponse(renderUnauthorized(), 401, PRIVATE_CACHE);
        }

        const entries = await dependencies.activity.listForTenant(session.tenantId);
        return htmlResponse(renderActivity(entries), 200, PRIVATE_CACHE);
      }

      if (url.pathname.startsWith("/services/")) {
        const id = decodeURIComponent(url.pathname.slice("/services/".length));
        const service = await dependencies.services.get(id);
        if (!service) return htmlResponse(renderNotFound(), 404, PUBLIC_CACHE);

        // "No identity found" and "we could not reach the identity registry"
        // are different claims. Collapsing them would let an outage read as a
        // verified absence, which is the same failure mode as rendering an
        // unverified seller as trusted.
        const [trust, jobs] = await Promise.all([
          service.sellerAgentId
            ? dependencies.trust
                .get(service.sellerAgentId)
                .then((value) => ({ status: "ok" as const, value }))
                .catch(() => ({ status: "unavailable" as const }))
            : Promise.resolve({ status: "ok" as const, value: null }),
          dependencies.jobs
            .listForSeller(service.sellerAddress)
            .then((value) => ({ status: "ok" as const, value }))
            .catch(() => ({ status: "unavailable" as const })),
        ]);

        return htmlResponse(renderServiceDetail(service, trust, jobs), 200, PUBLIC_CACHE);
      }

      return htmlResponse(renderNotFound(), 404, PUBLIC_CACHE);
    } catch {
      // The underlying error may name tables, hosts, or filesystem paths. The
      // page says only that the surface is unavailable.
      return htmlResponse(
        renderError("The marketplace is temporarily unavailable. Please try again shortly."),
        503,
        PRIVATE_CACHE,
      );
    }
  };
}
