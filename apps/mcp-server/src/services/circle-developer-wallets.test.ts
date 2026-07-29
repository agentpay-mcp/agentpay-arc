import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CircleDeveloperWalletsAdapter,
  CircleReconciliationRequiredError,
  deriveWalletSetName,
  deriveWalletRefId,
  CircleDeveloperSdkClient,
} from "./circle-developer-wallets.ts";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.ts";

const TEST_SECRET = ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");

const VALID_USER_ID = "11111111-1111-4111-8111-111111111111";
const VALID_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROVISIONING_KEY = "33333333-3333-4333-8333-333333333333";

describe("CircleDeveloperWalletsAdapter", () => {
  const createMockRepo = (): { repo: ArcHostedAccountRepository; state: any } => {
    const state = {
      claimed: false,
      completed: false,
      failed: false,
      lastError: null as string | null,
    };

    const repo: ArcHostedAccountRepository = {
      claimHostedAccount: async () => null as any,
      resolveHostedAuthority: async () => null,
      setAccountStatus: async () => {},
      claimProvisioningJob: async (authUserId: string) => {
        if (authUserId === VALID_USER_ID && !state.claimed) {
          state.claimed = true;
          return {
            authUserId: VALID_USER_ID,
            tenantId: VALID_TENANT_ID,
            fencingToken: "1",
            provisioningState: "PROVISIONING",
            provisioningIdempotencyKey: PROVISIONING_KEY,
          };
        }
        return null;
      },
      completeProvisioning: async (input) => {
        if (input.authUserId === VALID_USER_ID && input.fencingToken === "1") {
          state.completed = true;
        }
      },
      failProvisioning: async (input) => {
        if (input.authUserId === VALID_USER_ID && input.fencingToken === "1") {
          state.failed = true;
          state.lastError = input.errorCode;
        }
      },
      getHostedAccount: async () => null,
      getPrivateWalletBinding: async () => null,
    };

    return { repo, state };
  };

  it("provisions a new tenant wallet when no existing set/wallet exists", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async (input: any) => ({
        data: {
          walletSet: {
            id: "ws-new-1",
            name: input.name,
            custodyType: "DEVELOPER",
          },
        },
      }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async (input: any) => ({
        data: {
          wallets: [
            {
              id: "w-new-1",
              walletSetId: input.walletSetId,
              address: "0x1111111111111111111111111111111111111111",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId: input.metadata?.[0]?.refId,
            },
          ],
        },
      }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );
    const { repo, state } = createMockRepo();

    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_USER_ID,
      repository: repo,
    });

    assert.equal(res.status, "LIVE");
    assert.equal(res.walletAddress, "0x1111111111111111111111111111111111111111");
    assert.equal(state.completed, true);
    assert.equal(state.failed, false);
  });

  it("paginates wallet sets and wallets using collection-ID pageAfter cursors", async () => {
    const walletSetName = deriveWalletSetName(VALID_TENANT_ID);
    const refId = deriveWalletRefId(VALID_TENANT_ID);

    const page1WalletSets = Array.from({ length: 50 }, (_, i) => ({
      id: `ws-page1-${i}`,
      name: `other-ws-${i}`,
      custodyType: "DEVELOPER",
    }));

    let listWalletSetsCalls = 0;
    let listWalletsCalls = 0;

    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async (params?: any) => {
        listWalletSetsCalls++;
        if (!params?.pageAfter) {
          return { data: { walletSets: page1WalletSets } };
        }
        if (params.pageAfter === "ws-page1-49") {
          return {
            data: {
              walletSets: [
                {
                  id: "ws-target-page2",
                  name: walletSetName,
                  custodyType: "DEVELOPER",
                },
              ],
            },
          };
        }
        return { data: { walletSets: [] } };
      },
      createWalletSet: async () => ({ data: {} }),
      listWallets: async (params?: any) => {
        listWalletsCalls++;
        if (!params?.pageAfter) {
          const page1Wallets = Array.from({ length: 50 }, (_, i) => ({
            id: `w-page1-${i}`,
            walletSetId: "ws-target-page2",
            address: "0x2222222222222222222222222222222222222222",
            blockchain: "ARC-TESTNET",
            accountType: "SCA",
            custodyType: "DEVELOPER",
            refId: `other-ref-${i}`,
          }));
          return { data: { wallets: page1Wallets } };
        }
        if (params.pageAfter === "w-page1-49") {
          return {
            data: {
              wallets: [
                {
                  id: "w-target-page2",
                  walletSetId: "ws-target-page2",
                  address: "0x3333333333333333333333333333333333333333",
                  blockchain: "ARC-TESTNET",
                  accountType: "SCA",
                  custodyType: "DEVELOPER",
                  refId: refId,
                },
              ],
            },
          };
        }
        return { data: { wallets: [] } };
      },
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const ws = await adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY);
    assert.equal(ws.id, "ws-target-page2");
    assert.equal(listWalletSetsCalls, 2);

    const w = await adapter.ensureScaWalletForTenant(VALID_TENANT_ID, "ws-target-page2", PROVISIONING_KEY);
    assert.equal(w.id, "w-target-page2");
    assert.equal(listWalletsCalls, 2);
  });

  it("raises CircleReconciliationRequiredError on ambiguous post-mutation timeout without calling failProvisioning", async () => {
    let createWalletSetCalled = false;
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => {
        createWalletSetCalled = true;
        throw new Error("ETIMEDOUT: Connection timed out");
      },
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );
    const { repo, state } = createMockRepo();

    await assert.rejects(
      adapter.provisionHostedUserWallet({
        authUserId: VALID_USER_ID,
        repository: repo,
      }),
      (err: any) => err instanceof CircleReconciliationRequiredError,
    );

    assert.equal(createWalletSetCalled, true);
    assert.equal(state.failed, false, "Must NOT mark provisioning as permanently failed on ambiguous timeout");
  });
});
