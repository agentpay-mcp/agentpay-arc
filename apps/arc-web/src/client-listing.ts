import type { HostedClientGrant } from "./api.ts";

/**
 * Decides whether a client listing may be applied to the screen.
 *
 * Extracted from the component so the account-switch race can actually be
 * tested. A test that calls the fetch helper twice in sequence proves the
 * helper sends two tokens; it says nothing about what happens when a response
 * lands *after* the session has been replaced, which is the bug. This function
 * makes that moment expressible: the caller can hold the response and change
 * the session before delivering it.
 */

export interface SessionSnapshot {
  readonly identity: string | null;
  readonly accessToken: string;
  readonly epoch: number;
}

export interface LiveSession {
  readonly identity: string | null;
  readonly accessToken?: string;
  readonly epoch: number;
}

export type ListingOutcome =
  | { readonly apply: true; readonly clients: readonly HostedClientGrant[] }
  /** Discarded because it belongs to a session that is no longer current. */
  | { readonly apply: false; readonly reason: "stale" }
  /** The request failed for the session that is still current. */
  | { readonly apply: false; readonly reason: "failed" };

/**
 * Both the identity and the exact credential must still match, not just one.
 * Identity alone would accept a response fetched with a rotated token, and the
 * epoch alone would accept a different account that happened to reuse it.
 */
export function isSameSession(snapshot: SessionSnapshot, live: LiveSession): boolean {
  return (
    snapshot.epoch === live.epoch
    && snapshot.identity === live.identity
    && snapshot.accessToken === live.accessToken
  );
}

export async function loadClientListing(
  snapshot: SessionSnapshot,
  live: () => LiveSession,
  fetchClients: (accessToken: string) => Promise<{ clients: readonly HostedClientGrant[] }>,
): Promise<ListingOutcome> {
  // Checked before the request goes out as well as after, so a switch that
  // happens while the token is being read never reaches the network under the
  // wrong identity.
  if (!isSameSession(snapshot, live())) {
    return { apply: false, reason: "stale" };
  }

  try {
    const result = await fetchClients(snapshot.accessToken);
    // The load-bearing check. Without it, account A's delegates render under
    // account B whenever A's response is slower than the switch.
    if (!isSameSession(snapshot, live())) {
      return { apply: false, reason: "stale" };
    }
    return { apply: true, clients: result.clients };
  } catch {
    if (!isSameSession(snapshot, live())) {
      return { apply: false, reason: "stale" };
    }
    return { apply: false, reason: "failed" };
  }
}
