import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

import { createHostedArcWalletRuntime } from "./hosted-arc-wallet-runtime.js";
import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.js";
import type { HostedArcWalletFacade } from "./hosted-arc-wallet-runtime.js";

/**
 * Dynamic client registration is enabled on the hosted Arc surface, so any
 * client can register and complete OAuth. Authentication proves who is calling;
 * it does not decide what they may do. Without a capability check, a client the
 * user approved for reading their balance can also move their money.
 *
 * These tests are written against dispatch, the single point every tool call
 * passes through, rather than against any individual tool -- a check placed on
 * one tool would leave the next one added unguarded.
 */

const AUTH_USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const RECIPIENT_ADDRESS = "0x3333333333333333333333333333333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

function authorityWith(capabilities: readonly string[]): ArcHostedAuthority {
  return {
    authUserId: AUTH_USER_ID,
    tenantId: TENANT_ID,
    walletAddress: WALLET_ADDRESS,
    accountStatus: "ACTIVE",
    authEpoch: 7,
    oauthClientId: "some-registered-client",
    capabilities,
  } as ArcHostedAuthority;
}

/**
 * Records whether the money-moving call was reached. A test that only asserts
 * dispatch rejected would still pass if the transfer had already been sent, so
 * the assertion that matters is that the facade was never called.
 */
function createContext(authority: ArcHostedAuthority) {
  const transfers: unknown[] = [];

  const repository = {
    async resolveHostedAuthority() {
      return authority;
    },
  } as unknown as ArcHostedAccountRepository;

  const facade = {
    async getWallet() {
      return { walletAddress: WALLET_ADDRESS, tenantId: TENANT_ID, status: "LIVE" };
    },
    async getBalances() {
      return [];
    },
    async transferTokens(_authority: unknown, input: unknown) {
      transfers.push(input);
      return { transactionId: "tx", state: "SUBMITTED" };
    },
    async getTransactionStatus() {
      return { transactionId: "tx", state: "COMPLETE" };
    },
  } as unknown as HostedArcWalletFacade;

  return { repository, facade, transfers };
}

const sendInput = {
  walletAddress: WALLET_ADDRESS,
  recipient: RECIPIENT_ADDRESS,
  amount: "0.01",
  idempotencyKey: IDEMPOTENCY_KEY,
};

describe("hosted capability enforcement", () => {
  it("refuses send_usdc for a client granted only read capability", async () => {
    const authority = authorityWith(["wallet:read"]);
    const context = createContext(authority);
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await assert.rejects(
      () => runtime.dispatch("send_usdc", sendInput),
      /capab|authori|permit/i,
      "a read-only client must not reach the payment tool",
    );

    assert.deepEqual(context.transfers, [], "no transfer may be attempted for a refused call");
  });

  it("allows send_usdc for a client granted payment capability", async () => {
    const authority = authorityWith(["wallet:read", "payment:send"]);
    const context = createContext(authority);
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await runtime.dispatch("send_usdc", sendInput);

    assert.equal(context.transfers.length, 1, "an explicitly granted client must still be able to pay");
  });

  it("still allows read tools for a read-only client", async () => {
    // Enforcement must be scoped to the mutation. Refusing everything would be
    // a denial of service dressed up as a security control.
    const authority = authorityWith(["wallet:read"]);
    const context = createContext(authority);
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await runtime.dispatch("get_agent_budget", { walletAddress: WALLET_ADDRESS });
  });

  it("fails closed when no capability is recorded at all", async () => {
    // An absent grant is the normal state for a newly registered client. It
    // must read as "nothing granted", never as "unrestricted".
    const authority = authorityWith([]);
    const context = createContext(authority);
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await assert.rejects(() => runtime.dispatch("send_usdc", sendInput), /capab|authori|permit/i);
    assert.deepEqual(context.transfers, []);
  });

  it("refuses when the capability is revoked between construction and the call", async () => {
    // The runtime re-resolves authority before every mutation. A grant revoked
    // after the session started must stop the next payment, not the one after.
    const granted = authorityWith(["wallet:read", "payment:send"]);
    const revoked = authorityWith(["wallet:read"]);

    const transfers: unknown[] = [];
    const repository = {
      async resolveHostedAuthority() {
        return revoked;
      },
    } as unknown as ArcHostedAccountRepository;
    const facade = {
      async transferTokens(_authority: unknown, input: unknown) {
        transfers.push(input);
        return { transactionId: "tx", state: "SUBMITTED" };
      },
    } as unknown as HostedArcWalletFacade;

    const runtime = createHostedArcWalletRuntime({ authority: granted, repository, facade });

    await assert.rejects(() => runtime.dispatch("send_usdc", sendInput));
    assert.deepEqual(transfers, [], "a revoked grant must stop the transfer before it is sent");
  });
});
