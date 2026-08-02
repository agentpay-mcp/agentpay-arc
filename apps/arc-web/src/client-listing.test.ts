import assert from "node:assert/strict";
import { test } from "node:test";

import { loadClientListing, type LiveSession, type SessionSnapshot } from "./client-listing.ts";

/**
 * The account-switch race, reproduced rather than described.
 *
 * The previous attempt at this called the fetch helper twice in sequence. That
 * proves the helper sends two different tokens; it says nothing about a
 * response landing *after* the session was replaced, which is the actual bug —
 * and it stayed green with the guard removed.
 *
 * Here the response is held open while the session changes, so removing the
 * guard turns these red.
 */

const ACCOUNT_A: SessionSnapshot = { identity: "user-a", accessToken: "token-a", epoch: 1 };

function live(overrides: Partial<LiveSession> = {}): LiveSession {
  return { identity: "user-a", accessToken: "token-a", epoch: 1, ...overrides };
}

test("a listing that lands after an account switch is discarded", async () => {
  let release = () => {};
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = live();

  const pending = loadClientListing(ACCOUNT_A, () => current, async () => {
    await inFlight;
    return {
      clients: [
        { oauthClientId: "a-delegate", canRead: true, canSendPayments: true, revoked: false },
      ],
    };
  });

  // The switch happens while account A's request is still open.
  current = { identity: "user-b", accessToken: "token-b", epoch: 2 };
  release();

  const outcome = await pending;

  assert.equal(outcome.apply, false, "account A's delegates must not reach account B's screen");
  assert.equal(outcome.apply === false && outcome.reason, "stale");
});

test("a listing that lands after only the credential rotated is discarded", async () => {
  // Same user, new token. Identity alone would accept this, which is why the
  // exact credential is part of the check.
  let release = () => {};
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = live();

  const pending = loadClientListing(ACCOUNT_A, () => current, async () => {
    await inFlight;
    return { clients: [] };
  });

  current = live({ accessToken: "token-a-rotated" });
  release();

  assert.equal((await pending).apply, false);
});

test("a listing for the still-current session is applied", async () => {
  // The guard must not reject everything: refusing all listings would be a
  // broken panel dressed up as a safety property.
  const outcome = await loadClientListing(ACCOUNT_A, live, async () => ({
    clients: [
      { oauthClientId: "a-delegate", canRead: true, canSendPayments: false, revoked: false },
    ],
  }));

  assert.equal(outcome.apply, true);
  assert.equal(outcome.apply === true && outcome.clients.length, 1);
});

test("a failure for the current session is reported, not silently ignored", async () => {
  const outcome = await loadClientListing(ACCOUNT_A, live, async () => {
    throw new Error("network");
  });

  assert.equal(outcome.apply, false);
  assert.equal(outcome.apply === false && outcome.reason, "failed");
});

test("a failure that arrives after a switch is stale, not a failure for the new account", async () => {
  // Reporting it as "failed" would clear account B's panel because of account
  // A's error.
  let current = live();
  const outcome = await loadClientListing(ACCOUNT_A, () => current, async () => {
    current = { identity: "user-b", accessToken: "token-b", epoch: 2 };
    throw new Error("network");
  });

  assert.equal(outcome.apply === false && outcome.reason, "stale");
});

test("the request is never issued when the session already changed", async () => {
  let requested = false;
  const outcome = await loadClientListing(
    ACCOUNT_A,
    () => ({ identity: "user-b", accessToken: "token-b", epoch: 2 }),
    async () => {
      requested = true;
      return { clients: [] };
    },
  );

  assert.equal(requested, false, "a stale session must not reach the network at all");
  assert.equal(outcome.apply, false);
});
