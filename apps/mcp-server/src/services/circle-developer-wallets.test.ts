import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CircleDeveloperWalletsAdapter,
  CircleDeveloperSdkClient,
  CircleReconciliationRequiredError,
  deriveWalletRefId,
  deriveWalletSetName,
  redactSecretsAndFormatError,
  validateCircleDeveloperWalletsConfig,
} from "./circle-developer-wallets.js";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";
import {
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
} from "@agentpay-ai/shared-arc";

const FAKE_CONFIG = {
  apiKey: ["mock", "key", "test"].join("_"),
  entitySecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const VALID_ADDRESS = "0x1111111111222222222233333333334444444444";
const VALID_UUID_1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const VALID_UUID_2 = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const VALID_UUID_3 = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

class FakeCircleDeveloperSdkClient implements CircleDeveloperSdkClient {
  public walletSets: Array<{ id: string; name: string; custodyType: string }> = [];
  public wallets: Array<{
    id: string;
    walletSetId: string;
    address: string;
    blockchain: string;
    accountType: string;
    custodyType: string;
    refId?: string;
  }> = [];
  public transactions: Array<{ id: string; state: string; txHash?: string }> = [];

  public shouldFailListWalletSets = false;
  public shouldFailListWallets = false;
  public shouldFailCreateWalletSet = false;
  public shouldFailCreateWallets = false;
  public createWalletsCallCount = 0;

  async createWalletSet(input: { name: string; idempotencyKey?: string }) {
    if (this.shouldFailCreateWalletSet) {
      throw new Error(`Circle API Key ${FAKE_CONFIG.apiKey} invalid or unauthorized`);
    }
    const existing = this.walletSets.find((ws) => ws.name === input.name);
    if (existing) return { data: { walletSet: existing } };

    const newSet = {
      id: `ws-${this.walletSets.length + 1}`,
      name: input.name,
      custodyType: ARC_HOSTED_CUSTODY_TYPE,
    };
    this.walletSets.push(newSet);
    return { data: { walletSet: newSet } };
  }

  async listWalletSets(input?: { name?: string }) {
    if (this.shouldFailListWalletSets) {
      throw new Error("Network timeout during listWalletSets");
    }
    if (input?.name) {
      const filtered = this.walletSets.filter((ws) => ws.name === input.name);
      return { data: { walletSets: filtered } };
    }
    return { data: { walletSets: this.walletSets } };
  }

  async createWallets(input: {
    blockchains: string[];
    count: number;
    walletSetId: string;
    accountType: string;
    refId?: string;
    idempotencyKey?: string;
  }) {
    this.createWalletsCallCount++;
    if (this.shouldFailCreateWallets) {
      throw new Error("Circle SDK server error during wallet creation");
    }

    const existing = this.wallets.find(
      (w) => w.walletSetId === input.walletSetId && w.refId === input.refId && w.custodyType === ARC_HOSTED_CUSTODY_TYPE,
    );
    if (existing) return { data: { wallets: [existing] } };

    const newWallet = {
      id: `w-${this.wallets.length + 1}`,
      walletSetId: input.walletSetId,
      address: VALID_ADDRESS,
      blockchain: input.blockchains[0] ?? ARC_HOSTED_CHAIN,
      accountType: input.accountType,
      custodyType: ARC_HOSTED_CUSTODY_TYPE,
      refId: input.refId,
    };
    this.wallets.push(newWallet);
    return { data: { wallets: [newWallet] } };
  }

  async listWallets(input: { walletSetId: string; refId?: string }) {
    if (this.shouldFailListWallets) {
      throw new Error("Network timeout during listWallets");
    }
    const filtered = this.wallets.filter(
      (w) => w.walletSetId === input.walletSetId && (!input.refId || w.refId === input.refId),
    );
    return { data: { wallets: filtered } };
  }

  async getWalletTokenBalance(input: { walletId: string }) {
    if (input.walletId === "fail-id") {
      throw new Error("Wallet balance read failed");
    }
    return {
      data: {
        tokenBalances: [
          {
            token: { symbol: "USDC", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
            amount: "1000.00",
          },
        ],
      },
    };
  }

  async createTransaction(input: any) {
    const txId = `tx-${this.transactions.length + 1}`;
    const tx = { id: txId, state: "PENDING" };
    this.transactions.push(tx);
    return { data: tx };
  }

  async createContractExecutionTransaction(input: any) {
    const txId = `tx-exec-${this.transactions.length + 1}`;
    const tx = { id: txId, state: "PENDING" };
    this.transactions.push(tx);
    return { data: tx };
  }

  async getTransaction(input: { id: string }) {
    const found = this.transactions.find((t) => t.id === input.id) ?? {
      id: input.id,
      state: "COMPLETE",
      txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };
    return { data: { transaction: found } };
  }
}

class FakeArcHostedAccountRepository implements ArcHostedAccountRepository {
  public completedRecord: any = null;
  public failedRecord: any = null;
  public claimedJobsCount = 0;

  async claimHostedAccount(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async getHostedAccount(authUserId: string): Promise<any> {
    if (this.completedRecord && this.completedRecord.authUserId === authUserId) {
      return {
        authUserId,
        tenantId: VALID_UUID_2,
        walletAddress: this.completedRecord.walletAddress,
        walletStatus: "LIVE",
      };
    }
    return null;
  }
  async resolveHostedAuthority(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async claimProvisioningJob(authUserId: string): Promise<any> {
    this.claimedJobsCount++;
    if (this.completedRecord && this.completedRecord.authUserId === authUserId) {
      return null;
    }
    return {
      authUserId,
      tenantId: VALID_UUID_2,
      provisioningIdempotencyKey: VALID_UUID_3,
      fencingToken: VALID_UUID_3,
      provisioningState: "PROVISIONING",
    };
  }
  async completeProvisioning(input: any): Promise<void> {
    this.completedRecord = input;
  }
  async failProvisioning(input: any): Promise<void> {
    this.failedRecord = input;
  }
  async setAccountStatus(): Promise<void> {}
  async getPrivateWalletBinding(authUserId: string): Promise<any> {
    if (this.completedRecord && this.completedRecord.authUserId === authUserId) {
      return {
        authUserId,
        tenantId: VALID_UUID_2,
        circleWalletSetId: this.completedRecord.circleWalletSetId,
        circleWalletId: this.completedRecord.circleWalletId,
        walletAddress: this.completedRecord.walletAddress,
        provisioningState: "LIVE",
      };
    }
    return null;
  }
}

describe("CircleDeveloperWalletsAdapter", () => {
  it("initializes production adapter instance with config", () => {
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG);
    assert.ok(adapter);
  });

  it("validates Circle Developer-Controlled config cleanly without leaking secrets", () => {
    assert.throws(
      () => validateCircleDeveloperWalletsConfig({ apiKey: "", entitySecret: FAKE_CONFIG.entitySecret }),
      (err: any) => err.message.includes("Invalid or missing Circle Developer-Controlled API key"),
    );

    assert.throws(
      () => validateCircleDeveloperWalletsConfig({ apiKey: FAKE_CONFIG.apiKey, entitySecret: "short" }),
      (err: any) => err.message.includes("Invalid or missing Circle Developer-Controlled entity secret"),
    );

    const valid = validateCircleDeveloperWalletsConfig(FAKE_CONFIG);
    assert.equal(valid.apiKey, FAKE_CONFIG.apiKey);
    assert.equal(valid.entitySecret, FAKE_CONFIG.entitySecret);
  });

  it("redacts API keys and entity secrets from error messages", () => {
    const rawError = new Error(`Failed to call Circle API with key ${FAKE_CONFIG.apiKey} and secret ${FAKE_CONFIG.entitySecret}`);
    const redacted = redactSecretsAndFormatError(rawError, FAKE_CONFIG);
    assert.ok(!redacted.message.includes(FAKE_CONFIG.apiKey));
    assert.ok(!redacted.message.includes(FAKE_CONFIG.entitySecret));
    assert.ok(redacted.message.includes("[REDACTED]"));
  });

  it("provisions one user via claimProvisioningJob and completeProvisioning", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      repository: fakeRepo,
    });

    assert.equal(res.walletAddress, VALID_ADDRESS);
    assert.equal(res.status, "LIVE");
    assert.ok(fakeRepo.completedRecord);
    assert.equal(fakeRepo.completedRecord.circleWalletSetId, "ws-1");
    assert.equal(fakeRepo.completedRecord.circleWalletId, "w-1");
    assert.equal(fakeRepo.completedRecord.walletAddress, VALID_ADDRESS);
  });

  it("prevents duplicate provisioning from creating a second wallet", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      repository: fakeRepo,
    });

    assert.equal(fakeSdk.wallets.length, 1);

    const secondRes = await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      repository: fakeRepo,
    });

    assert.equal(secondRes.walletAddress, VALID_ADDRESS);
    assert.equal(fakeSdk.wallets.length, 1);
  });

  it("halts mutation when preflight list fails to prevent blind creation", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    fakeSdk.shouldFailListWalletSets = true;
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    await assert.rejects(
      async () => {
        await adapter.provisionHostedUserWallet({
          authUserId: VALID_UUID_1,
          repository: fakeRepo,
        });
      },
      (err: any) => err instanceof CircleReconciliationRequiredError && err.message.includes("Preflight listWalletSets failed"),
    );

    assert.equal(fakeSdk.walletSets.length, 0);
  });

  it("rejects malformed or foreign custodyType binding", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    // Pre-seed an ENDUSER custody wallet with matching refId
    const ws = await fakeSdk.createWalletSet({ name: deriveWalletSetName(VALID_UUID_2) });
    fakeSdk.wallets.push({
      id: "w-enduser",
      walletSetId: ws.data!.walletSet!.id,
      address: VALID_ADDRESS,
      blockchain: ARC_HOSTED_CHAIN,
      accountType: ARC_HOSTED_ACCOUNT_TYPE,
      custodyType: "ENDUSER", // Foreign/invalid custody!
      refId: deriveWalletRefId(VALID_UUID_2),
    });

    // Provisioning should ignore the ENDUSER wallet and create a proper DEVELOPER custody wallet
    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      repository: fakeRepo,
    });

    assert.equal(res.status, "LIVE");
    const createdWallet = fakeSdk.wallets.find((w) => w.custodyType === ARC_HOSTED_CUSTODY_TYPE);
    assert.ok(createdWallet);
  });

  it("executes developer transfers, contract calls, status lookups, and App Kit creation", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    const tx = await adapter.createDeveloperTransfer({
      walletId: "w-1",
      destinationAddress: VALID_ADDRESS,
      amount: "50.00",
      idempotencyKey: VALID_UUID_3,
    });
    assert.equal(tx.transactionId, "tx-1");
    assert.equal(tx.state, "PENDING");

    const exec = await adapter.executeDeveloperContract({
      walletId: "w-1",
      contractAddress: VALID_ADDRESS,
      abiFunctionSignature: "transfer(address,uint256)",
      args: [VALID_ADDRESS, "100"],
      idempotencyKey: VALID_UUID_3,
    });
    assert.equal(exec.transactionId, "tx-exec-2");

    const status = await adapter.getTransactionStatus("tx-1");
    assert.equal(status.state, "PENDING");

    const appKitAdapter = adapter.createAppKitAdapter({
      authUserId: VALID_UUID_1,
      tenantId: VALID_UUID_2,
      walletAddress: VALID_ADDRESS,
      accountStatus: "ACTIVE",
      authEpoch: 1,
    });
    assert.equal(appKitAdapter.isAppKitAdapter, true);
  });
});
