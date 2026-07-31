import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SetupIntentRecord } from "@agentpay-ai/shared-arc";

import { checkWalletCreation, getAgentWallet, prepareWalletCreation } from "./wallet-setup.ts";

describe("prepareWalletCreation", () => {
  it("creates a pending setup intent and returns a signing URL", async () => {
    const created: SetupIntentRecord[] = [];

    const output = await prepareWalletCreation(
      {},
      {
        setupIntents: {
          async createSetupIntent(intent) {
            created.push(intent);
          },
          async getSetupIntent() {
            return null;
          },
        },
        executorAddress: "0x4444444444444444444444444444444444444444",
        setupWebUrl: "https://setup.agentpay.dev/setup",
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createSetupIntentId: () => "setup_123",
        setupTtlSeconds: 900,
      },
    );

    assert.equal(created.length, 1);
    assert.equal(created[0].id, "setup_123");
    assert.equal(created[0].status, "PENDING");
    assert.equal(created[0].executorAddress, "0x4444444444444444444444444444444444444444");
    assert.equal(created[0].expiresAt, "2026-07-03T04:15:00.000Z");
    assert.equal(created[0].homeChainId, 5042002);
    assert.equal(
      created[0].messageToSign,
      [
        "Create AgentPay wallet",
        "Setup ID: setup_123",
        "Owner: connected signing wallet",
        "Executor: 0x4444444444444444444444444444444444444444",
        "Chain: Arc Testnet",
        "Expires: 2026-07-03T04:15:00.000Z",
        "This signature proves wallet ownership only. It does not approve a payment or token transfer.",
      ].join("\n"),
    );
    assert.deepEqual(output, {
      setupIntentId: "setup_123",
      status: "PENDING",
      setupUrl: "https://setup.agentpay.dev/setup?setup_intent_id=setup_123",
      messageToSign: created[0].messageToSign,
      expiresAt: "2026-07-03T04:15:00.000Z",
      homeChainId: 5042002,
      homeChain: "Arc Testnet",
    });
  });

  it("returns the canonical production onboarding link without creating a legacy setup intent", async () => {
    let createCalls = 0;

    const output = await prepareWalletCreation(
      { network: "testnet" },
      {
        setupIntents: {
          async createSetupIntent() {
            createCalls += 1;
          },
          async getSetupIntent() {
            return null;
          },
        },
        executorAddress: "0x4444444444444444444444444444444444444444",
        setupWebUrl: "https://wallet.agentpay.site/arc/review",
        productionOnboardingUrl: "https://arc.agentpay.site/setup",
        clock: () => new Date("2026-07-21T04:00:00.000Z"),
        createSetupIntentId: () => "must_not_be_created",
      },
    );

    assert.equal(createCalls, 0);
    assert.deepEqual(output, {
      status: "SETUP_REQUIRED",
      setupUrl: "https://arc.agentpay.site/setup",
      homeChainId: 5042002,
      homeChain: "Arc Testnet",
      instructionToAgent: "Open the secure AgentPay setup link, connect the owner wallet, and approve the setup signature. Never share a seed phrase or private key.",
    });
  });

  it("rejects non-canonical links on the Arc onboarding path", async () => {
    const dependencies = {
      setupIntents: {
        async createSetupIntent() {},
        async getSetupIntent() { return null; },
      },
      executorAddress: "0x4444444444444444444444444444444444444444",
      setupWebUrl: "https://wallet.agentpay.site/arc/review",
      productionOnboardingUrl: "https://arc.agentpay.site/setup",
      clock: () => new Date("2026-07-21T04:00:00.000Z"),
      createSetupIntentId: () => "must_not_be_created",
    };

    await assert.rejects(
      prepareWalletCreation({}, { ...dependencies, productionOnboardingUrl: "https://evil.example/setup" }),
      /onboarding URL/i,
    );
  });

  it("includes a preset owner address in the setup signing message", async () => {
    const created: SetupIntentRecord[] = [];

    await prepareWalletCreation(
      { ownerAddress: "0x2222222222222222222222222222222222222222" },
      {
        setupIntents: {
          async createSetupIntent(intent) {
            created.push(intent);
          },
          async getSetupIntent() {
            return null;
          },
        },
        executorAddress: "0x4444444444444444444444444444444444444444",
        setupWebUrl: "https://setup.agentpay.dev/setup",
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createSetupIntentId: () => "setup_owner",
        setupTtlSeconds: 900,
      },
    );

    assert.equal(created[0].ownerAddress, "0x2222222222222222222222222222222222222222");
    assert.match(created[0].messageToSign, /Owner: 0x2222222222222222222222222222222222222222/);
    assert.match(created[0].messageToSign, /Chain: Arc Testnet/);
  });

  it("uses the requested Arc Testnet network in the setup signing message", async () => {
    const created: SetupIntentRecord[] = [];

    await prepareWalletCreation(
      { network: "testnet" },
      {
        setupIntents: {
          async createSetupIntent(intent) {
            created.push(intent);
          },
          async getSetupIntent() {
            return null;
          },
        },
        executorAddress: "0x4444444444444444444444444444444444444444",
        setupWebUrl: "https://setup.agentpay.dev/setup",
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createSetupIntentId: () => "setup_testnet",
        setupTtlSeconds: 900,
      },
    );

    assert.match(created[0].messageToSign, /Chain: Arc Testnet/);
    assert.equal(created[0].homeChainId, 5042002);
  });
});

describe("checkWalletCreation", () => {
  it("returns completed setup intent details", async () => {
    const output = await checkWalletCreation(
      { setupIntentId: "setup_123" },
      {
        setupIntents: {
          async getSetupIntent() {
            return {
              id: "setup_123",
              ownerAddress: "0x2222222222222222222222222222222222222222",
              executorAddress: "0x4444444444444444444444444444444444444444",
              messageToSign: "AgentPay wallet setup",
              status: "COMPLETED",
              expiresAt: "2026-07-03T04:15:00.000Z",
              accountAddress: "0x3333333333333333333333333333333333333333",
              completedAt: "2026-07-03T04:02:00.000Z",
              homeChainId: 5042002,
            };
          },
        },
        clock: () => new Date("2026-07-03T04:03:00.000Z"),
      },
    );

    assert.deepEqual(output, {
      setupIntentId: "setup_123",
      status: "COMPLETED",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      completedAt: "2026-07-03T04:02:00.000Z",
      expiresAt: "2026-07-03T04:15:00.000Z",
      homeChainId: 5042002,
      homeChain: "Arc Testnet",
    });
  });

  it("reports expired when a pending intent is past its signing deadline", async () => {
    const output = await checkWalletCreation(
      { setupIntentId: "setup_123" },
      {
        setupIntents: {
          async getSetupIntent() {
            return {
              id: "setup_123",
              executorAddress: "0x4444444444444444444444444444444444444444",
              messageToSign: "AgentPay wallet setup",
              status: "PENDING",
              expiresAt: "2026-07-03T04:15:00.000Z",
            };
          },
        },
        clock: () => new Date("2026-07-03T04:16:00.000Z"),
      },
    );

    assert.equal(output.status, "EXPIRED");
  });
});

describe("getAgentWallet", () => {
  it("returns active wallet details when one exists", async () => {
    const requests: unknown[] = [];
    const output = await getAgentWallet(
      { network: "testnet" },
      {
        wallets: {
          async getActiveWallet(request) {
            requests.push(request);
            return {
              ownerAddress: "0x2222222222222222222222222222222222222222",
              accountAddress: "0x3333333333333333333333333333333333333333",
              homeChainId: 5042002,
              executorAddress: "0x4444444444444444444444444444444444444444",
              status: "ACTIVE",
            };
          },
        },
      },
    );

    assert.deepEqual(requests, [{ homeChainId: 5042002 }]);
    assert.deepEqual(output, {
      status: "ACTIVE",
      wallet: {
        ownerAddress: "0x2222222222222222222222222222222222222222",
        accountAddress: "0x3333333333333333333333333333333333333333",
        homeChainId: 5042002,
        homeChain: "Arc Testnet",
        executorAddress: "0x4444444444444444444444444444444444444444",
      },
    });
  });

  it("returns NOT_CREATED when no wallet exists", async () => {
    const output = await getAgentWallet(
      {},
      {
        wallets: {
          async getActiveWallet() {
            return null;
          },
        },
      },
    );

    assert.deepEqual(output, {
      status: "NOT_CREATED",
      wallet: null,
    });
  });
});
