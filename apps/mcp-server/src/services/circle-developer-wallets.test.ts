import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CircleDeveloperWalletsAdapter,
  CircleReconciliationRequiredError,
  validateCircleDeveloperWalletsConfig,
  redactSecretsAndFormatError,
  deriveWalletSetName,
  deriveWalletRefId,
  CircleDeveloperSdkClient,
  ARC_HOSTED_USDC_TOKEN_ADDRESS,
} from "./circle-developer-wallets.js";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";

const TEST_SECRET = ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");

const VALID_USER_ID = "11111111-1111-4111-8111-111111111111";
const VALID_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROVISIONING_KEY = "33333333-3333-4333-8333-333333333333";

describe("CircleDeveloperWalletsAdapter & Config Validation", () => {
  it("validates config correctly and throws on invalid credentials", () => {
    assert.throws(() => validateCircleDeveloperWalletsConfig({ apiKey: "" }), /Invalid or missing Circle Developer-Controlled API key/);
    assert.throws(() => validateCircleDeveloperWalletsConfig({ apiKey: "key", entitySecret: "short" }), /Invalid or missing Circle Developer-Controlled entity secret/);
    const valid = validateCircleDeveloperWalletsConfig({ apiKey: "key", entitySecret: TEST_SECRET });
    assert.equal(valid.apiKey, "key");
    assert.equal(valid.entitySecret, TEST_SECRET);
  });

  it("constructs the production SDK client through the repository ESM tsx runtime without a live API call", () => {
    assert.doesNotThrow(
      () => new CircleDeveloperWalletsAdapter({
        apiKey: MOCK_API_KEY,
        entitySecret: TEST_SECRET,
      }),
    );
  });

  it("redacts secrets and formats errors cleanly", () => {
    const reconErr = new CircleReconciliationRequiredError("reconcile");
    assert.equal(redactSecretsAndFormatError(reconErr), reconErr);

    const timeoutErr = redactSecretsAndFormatError(new Error("ETIMEDOUT: Connection timed out"));
    assert.ok(timeoutErr instanceof CircleReconciliationRequiredError);

    const genericErr = redactSecretsAndFormatError(new Error("secret-key-123 failed"));
    assert.equal(genericErr.message, "Circle Developer SDK operation failed: UPSTREAM_ERROR");
  });

  const createMockRepo = (
    overrides?: Partial<ArcHostedAccountRepository>,
  ): {
    repo: ArcHostedAccountRepository;
    state: {
      claimed: boolean;
      completed: boolean;
      failed: boolean;
      lastError: string | null;
    };
  } => {
    const state = {
      claimed: false,
      completed: false,
      failed: false,
      lastError: null as string | null,
    };

    const repo: ArcHostedAccountRepository = {
      claimHostedAccount: async () => {
        throw new Error("claimHostedAccount is not used by this adapter test");
      },
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
    listClientGrants: async () => [],
    setClientPaymentCapability: async () => {
      throw new Error("not used in this test");
    },
      getPrivateWalletBinding: async () => null,
      ...overrides,
    };

    return { repo, state };
  };

  it("provisions a new tenant wallet when no existing set/wallet exists", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async (input) => ({
        data: {
          walletSet: {
            id: "ws-new-1",
            name: input.name,
            custodyType: "DEVELOPER",
          },
        },
      }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async (input) => ({
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
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
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

  it("returns existing wallet address when job is already completed and wallet is LIVE", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const { repo } = createMockRepo({
      claimProvisioningJob: async () => null,
      getHostedAccount: async () => ({
        authUserId: VALID_USER_ID,
        tenantId: VALID_TENANT_ID,
        accountStatus: "ACTIVE",
        consentVersion: "arc-hosted-autonomy-v1",
        consentTimestamp: "2026-07-29T00:00:00.000Z",
        walletAddress: "0x1111111111111111111111111111111111111111",
        walletStatus: "LIVE",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }),
    });

    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_USER_ID,
      repository: repo,
    });

    assert.deepEqual(res, {
      walletAddress: "0x1111111111111111111111111111111111111111",
      status: "LIVE",
    });
  });

  it("throws when claimProvisioningJob is null and no LIVE account exists", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const { repo } = createMockRepo({
      claimProvisioningJob: async () => null,
      getHostedAccount: async () => null,
    });

    await assert.rejects(
      adapter.provisionHostedUserWallet({
        authUserId: VALID_USER_ID,
        repository: repo,
      }),
      /Unable to claim provisioning job/,
    );
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
      listWalletSets: async (params) => {
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
      listWallets: async (params) => {
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
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
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

  it("detects malformed response envelope or malformed records during pagination and requires reconciliation", async () => {
    const mockSdkMalformedEnvelope: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: "invalid-string-envelope" }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapterEnvelope = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdkMalformedEnvelope,
    );

    await assert.rejects(
      adapterEnvelope.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError && err.message.includes("envelope"),
    );

    const mockSdkMalformedRecord: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({
        data: {
          walletSets: [{ id: "bad", name: "bad", custodyType: "INVALID_CUSTODY" }],
        },
      }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapterRecord = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdkMalformedRecord,
    );

    await assert.rejects(
      adapterRecord.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError && err.message.includes("malformed"),
    );
  });

  it("rejects provider pages above the bounded per-page record limit", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({
        data: {
          walletSets: Array.from({ length: 51 }, (_, index) => ({
            id: `oversized-${index}`,
            name: `oversized-${index}`,
            custodyType: "DEVELOPER",
          })),
        },
      }),
      createWalletSet: async () => ({}),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "INITIATED" } }),
      createContractExecutionTransaction: async () => ({
        data: { id: "tx-c1", state: "INITIATED" },
      }),
      getTransaction: async () => ({}),
    };
    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    await assert.rejects(
      adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError
        && err.message.includes("page size"),
    );
  });

  it("detects cursor loop during pagination and requires reconciliation", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({
        data: {
          walletSets: Array.from({ length: 50 }, () => ({
            id: "same-cursor-id",
            name: "ws-other",
            custodyType: "DEVELOPER",
          })),
        },
      }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    await assert.rejects(
      adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError && err.message.includes("loop"),
    );
  });

  it("detects duplicate matching wallet sets or wallets and requires reconciliation", async () => {
    const walletSetName = deriveWalletSetName(VALID_TENANT_ID);
    const mockSdkDuplicateSets: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({
        data: {
          walletSets: [
            { id: "ws-dup-1", name: walletSetName, custodyType: "DEVELOPER" },
            { id: "ws-dup-2", name: walletSetName, custodyType: "DEVELOPER" },
          ],
        },
      }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdkDuplicateSets,
    );

    await assert.rejects(
      adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError
        && err.message.includes("Multiple wallet sets found"),
    );

    const refId = deriveWalletRefId(VALID_TENANT_ID);
    const duplicateWalletSdk: CircleDeveloperSdkClient = {
      ...mockSdkDuplicateSets,
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      listWallets: async () => ({
        data: {
          wallets: [
            {
              id: "wallet-dup-1",
              walletSetId: "wallet-set-1",
              address: "0x1111111111111111111111111111111111111111",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId,
            },
            {
              id: "wallet-dup-2",
              walletSetId: "wallet-set-1",
              address: "0x2222222222222222222222222222222222222222",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId,
            },
          ],
        },
      }),
    };
    const duplicateWalletAdapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      duplicateWalletSdk,
    );

    await assert.rejects(
      duplicateWalletAdapter.ensureScaWalletForTenant(
        VALID_TENANT_ID,
        "wallet-set-1",
        PROVISIONING_KEY,
      ),
      (err: unknown) =>
        err instanceof CircleReconciliationRequiredError
        && err.message.includes("Multiple wallets found"),
    );
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
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
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
      (err: unknown) => err instanceof CircleReconciliationRequiredError,
    );

    assert.equal(createWalletSetCalled, true);
    assert.equal(state.failed, false, "Must NOT mark provisioning as permanently failed on ambiguous timeout");
  });

  it("reconciles existing wallet set / wallet if create throws non-timeout error but item exists in post-mutation read", async () => {
    const walletSetName = deriveWalletSetName(VALID_TENANT_ID);
    const refId = deriveWalletRefId(VALID_TENANT_ID);

    let createSetAttempts = 0;
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => {
        if (createSetAttempts > 0) {
          return {
            data: {
              walletSets: [{ id: "ws-reconciled-1", name: walletSetName, custodyType: "DEVELOPER" }],
            },
          };
        }
        return { data: { walletSets: [] } };
      },
      createWalletSet: async () => {
        createSetAttempts++;
        throw new Error("409 Conflict: Already exists");
      },
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({
        data: {
          wallets: [
            {
              id: "w-rec-1",
              walletSetId: "ws-reconciled-1",
              address: "0x1111111111111111111111111111111111111111",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId: refId,
            },
          ],
        },
      }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const ws = await adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY);
    assert.equal(ws.id, "ws-reconciled-1");
  });

  it("handles transfer, contract execution, balances, and status lookups correctly using canonical Arc USDC tokenAddress", async () => {
    const createdTxInputs: Array<
      Parameters<CircleDeveloperSdkClient["createTransaction"]>[0]
    > = [];
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({
        data: {
          tokenBalances: [
            {
              token: {
                symbol: "USDC",
                tokenAddress: ARC_HOSTED_USDC_TOKEN_ADDRESS,
              },
              amount: "100.0",
            },
          ],
        },
      }),
      createTransaction: async (input) => {
        createdTxInputs.push(input);
        return { data: { id: "tx-transfer-1", state: "INITIATED" } };
      },
      createContractExecutionTransaction: async () => ({
        data: { id: "tx-contract-1", state: "INITIATED" },
      }),
      getTransaction: async (input) => ({
        data: {
          transaction: {
            id: input.id,
            state: "COMPLETE",
            txHash: "0xhash123",
            walletId: "w-1",
          },
        },
      }),
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const balances = await adapter.getWalletBalances("w-1");
    assert.deepEqual(balances, [{ symbol: "USDC", amount: "100.0", address: ARC_HOSTED_USDC_TOKEN_ADDRESS }]);

    const tx = await adapter.createDeveloperTransfer({
      walletAddress: "0x1111111111111111111111111111111111111111",
      destinationAddress: "0x2222222222222222222222222222222222222222",
      amount: "10.0",
      idempotencyKey: PROVISIONING_KEY,
    });

    assert.deepEqual(tx, { transactionId: "tx-transfer-1", state: "INITIATED" });
    const createdTxInput = createdTxInputs[0];
    assert.ok(createdTxInput);
    assert.equal(createdTxInput.tokenAddress, ARC_HOSTED_USDC_TOKEN_ADDRESS);
    assert.equal(createdTxInput.blockchain, "ARC-TESTNET");
    assert.equal(createdTxInput.tokenId, undefined);

    const status = await adapter.getTransactionStatus("tx-transfer-1");
    assert.deepEqual(status, {
      transactionId: "tx-transfer-1",
      state: "COMPLETE",
      txHash: "0xhash123",
      walletId: "w-1",
    });
  });

  it("fails closed on wallet-set and wallet preflight read failures without creating resources", async () => {
    let createWalletSetCalls = 0;
    let createWalletCalls = 0;
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => {
        throw new Error("provider unavailable");
      },
      createWalletSet: async () => {
        createWalletSetCalls++;
        return {};
      },
      listWallets: async () => {
        throw new Error("provider unavailable");
      },
      createWallets: async () => {
        createWalletCalls++;
        return {};
      },
      getWalletTokenBalance: async () => ({}),
      createTransaction: async () => ({}),
      createContractExecutionTransaction: async () => ({}),
      getTransaction: async () => ({}),
    };
    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    await assert.rejects(
      adapter.ensureWalletSetForTenant(VALID_TENANT_ID, PROVISIONING_KEY),
      /Preflight listWalletSets failed/,
    );
    await assert.rejects(
      adapter.ensureScaWalletForTenant(
        VALID_TENANT_ID,
        "wallet-set-1",
        PROVISIONING_KEY,
      ),
      /Preflight listWallets failed/,
    );
    assert.equal(createWalletSetCalls, 0);
    assert.equal(createWalletCalls, 0);
  });

  it("marks a deterministic repository completion failure and exposes only a stable error", async () => {
    const walletSetName = deriveWalletSetName(VALID_TENANT_ID);
    const refId = deriveWalletRefId(VALID_TENANT_ID);
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({
        data: {
          walletSets: [
            { id: "wallet-set-1", name: walletSetName, custodyType: "DEVELOPER" },
          ],
        },
      }),
      createWalletSet: async () => ({}),
      listWallets: async () => ({
        data: {
          wallets: [
            {
              id: "wallet-1",
              walletSetId: "wallet-set-1",
              address: "0x1111111111111111111111111111111111111111",
              blockchain: "ARC-TESTNET",
              accountType: "SCA",
              custodyType: "DEVELOPER",
              refId,
            },
          ],
        },
      }),
      createWallets: async () => ({}),
      getWalletTokenBalance: async () => ({}),
      createTransaction: async () => ({}),
      createContractExecutionTransaction: async () => ({}),
      getTransaction: async () => ({}),
    };
    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );
    const { repo, state } = createMockRepo({
      completeProvisioning: async () => {
        throw new Error("private database detail");
      },
    });

    await assert.rejects(
      adapter.provisionHostedUserWallet({
        authUserId: VALID_USER_ID,
        repository: repo,
      }),
      /Circle Developer SDK operation failed: UPSTREAM_ERROR/,
    );
    assert.equal(state.failed, true);
    assert.equal(state.lastError, "PROVISIONING_FAILED");
  });

});
