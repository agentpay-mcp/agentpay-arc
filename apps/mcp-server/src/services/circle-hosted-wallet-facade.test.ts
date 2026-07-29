import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CircleHostedWalletFacade,
  ARC_HOSTED_TOOL_CAPABILITY_MATRIX,
} from "./circle-hosted-wallet-facade.js";
import { CircleDeveloperWalletsAdapter, CircleDeveloperSdkClient } from "./circle-developer-wallets.js";
import { ArcHostedAuthority } from "@agentpay-ai/shared-arc";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";

const FAKE_CONFIG = {
  apiKey: ["mock", "key", "test"].join("_"),
  entitySecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const VALID_ADDRESS = "0x1111111111222222222233333333334444444444";
const OTHER_ADDRESS = "0x9999999999888888888877777777776666666666";
const VALID_UUID_1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const VALID_UUID_2 = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const VALID_UUID_3 = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

class FakeSdkForFacade implements CircleDeveloperSdkClient {
  async createWalletSet() {
    return { data: { walletSet: { id: "ws-1", name: "test", custodyType: "DEVELOPER" } } };
  }
  async listWalletSets() {
    return { data: { walletSets: [] } };
  }
  async createWallets() {
    return {
      data: {
        wallets: [
          {
            id: "w-1",
            walletSetId: "ws-1",
            address: VALID_ADDRESS,
            blockchain: "ARC-TESTNET",
            accountType: "SCA",
            custodyType: "DEVELOPER",
          },
        ],
      },
    };
  }
  async listWallets() {
    return { data: { wallets: [] } };
  }
  async getWalletTokenBalance() {
    return {
      data: {
        tokenBalances: [
          {
            token: { symbol: "USDC", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
            amount: "250.00",
          },
        ],
      },
    };
  }
  async createTransaction() {
    return { data: { id: "tx-facade-1", state: "PENDING" } };
  }
  async createContractExecutionTransaction() {
    return { data: { id: "tx-exec-facade-1", state: "PENDING" } };
  }
  async getTransaction() {
    return { data: { transaction: { id: "tx-facade-1", state: "COMPLETE", txHash: "0xhash" } } };
  }
}

class FakeRepoForFacade implements ArcHostedAccountRepository {
  async claimHostedAccount(): Promise<any> { throw new Error("Not implemented"); }
  async getHostedAccount(): Promise<any> { throw new Error("Not implemented"); }
  async resolveHostedAuthority(): Promise<any> { throw new Error("Not implemented"); }
  async claimProvisioningJob(): Promise<any> { throw new Error("Not implemented"); }
  async completeProvisioning(): Promise<void> {}
  async failProvisioning(): Promise<void> {}
  async setAccountStatus(): Promise<void> {}
  async getPrivateWalletBinding(authUserId: string): Promise<any> {
    if (authUserId === VALID_UUID_1) {
      return {
        authUserId: VALID_UUID_1,
        tenantId: VALID_UUID_2,
        circleWalletSetId: "ws-1",
        circleWalletId: "w-1",
        walletAddress: VALID_ADDRESS,
        provisioningState: "LIVE",
      };
    }
    return null;
  }
}

const VALID_AUTHORITY: ArcHostedAuthority = {
  authUserId: VALID_UUID_1,
  tenantId: VALID_UUID_2,
  walletAddress: VALID_ADDRESS,
  accountStatus: "ACTIVE",
  authEpoch: 1,
};

describe("CircleHostedWalletFacade", () => {
  it("returns wallet info for valid active authority", async () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const info = await facade.getWallet(VALID_AUTHORITY);
    assert.equal(info.walletAddress, VALID_ADDRESS);
    assert.equal(info.chain, "ARC-TESTNET");
    assert.equal(info.accountType, "SCA");
    assert.equal(info.custodyType, "DEVELOPER");
    assert.equal(info.status, "LIVE");
  });

  it("rejects authority with non-ACTIVE account status", async () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const pausedAuthority: ArcHostedAuthority = {
      ...VALID_AUTHORITY,
      accountStatus: "PAUSED",
    };

    await assert.rejects(
      async () => facade.getWallet(pausedAuthority),
      (err: any) => err.message.includes("Hosted authority account status must be ACTIVE"),
    );
  });

  it("fetches balances resolving private binding by authority", async () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const balances = await facade.getBalances(VALID_AUTHORITY);
    assert.equal(balances.length, 1);
    assert.equal(balances[0].symbol, "USDC");
    assert.equal(balances[0].amount, "250.00");
  });

  it("rejects cross-tenant or mismatched authority inputs in facade methods", async () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const foreignTenantAuthority: ArcHostedAuthority = {
      ...VALID_AUTHORITY,
      tenantId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44", // Foreign tenant!
    };

    await assert.rejects(
      async () => facade.getBalances(foreignTenantAuthority),
      (err: any) => err.message.includes("Cross-tenant or missing private wallet binding"),
    );
  });

  it("executes transfers and contract execution through private binding", async () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const tx = await facade.transferTokens(VALID_AUTHORITY, {
      toAddress: OTHER_ADDRESS,
      amount: "10.00",
      idempotencyKey: VALID_UUID_3,
    });
    assert.equal(tx.transactionId, "tx-facade-1");

    const exec = await facade.executeContract(VALID_AUTHORITY, {
      contractAddress: OTHER_ADDRESS,
      abiFunctionSignature: "approve(address,uint256)",
      args: [OTHER_ADDRESS, "100"],
      idempotencyKey: VALID_UUID_3,
    });
    assert.equal(exec.transactionId, "tx-exec-facade-1");

    const status = await facade.getTransactionStatus(VALID_AUTHORITY, "tx-facade-1");
    assert.equal(status.state, "COMPLETE");

    const appKitAdapter = facade.createAppKitAdapter(VALID_AUTHORITY);
    assert.ok(appKitAdapter);
  });

  it("provides a documented, complete tool capability matrix", () => {
    const fakeSdk = new FakeSdkForFacade();
    const fakeRepo = new FakeRepoForFacade();
    const adapter = new CircleDeveloperWalletsAdapter(FAKE_CONFIG, fakeSdk);
    const facade = new CircleHostedWalletFacade(adapter, fakeRepo);

    const matrix = facade.getCapabilityMatrix();
    assert.ok(Array.isArray(matrix));
    assert.ok(matrix.length >= 10);

    const getBalanceCap = matrix.find((m) => m.toolName === "get_balance");
    assert.ok(getBalanceCap);
    assert.equal(getBalanceCap.hostedStatus, "SUPPORTED");

    const circleAgentWalletCap = matrix.find((m) => m.toolName === "circle_agent_wallet");
    assert.ok(circleAgentWalletCap);
    assert.equal(circleAgentWalletCap.hostedStatus, "DELEGATED_LOCAL_ONLY");
  });
});
