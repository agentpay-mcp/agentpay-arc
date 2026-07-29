import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  CircleDeveloperWalletsAdapter,
  CircleReconciliationRequiredError,
  validateCircleDeveloperWalletsConfig,
  deriveWalletSetName,
  deriveWalletRefId,
} from "./circle-developer-wallets.ts";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.ts";

const TEST_SECRET = ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");

describe("CircleDeveloperWalletsAdapter", () => {
  it("validates config and rejects invalid entity secrets", () => {
    assert.throws(
      () =>
        validateCircleDeveloperWalletsConfig({
          apiKey: MOCK_API_KEY,
          entitySecret: "short",
        }),
      /Invalid or missing Circle Developer-Controlled entity secret configuration/,
    );
  });

  it("derives deterministic wallet set names and ref IDs for tenants", () => {
    const wsName = deriveWalletSetName("tenant-123");
    const refId = deriveWalletRefId("tenant-123");
    assert.match(wsName, /^arc-ws-[0-9a-f]{16}$/);
    assert.match(refId, /^arc-ref-[0-9a-f]{16}$/);
  });

  it("initializes production client factory when no custom client is injected", () => {
    const adapter = new CircleDeveloperWalletsAdapter({
      apiKey: MOCK_API_KEY,
      entitySecret: TEST_SECRET,
    });
    assert.ok(adapter instanceof CircleDeveloperWalletsAdapter);
  });

  it("paginates multi-page wallet sets during preflight check", async () => {
    const wsName = deriveWalletSetName("tenant-multi");
    const queriedPages: Array<string | undefined> = [];

    const mockSdk = {
      listWalletSets: async (params?: any) => {
        queriedPages.push(params?.pageAfter);
        if (!params?.pageAfter) {
          return {
            data: {
              walletSets: [{ id: "ws-page-1", name: "other-ws", custodyType: "DEVELOPER" }],
              pageAfter: "cursor-1",
            },
          };
        }
        return {
          data: {
            walletSets: [{ id: "ws-page-2", name: wsName, custodyType: "DEVELOPER" }],
          },
        };
      },
      createWalletSet: async () => ({ data: {} }),
      createWallets: async () => ({ data: { wallets: [] } }),
      listWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    } as unknown as CircleDeveloperControlledWalletsClient;

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const set = await adapter.ensureWalletSetForTenant("tenant-multi", "idempotency-p");
    assert.equal(set.id, "ws-page-2");
    assert.deepEqual(queriedPages, [undefined, "cursor-1"]);
  });

  it("throws CircleReconciliationRequiredError if wallet set create fails and reconciliation is empty", async () => {
    const mockSdk: CircleDeveloperControlledWalletsClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => {
        throw new Error("Circle API timeout during createWalletSet");
      },
      createWallets: async () => ({ data: { wallets: [] } }),
      listWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    } as any;

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    await assert.rejects(
      adapter.ensureWalletSetForTenant("tenant-timeout", "idem-timeout"),
      CircleReconciliationRequiredError,
    );
  });

  it("provisions hosted wallet, claims job, and completes setup", async () => {
    const wsName = deriveWalletSetName("t-1");
    const refId = deriveWalletRefId("t-1");
    let completedInput: any = null;

    const mockSdk: CircleDeveloperControlledWalletsClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({
        data: { walletSet: { id: "ws-1", name: wsName, custodyType: "DEVELOPER" } },
      }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({
        data: {
          wallets: [
            {
              id: "w-1",
              walletSetId: "ws-1",
              address: "0x1111111111111111111111111111111111111111",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId,
            },
          ],
        },
      }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
    } as any;

    const mockRepo: ArcHostedAccountRepository = {
      claimHostedAccount: async () => null as any,
      resolveHostedAuthority: async () => null,
      setAccountStatus: async () => {},
      claimProvisioningJob: async () => ({
        authUserId: "usr-1",
        tenantId: "t-1",
        fencingToken: "fence-1",
        provisioningIdempotencyKey: "idem-1",
        provisioningState: "PROVISIONING",
      }),
      completeProvisioning: async (input) => {
        completedInput = input;
      },
      failProvisioning: async () => {},
      getHostedAccount: async () => null,
      getPrivateWalletBinding: async () => null,
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const res = await adapter.provisionHostedUserWallet({
      authUserId: "usr-1",
      repository: mockRepo,
    });

    assert.deepEqual(res, {
      walletAddress: "0x1111111111111111111111111111111111111111",
      status: "LIVE",
    });
    assert.deepEqual(completedInput, {
      authUserId: "usr-1",
      fencingToken: "fence-1",
      circleWalletSetId: "ws-1",
      circleWalletId: "w-1",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });
  });

  it("fetches wallet balances using id param", async () => {
    let queriedId = "";
    const mockSdk: CircleDeveloperControlledWalletsClient = {
      getWalletTokenBalance: async (input: any) => {
        queriedId = input.id;
        return {
          data: {
            tokenBalances: [
              {
                token: { symbol: "USDC", address: "0x3333333333333333333333333333333333333333" },
                amount: "100.50",
              },
            ],
          },
        };
      },
    } as any;

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const balances = await adapter.getWalletBalances("w-1");
    assert.equal(queriedId, "w-1");
    assert.deepEqual(balances, [
      { symbol: "USDC", amount: "100.50", address: "0x3333333333333333333333333333333333333333" },
    ]);
  });

  it("creates developer transfers with fee configuration", async () => {
    let txInput: any = null;
    const mockSdk: CircleDeveloperControlledWalletsClient = {
      createTransaction: async (input: any) => {
        txInput = input;
        return { data: { id: "tx-transfer-1", state: "PENDING" } };
      },
    } as any;

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const res = await adapter.createDeveloperTransfer({
      walletId: "w-1",
      destinationAddress: "0x2222222222222222222222222222222222222222",
      amount: "50",
      idempotencyKey: "idem-tx-1",
    });

    assert.deepEqual(res, { transactionId: "tx-transfer-1", state: "PENDING" });
    assert.deepEqual(txInput, {
      walletId: "w-1",
      destinationAddress: "0x2222222222222222222222222222222222222222",
      amounts: ["50"],
      tokenId: undefined,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: "idem-tx-1",
    });
  });

  it("gets transaction status by transaction ID", async () => {
    let queriedId = "";
    const mockSdk: CircleDeveloperControlledWalletsClient = {
      getTransaction: async (input: any) => {
        queriedId = input.id;
        return {
          data: {
            transaction: {
              id: "tx-100",
              state: "COMPLETE",
              txHash: "0xhash123",
              walletId: "w-1",
            },
          },
        };
      },
    } as any;

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const res = await adapter.getTransactionStatus("tx-100");
    assert.equal(queriedId, "tx-100");
    assert.deepEqual(res, {
      transactionId: "tx-100",
      state: "COMPLETE",
      txHash: "0xhash123",
      walletId: "w-1",
    });
  });
});
