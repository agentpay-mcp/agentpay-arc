import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

import type { ArcHostedAccountRepository } from "../services/arc-hosted-accounts.ts";
import type { HostedArcWalletFacade } from "./hosted-arc-wallet-runtime.ts";
import {
  createDefaultHostedArcRuntime,
  type DefaultHostedArcRepositoryConfig,
} from "./default-hosted-arc-runtime.ts";

const MOCK_CIRCLE_API_KEY = ["circle", "api", "fixture"].join("-");
const MOCK_SERVICE_ROLE_KEY = ["service", "role", "fixture"].join("-");

const authority: ArcHostedAuthority = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  walletAddress: "0x1111111111111111111111111111111111111111",
  accountStatus: "ACTIVE",
  authEpoch: 1,
};

function fakeRepository(): ArcHostedAccountRepository {
  return {
    async claimHostedAccount() {
      throw new Error("not used");
    },
    async getHostedAccount() {
      return null;
    },
    async resolveHostedAuthority() {
      return { ...authority };
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
}

function fakeFacade(): HostedArcWalletFacade {
  return {
    async getWallet(currentAuthority) {
      return {
        walletAddress: currentAuthority.walletAddress,
        chain: "ARC-TESTNET",
        accountType: "SCA",
        custodyType: "DEVELOPER",
        status: "LIVE",
      };
    },
    async getBalances() {
      return [];
    },
    async transferTokens() {
      return { transactionId: "tx-1", state: "INITIATED" };
    },
    async getTransactionStatus(_currentAuthority, transactionId) {
      return { transactionId, state: "COMPLETE" };
    },
    async createAppKitAdapter() {
      throw new Error("not used");
    },
  };
}

describe("createDefaultHostedArcRuntime", () => {
  it("supports full dependency injection without reading secrets or making requests", async () => {
    const runtime = createDefaultHostedArcRuntime(authority, {
      env: {},
      repository: fakeRepository(),
      facade: fakeFacade(),
    });

    assert.deepEqual(await runtime.dispatch("setup_agent_wallet", {}), {
      walletAddress: authority.walletAddress,
      chain: "ARC-TESTNET",
      accountType: "SCA",
      custodyType: "DEVELOPER",
      status: "LIVE",
    });
  });

  it("constructs injected factories without performing repository or facade operations", () => {
    const repository = fakeRepository();
    const facade = fakeFacade();
    const repositoryConfigs: DefaultHostedArcRepositoryConfig[] = [];
    let factoryRepository: ArcHostedAccountRepository | undefined;
    let facadeFactoryCalls = 0;
    let networkOperationCalls = 0;

    const runtime = createDefaultHostedArcRuntime(authority, {
      env: {
        ARC_SUPABASE_URL: " https://arc-project.supabase.co ",
        ARC_SUPABASE_SERVICE_ROLE_KEY: ` ${MOCK_SERVICE_ROLE_KEY} `,
        ARC_CIRCLE_API_KEY: ` ${MOCK_CIRCLE_API_KEY} `,
        ARC_CIRCLE_ENTITY_SECRET: "a".repeat(64),
      },
      repositoryFactory(config) {
        repositoryConfigs.push({ ...config });
        factoryRepository = {
          ...repository,
          async resolveHostedAuthority(input) {
            networkOperationCalls += 1;
            return repository.resolveHostedAuthority(input);
          },
        };
        return factoryRepository;
      },
      facadeFactory(config, receivedRepository) {
        facadeFactoryCalls += 1;
        assert.equal(receivedRepository, factoryRepository);
        assert.deepEqual(config, {
          apiKey: MOCK_CIRCLE_API_KEY,
          entitySecret: "a".repeat(64),
        });
        return {
          ...facade,
          async getWallet(currentAuthority) {
            networkOperationCalls += 1;
            return facade.getWallet(currentAuthority);
          },
        };
      },
    });

    assert.deepEqual(repositoryConfigs, [
      {
        supabaseUrl: "https://arc-project.supabase.co",
        serviceRoleKey: MOCK_SERVICE_ROLE_KEY,
      },
    ]);
    assert.equal(facadeFactoryCalls, 1);
    assert.equal(networkOperationCalls, 0);
    assert.deepEqual(runtime.toolNames, [
      "setup_agent_wallet",
      "get_agent_budget",
      "send_usdc",
      "get_payment_receipt",
      "get_unified_balance",
    ]);
  });

  it("fails fast on missing or invalid repository configuration", () => {
    assert.throws(
      () =>
        createDefaultHostedArcRuntime(authority, {
          env: {
            ARC_SUPABASE_URL: "http://insecure.example",
            ARC_SUPABASE_SERVICE_ROLE_KEY: MOCK_SERVICE_ROLE_KEY,
          },
          facade: fakeFacade(),
          repositoryFactory: () => fakeRepository(),
        }),
      /ARC_SUPABASE_URL/,
    );
    assert.throws(
      () =>
        createDefaultHostedArcRuntime(authority, {
          env: {},
          facade: fakeFacade(),
          repositoryFactory: () => fakeRepository(),
        }),
      /ARC_SUPABASE_URL|ARC_SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("does not issue a network request while constructing default adapters", () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network request attempted during construction");
    };

    try {
      const runtime = createDefaultHostedArcRuntime(authority, {
        env: {
          ARC_SUPABASE_URL: "https://arc-project.supabase.co",
          ARC_SUPABASE_SERVICE_ROLE_KEY: MOCK_SERVICE_ROLE_KEY,
          ARC_CIRCLE_API_KEY: MOCK_CIRCLE_API_KEY,
          ARC_CIRCLE_ENTITY_SECRET: "a".repeat(64),
        },
      });

      assert.equal(fetchCalls, 0);
      assert.deepEqual(runtime.toolNames, [
        "setup_agent_wallet",
        "get_agent_budget",
        "send_usdc",
        "get_payment_receipt",
        "get_unified_balance",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails fast on missing Circle configuration when facade is not injected", () => {
    assert.throws(
      () =>
        createDefaultHostedArcRuntime(authority, {
          env: {},
          repository: fakeRepository(),
          facadeFactory: () => fakeFacade(),
        }),
      /Circle Developer-Controlled API key configuration/,
    );
  });
});
