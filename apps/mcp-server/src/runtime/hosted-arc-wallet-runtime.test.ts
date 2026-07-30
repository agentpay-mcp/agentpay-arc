import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.ts";
import type {
  HostedArcWalletFacade,
} from "./hosted-arc-wallet-runtime.ts";
import {
  HOSTED_ARC_TOOL_NAMES,
  HOSTED_ARC_TOOL_REGISTRY,
  createHostedArcWalletRuntime,
} from "./hosted-arc-wallet-runtime.ts";

const AUTH_USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";
const RECIPIENT_ADDRESS = "0x3333333333333333333333333333333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

const authority: ArcHostedAuthority = {
  authUserId: AUTH_USER_ID,
  tenantId: TENANT_ID,
  walletAddress: WALLET_ADDRESS,
  accountStatus: "ACTIVE",
  authEpoch: 7,
  oauthClientId: "codex-client",
};

interface RuntimeTestContext {
  readonly repository: ArcHostedAccountRepository;
  readonly facade: HostedArcWalletFacade;
  readonly calls: {
    readonly authorityResolutions: Array<{
      authUserId: string;
      oauthClientId?: string;
    }>;
    readonly facadeAuthorities: ArcHostedAuthority[];
    readonly transfers: unknown[];
    readonly receipts: string[];
    readonly unifiedBalances: Array<{
      address: string;
      includePending: boolean;
    }>;
  };
  setCurrentAuthority(current: ArcHostedAuthority | null): void;
}

function createContext(): RuntimeTestContext {
  let currentAuthority: ArcHostedAuthority | null = authority;
  const calls: RuntimeTestContext["calls"] = {
    authorityResolutions: [],
    facadeAuthorities: [],
    transfers: [],
    receipts: [],
    unifiedBalances: [],
  };

  const repository: ArcHostedAccountRepository = {
    async claimHostedAccount() {
      throw new Error("not used");
    },
    async getHostedAccount() {
      return null;
    },
    async resolveHostedAuthority(input) {
      calls.authorityResolutions.push({ ...input });
      return currentAuthority ? { ...currentAuthority } : null;
    },
    async claimProvisioningJob() {
      return null;
    },
    async completeProvisioning() {},
    async failProvisioning() {},
    async setAccountStatus() {},
    async getPrivateWalletBinding() {
      return null;
    },
  };

  const facade: HostedArcWalletFacade = {
    async getWallet(freshAuthority) {
      calls.facadeAuthorities.push({ ...freshAuthority });
      return {
        walletAddress: freshAuthority.walletAddress,
        chain: "ARC-TESTNET",
        accountType: "SCA",
        custodyType: "DEVELOPER",
        status: "LIVE",
      };
    },
    async getBalances(freshAuthority) {
      calls.facadeAuthorities.push({ ...freshAuthority });
      return [
        {
          symbol: "USDC",
          amount: "25.5",
          address: "0x3600000000000000000000000000000000000000",
        },
      ];
    },
    async transferTokens(freshAuthority, input) {
      calls.facadeAuthorities.push({ ...freshAuthority });
      calls.transfers.push({ ...input });
      return { transactionId: "circle-tx-1", state: "INITIATED" };
    },
    async getTransactionStatus(freshAuthority, transactionId) {
      calls.facadeAuthorities.push({ ...freshAuthority });
      calls.receipts.push(transactionId);
      return {
        transactionId,
        state: "COMPLETE",
        txHash: `0x${"a".repeat(64)}`,
      };
    },
    async createAppKitAdapter(freshAuthority) {
      calls.facadeAuthorities.push({ ...freshAuthority });
      return {
        getSupportedChains: () => [],
        async getUnifiedBalances(address, includePending) {
          calls.unifiedBalances.push({ address, includePending });
          return {
            token: "USDC",
            confirmed: "20",
            pending: includePending ? "2" : null,
            pendingAvailable: includePending,
            breakdown: [],
          };
        },
        async estimateBridge() {
          throw new Error("not supported by hosted runtime");
        },
        async estimateSwap() {
          throw new Error("not supported by hosted runtime");
        },
      };
    },
  };

  return {
    repository,
    facade,
    calls,
    setCurrentAuthority(current) {
      currentAuthority = current;
    },
  };
}

describe("createHostedArcWalletRuntime", () => {
  it("advertises exactly the five truthfully supported hosted tools", () => {
    assert.deepEqual(HOSTED_ARC_TOOL_NAMES, [
      "setup_agent_wallet",
      "get_agent_budget",
      "send_usdc",
      "get_payment_receipt",
      "get_unified_balance",
    ]);
    assert.deepEqual(Object.keys(HOSTED_ARC_TOOL_REGISTRY), HOSTED_ARC_TOOL_NAMES);

    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });
    assert.deepEqual(runtime.toolNames, HOSTED_ARC_TOOL_NAMES);
  });

  it("maps all five tools through a freshly revalidated tenant authority", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    assert.deepEqual(await runtime.dispatch("setup_agent_wallet", {}), {
      walletAddress: WALLET_ADDRESS,
      chain: "ARC-TESTNET",
      accountType: "SCA",
      custodyType: "DEVELOPER",
      status: "LIVE",
    });
    assert.deepEqual(await runtime.dispatch("get_agent_budget", {}), {
      walletAddress: WALLET_ADDRESS,
      chain: "ARC-TESTNET",
      balances: [
        {
          symbol: "USDC",
          amount: "25.5",
          address: "0x3600000000000000000000000000000000000000",
        },
      ],
    });
    assert.deepEqual(
      await runtime.dispatch("send_usdc", {
        recipient: RECIPIENT_ADDRESS,
        amount: "1.25",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      { transactionId: "circle-tx-1", state: "INITIATED" },
    );
    assert.deepEqual(
      await runtime.dispatch("get_payment_receipt", {
        transactionId: "circle-tx-1",
      }),
      {
        transactionId: "circle-tx-1",
        state: "COMPLETE",
        txHash: `0x${"a".repeat(64)}`,
      },
    );
    assert.deepEqual(
      await runtime.dispatch("get_unified_balance", {
        includePending: false,
      }),
      {
        token: "USDC",
        confirmed: "20",
        pending: null,
        pendingAvailable: false,
        breakdown: [],
      },
    );

    assert.equal(context.calls.authorityResolutions.length, 5);
    assert.deepEqual(
      context.calls.authorityResolutions,
      Array.from({ length: 5 }, () => ({
        authUserId: AUTH_USER_ID,
        oauthClientId: "codex-client",
      })),
    );
    assert.equal(context.calls.facadeAuthorities.length, 5);
    assert.ok(
      context.calls.facadeAuthorities.every(
        (resolved) =>
          resolved.authUserId === AUTH_USER_ID
          && resolved.tenantId === TENANT_ID
          && resolved.walletAddress === WALLET_ADDRESS
          && resolved.authEpoch === 7,
      ),
    );
    assert.deepEqual(context.calls.transfers, [
      {
        toAddress: RECIPIENT_ADDRESS,
        amount: "1.25",
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    ]);
    assert.deepEqual(context.calls.receipts, ["circle-tx-1"]);
    assert.deepEqual(context.calls.unifiedBalances, [
      { address: WALLET_ADDRESS, includePending: false },
    ]);
  });

  it("accepts the bound wallet explicitly but rejects a different wallet", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await runtime.dispatch("get_agent_budget", {
      walletAddress: WALLET_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(context.calls.facadeAuthorities.length, 1);

    await assert.rejects(
      runtime.dispatch("get_agent_budget", {
        walletAddress: OTHER_WALLET_ADDRESS,
      }),
      /walletAddress does not match authenticated hosted wallet/,
    );
    assert.equal(context.calls.facadeAuthorities.length, 1);
  });

  it("rejects caller-selected tenant or authority fields at the schema boundary", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await assert.rejects(
      runtime.dispatch("get_agent_budget", {
        tenantId: OTHER_TENANT_ID,
      }),
      /Unrecognized key.*tenantId/,
    );
    await assert.rejects(
      runtime.dispatch("setup_agent_wallet", {
        authUserId: AUTH_USER_ID,
      }),
      /Unrecognized key.*authUserId/,
    );
    assert.equal(context.calls.authorityResolutions.length, 0);
  });

  it("fails closed when the current authority crosses tenant or wallet boundaries", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    context.setCurrentAuthority({ ...authority, tenantId: OTHER_TENANT_ID });
    await assert.rejects(
      runtime.dispatch("get_agent_budget", {}),
      /Hosted authority no longer matches the authenticated session/,
    );

    context.setCurrentAuthority({
      ...authority,
      walletAddress: OTHER_WALLET_ADDRESS,
    });
    await assert.rejects(
      runtime.dispatch("send_usdc", {
        recipient: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      /Hosted authority no longer matches the authenticated session/,
    );
    assert.equal(context.calls.facadeAuthorities.length, 0);
  });

  it("rejects stale epoch, paused/revoked authority, and OAuth client mismatch", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    context.setCurrentAuthority({ ...authority, authEpoch: 8 });
    await assert.rejects(
      runtime.dispatch("setup_agent_wallet", {}),
      /Hosted authority no longer matches the authenticated session/,
    );

    context.setCurrentAuthority({ ...authority, accountStatus: "PAUSED" });
    await assert.rejects(
      runtime.dispatch("get_payment_receipt", {
        transactionId: "circle-tx-1",
      }),
      /Hosted authority is stale, revoked, paused, or unavailable/,
    );

    context.setCurrentAuthority(null);
    await assert.rejects(
      runtime.dispatch("get_unified_balance", {}),
      /Hosted authority is stale, revoked, paused, or unavailable/,
    );

    context.setCurrentAuthority({
      ...authority,
      oauthClientId: "other-client",
    });
    await assert.rejects(
      runtime.dispatch("get_agent_budget", {}),
      /Hosted authority no longer matches the authenticated session/,
    );
    assert.equal(context.calls.facadeAuthorities.length, 0);
  });

  it("fails closed for unknown tool names without resolving authority", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    await assert.rejects(
      runtime.dispatch("fund_agent_wallet", {}),
      /Unknown hosted Arc tool: fund_agent_wallet/,
    );
    assert.equal(context.calls.authorityResolutions.length, 0);
  });

  it("rejects invalid amount, destination, and idempotency before mutation", async () => {
    const context = createContext();
    const runtime = createHostedArcWalletRuntime({
      authority,
      repository: context.repository,
      facade: context.facade,
    });

    for (const invalidInput of [
      {
        recipient: RECIPIENT_ADDRESS,
        amount: "0",
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      {
        recipient: RECIPIENT_ADDRESS,
        amount: "0.0000001",
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      {
        recipient: "0xnot-an-address",
        amount: "1",
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      {
        recipient: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: "caller-key",
      },
      {
        recipient: RECIPIENT_ADDRESS,
        amount: "1",
        idempotencyKey: "44444444-4444-1444-8444-444444444444",
      },
    ]) {
      await assert.rejects(runtime.dispatch("send_usdc", invalidInput));
    }

    assert.equal(context.calls.authorityResolutions.length, 0);
    assert.equal(context.calls.transfers.length, 0);
  });
});
