import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CircleDeveloperWalletsAdapter,
  CircleDeveloperSdkClient,
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

  public shouldFailCreateWalletSet = false;
  public shouldTimeoutCreateWalletSet = false;
  public shouldFailCreateWallets = false;
  public createWalletsCallCount = 0;

  async createWalletSet(input: { name: string; idempotencyKey?: string }) {
    if (this.shouldTimeoutCreateWalletSet) {
      throw new Error("ETIMEDOUT: Connection timed out to Circle API");
    }
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

    const existing = this.wallets.find((w) => w.walletSetId === input.walletSetId && w.refId === input.refId);
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
    const filtered = this.wallets.filter(
      (w) => w.walletSetId === input.walletSetId && (!input.refId || w.refId === input.refId),
    );
    return { data: { wallets: filtered } };
  }

  async getWalletTokenBalance(input: { walletId: string }) {
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
}

class FakeArcHostedAccountRepository implements ArcHostedAccountRepository {
  public completedRecord: any = null;
  public failedRecord: any = null;

  async claimHostedAccount(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async getHostedAccount(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async resolveHostedAuthority(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async claimProvisioningJob(): Promise<any> {
    throw new Error("Not implemented in mock");
  }
  async completeProvisioning(input: any): Promise<void> {
    this.completedRecord = input;
  }
  async failProvisioning(input: any): Promise<void> {
    this.failedRecord = input;
  }
  async setAccountStatus(): Promise<void> {}
}

describe("CircleDeveloperWalletsAdapter & Configuration", () => {
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

  it("derives deterministic, irreversible wallet-set name and refId from tenant ID", () => {
    const wsName1 = deriveWalletSetName(VALID_UUID_1);
    const wsName2 = deriveWalletSetName(VALID_UUID_1);
    const wsNameDiff = deriveWalletSetName(VALID_UUID_2);

    assert.equal(wsName1, wsName2);
    assert.notEqual(wsName1, wsNameDiff);
    assert.ok(wsName1.startsWith("arc-ws-"));
    assert.ok(!wsName1.includes(VALID_UUID_1));

    const refId1 = deriveWalletRefId(VALID_UUID_1);
    assert.ok(refId1.startsWith("arc-ref-"));
    assert.ok(!refId1.includes(VALID_UUID_1));
  });

  it("provisions one user with one wallet set and one SCA wallet", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      tenantId: VALID_UUID_2,
      provisioningIdempotencyKey: VALID_UUID_3,
      fencingToken: VALID_UUID_3,
      repository: fakeRepo,
    });

    assert.equal(res.walletAddress, VALID_ADDRESS);
    assert.ok(fakeRepo.completedRecord);
    assert.equal(fakeRepo.completedRecord.circleWalletSetId, "ws-1");
    assert.equal(fakeRepo.completedRecord.circleWalletId, "w-1");
    assert.equal(fakeRepo.completedRecord.walletAddress, VALID_ADDRESS);

    const wallet = fakeSdk.wallets[0];
    assert.equal(wallet.blockchain, ARC_HOSTED_CHAIN);
    assert.equal(wallet.accountType, ARC_HOSTED_ACCOUNT_TYPE);
    assert.equal(wallet.custodyType, ARC_HOSTED_CUSTODY_TYPE);
  });

  it("prevents duplicate provisioning from creating a second wallet", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      tenantId: VALID_UUID_2,
      provisioningIdempotencyKey: VALID_UUID_3,
      fencingToken: VALID_UUID_3,
      repository: fakeRepo,
    });

    assert.equal(fakeSdk.wallets.length, 1);
    assert.equal(fakeSdk.createWalletsCallCount, 1);

    // Second provisioning attempt with same tenant
    await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      tenantId: VALID_UUID_2,
      provisioningIdempotencyKey: VALID_UUID_3,
      fencingToken: VALID_UUID_3,
      repository: fakeRepo,
    });

    assert.equal(fakeSdk.wallets.length, 1);
  });

  it("reconciles unknown outcomes during creation without duplicate wallet creation", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    // Pre-seed wallet in fake SDK to simulate previous unknown/timed-out attempt
    const ws = await fakeSdk.createWalletSet({ name: deriveWalletSetName(VALID_UUID_2) });
    fakeSdk.wallets.push({
      id: "w-reconciled",
      walletSetId: ws.data!.walletSet!.id,
      address: VALID_ADDRESS,
      blockchain: ARC_HOSTED_CHAIN,
      accountType: ARC_HOSTED_ACCOUNT_TYPE,
      custodyType: ARC_HOSTED_CUSTODY_TYPE,
      refId: deriveWalletRefId(VALID_UUID_2),
    });

    const res = await adapter.provisionHostedUserWallet({
      authUserId: VALID_UUID_1,
      tenantId: VALID_UUID_2,
      provisioningIdempotencyKey: VALID_UUID_3,
      fencingToken: VALID_UUID_3,
      repository: fakeRepo,
    });

    assert.equal(res.walletId, "w-reconciled");
    assert.equal(fakeRepo.completedRecord.circleWalletId, "w-reconciled");
  });

  it("records provisioning failure in repository when fatal SDK error occurs", async () => {
    const fakeSdk = new FakeCircleDeveloperSdkClient();
    fakeSdk.shouldFailCreateWallets = true;
    const fakeRepo = new FakeArcHostedAccountRepository();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);

    await assert.rejects(
      async () => {
        await adapter.provisionHostedUserWallet({
          authUserId: VALID_UUID_1,
          tenantId: VALID_UUID_2,
          provisioningIdempotencyKey: VALID_UUID_3,
          fencingToken: VALID_UUID_3,
          repository: fakeRepo,
        });
      },
      (err: any) => err.message.includes("Circle Developer SDK operation failed"),
    );

    assert.ok(fakeRepo.failedRecord);
    assert.equal(fakeRepo.failedRecord.errorCode, "PROVISIONING_FAILED");
  });
});
