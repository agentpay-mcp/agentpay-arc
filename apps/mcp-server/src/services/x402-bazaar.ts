import { normalizeX402BazaarResource, type ParsedSearchX402ServicesInput, type X402BazaarResource } from "@agentpay-ai/shared-arc";

import type { X402BazaarDiscoveryProvider } from "../tools/x402-bazaar.ts";

export const DEFAULT_X402_BAZAAR_FACILITATOR_URL = "https://x402.org/facilitator";

export interface X402BazaarDiscoveryProviderConfig {
  facilitatorUrl?: string;
  fetch?: typeof fetch;
}

interface X402BazaarSearchResponse {
  resources?: unknown[];
  partialResults?: boolean;
  pagination?: {
    cursor?: string | null;
  } | null;
}

export function createX402BazaarDiscoveryProvider(
  config: X402BazaarDiscoveryProviderConfig = {},
): X402BazaarDiscoveryProvider {
  const facilitatorUrl = (config.facilitatorUrl ?? DEFAULT_X402_BAZAAR_FACILITATOR_URL).replace(/\/+$/, "");
  const fetcher = config.fetch ?? fetch;

  return {
    async search(input: ParsedSearchX402ServicesInput) {
      const url = new URL(`${facilitatorUrl}/discovery/search`);
      url.searchParams.set("query", input.query);
      url.searchParams.set("type", input.type);

      if (input.network) {
        url.searchParams.set("network", input.network);
      }

      url.searchParams.set("limit", input.limit.toString());

      if (input.cursor) {
        url.searchParams.set("cursor", input.cursor);
      }

      const response = await fetcher(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`x402 Bazaar search failed (${response.status}): ${errorText}`);
      }

      const body = (await response.json()) as X402BazaarSearchResponse;
      const resources: X402BazaarResource[] = (body.resources ?? []).map((resource) =>
        normalizeX402BazaarResource(resource),
      );

      return {
        resources,
        ...(body.pagination?.cursor ? { nextCursor: body.pagination.cursor } : {}),
        ...(body.partialResults !== undefined ? { partialResults: body.partialResults } : {}),
      };
    },
  };
}
