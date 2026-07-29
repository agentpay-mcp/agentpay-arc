import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircleHostedWalletFacade, ARC_HOSTED_TOOL_CAPABILITY_MATRIX } from "./circle-hosted-wallet-facade.ts";
import { CircleDeveloperWalletsAdapter, CircleDeveloperSdkClient, ARC_HOSTED_USDC_TOKEN_ADDRESS } from "./circle-developer-wallets.ts";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.ts";
import { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

const TEST_SECRET = ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");

const VALID_USER_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_USER_ID = "33333333-3333-4333-8333-333333333333";
const VALID_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ATTACKER_TENANT_ID = "44444444-4444-4444-8444-444444444444";

describe("CircleHostedWalletFacade", () => {
  const validAuthority: ArcHostedAuthority = {
    authUserId: VALID_USER_ID,
    tenantId: VALID_TENANT_ID,
    walletAddress: "0x1111111111111111111111111111111111111111",
    accountStatus: "ACTIVE",
    authEpoch: 1,
  };

  const createTestContext = (customSdk?: Record<string, any>) => {
    const mockSdk = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      ...customSdk,
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk as unknown as CircleDeveloperSdkClient,
    );

    const mockRepo: ArcHostedAccountRepository = {
      claimHostedAccount: async () => null as any,
      resolveHostedAuthority: async () => null,
      setAccountStatus: async () => {},
      claimProvisioningJob: async () => null,
      completeProvisioning: async () => {},
      failProvisioning: async () => {},
      getHostedAccount: async () => null,
      getPrivateWalletBinding: async (authUserId: string) => {
        if (authUserId === VALID_USER_ID) {
          return {
            authUserId: VALID_USER_ID,
            tenantId: VALID_TENANT_ID,
            walletAddress: "0x1111111111111111111111111111111111111111",
            circleWalletId: "w-valid-1",
            circleWalletSetId: "ws-valid-1",
            provisioningState: "LIVE",
          };
        }
        if (authUserId === PENDING_USER_ID) {
          return {
            authUserId: PENDING_USER_ID,
            tenantId: VALID_TENANT_ID,
            walletAddress: "0x1111111111111111111111111111111111111111",
            circleWalletId: "w-pending-1",
            circleWalletSetId: "ws-valid-1",
            provisioningState: "PROVISIONING",
          };
        }
        return null;
      },
    };

    const facade = new CircleHostedWalletFacade(adapter, mockRepo);
    return { facade, mockSdk };
  };

  it("returns hosted wallet info for valid authority", async () => {
    const { facade } = createTestContext();
    const info = await facade.getWallet(validAuthority);
    assert.deepEqual(info, {
      walletAddress: "0x1111111111111111111111111111111111111111",
      chain: "ARC-TESTNET",
      accountType: "SCA",
      custodyType: "DEVELOPER",
      status: "LIVE",
    });
  });

  it("rejects non-LIVE wallet bindings", async () => {
    const { facade } = createTestContext();
    const pendingAuthority: ArcHostedAuthority = {
      authUserId: PENDING_USER_ID,
      tenantId: VALID_TENANT_ID,
      walletAddress: "0x1111111111111111111111111111111111111111",
      accountStatus: "ACTIVE",
      authEpoch: 1,
    };

    await assert.rejects(
      facade.getWallet(pendingAuthority),
      /Hosted wallet is not in LIVE provisioning state/,
    );
  });

  it("rejects cross-tenant wallet binding resolution", async () => {
    const { facade } = createTestContext();
    const maliciousAuthority: ArcHostedAuthority = {
      authUserId: VALID_USER_ID,
      tenantId: ATTACKER_TENANT_ID,
      walletAddress: "0x1111111111111111111111111111111111111111",
      accountStatus: "ACTIVE",
      authEpoch: 1,
    };

    await assert.rejects(
      facade.getWallet(maliciousAuthority),
      /Cross-tenant or missing private wallet binding/,
    );
  });

  it("fetches balances for tenant-bound wallet", async () => {
    let queriedId = "";
    const { facade } = createTestContext({
      getWalletTokenBalance: async (input: any) => {
        queriedId = input.id;
        return {
          data: {
            tokenBalances: [
              { token: { symbol: "USDC", address: ARC_HOSTED_USDC_TOKEN_ADDRESS }, amount: "250.00" },
            ],
          },
        };
      },
    });

    const balances = await facade.getBalances(validAuthority);
    assert.equal(queriedId, "w-valid-1");
    assert.deepEqual(balances, [
      { symbol: "USDC", amount: "250.00", address: ARC_HOSTED_USDC_TOKEN_ADDRESS },
    ]);
  });

  it("transfers tokens resolving private wallet ID and default Arc USDC token ID", async () => {
    let txInput: any = null;
    const { facade } = createTestContext({
      createTransaction: async (input: any) => {
        txInput = input;
        return { data: { id: "tx-facade-1", state: "PENDING" } };
      },
    });

    const res = await facade.transferTokens(validAuthority, {
      toAddress: "0x2222222222222222222222222222222222222222",
      amount: "10.0",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    assert.deepEqual(res, { transactionId: "tx-facade-1", state: "PENDING" });
    assert.deepEqual(txInput.walletId, "w-valid-1");
    assert.deepEqual(txInput.destinationAddress, "0x2222222222222222222222222222222222222222");
    assert.deepEqual(txInput.amount, ["10.0"]);
    assert.deepEqual(txInput.tokenId, ARC_HOSTED_USDC_TOKEN_ADDRESS);
  });

  it("executes contract functions resolving private wallet ID", async () => {
    let contractInput: any = null;
    const { facade } = createTestContext({
      createContractExecutionTransaction: async (input: any) => {
        contractInput = input;
        return { data: { id: "tx-contract-1", state: "PENDING" } };
      },
    });

    const res = await facade.executeContract(validAuthority, {
      contractAddress: "0x3333333333333333333333333333333333333333",
      abiFunctionSignature: "transfer(address,uint256)",
      args: ["0x2222222222222222222222222222222222222222", "100"],
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    assert.deepEqual(res, { transactionId: "tx-contract-1", state: "PENDING" });
    assert.equal(contractInput.walletId, "w-valid-1");
    assert.equal(contractInput.contractAddress, "0x3333333333333333333333333333333333333333");
  });

  it("gets transaction status for caller wallet transaction", async () => {
    const { facade } = createTestContext({
      getTransaction: async () => ({
        data: {
          transaction: {
            id: "tx-my-1",
            state: "COMPLETE",
            txHash: "0xhash999",
            walletId: "w-valid-1",
          },
        },
      }),
    });

    const status = await facade.getTransactionStatus(validAuthority, "tx-my-1");
    assert.deepEqual(status, {
      transactionId: "tx-my-1",
      state: "COMPLETE",
      txHash: "0xhash999",
    });
  });

  it("rejects cross-tenant transaction status lookup", async () => {
    const { facade } = createTestContext({
      getTransaction: async () => ({
        data: {
          transaction: {
            id: "tx-foreign-1",
            state: "COMPLETE",
            txHash: "0xhash888",
            walletId: "w-other-tenant-wallet",
          },
        },
      }),
    });

    await assert.rejects(
      facade.getTransactionStatus(validAuthority, "tx-foreign-1"),
      /Access denied: transaction does not belong to caller tenant wallet/,
    );
  });

  it("rejects transaction status lookup when transaction response lacks walletId", async () => {
    const { facade } = createTestContext({
      getTransaction: async () => ({
        data: {
          transaction: {
            id: "tx-no-wallet-id",
            state: "COMPLETE",
            txHash: "0xhash777",
          },
        },
      }),
    });

    await assert.rejects(
      facade.getTransactionStatus(validAuthority, "tx-no-wallet-id"),
      /Access denied: transaction does not belong to caller tenant wallet/,
    );
  });

  it("creates tenant-bound ArcAppKitService adapter instance", async () => {
    const { facade } = createTestContext();
    const appKitService = await facade.createAppKitAdapter(validAuthority);
    assert.equal(typeof appKitService.getUnifiedBalances, "function");

    await assert.rejects(
      appKitService.getUnifiedBalances("0x9999999999999999999999999999999999999999", false),
      /Access denied: address does not match tenant-bound wallet address/,
    );
  });

  it("rejects createAppKitAdapter for malicious foreign tenant authority", async () => {
    const { facade } = createTestContext();
    const maliciousAuthority: ArcHostedAuthority = {
      authUserId: VALID_USER_ID,
      tenantId: ATTACKER_TENANT_ID,
      walletAddress: "0x1111111111111111111111111111111111111111",
      accountStatus: "ACTIVE",
      authEpoch: 1,
    };

    await assert.rejects(
      facade.createAppKitAdapter(maliciousAuthority),
      /Cross-tenant or missing private wallet binding/,
    );
  });

  it("returns capability matrix matching real test-backed capabilities", () => {
    const { facade } = createTestContext();
    const matrix = facade.getCapabilityMatrix();
    assert.deepEqual(matrix, ARC_HOSTED_TOOL_CAPABILITY_MATRIX);

    const supportedTools = matrix.filter((m) => m.hostedStatus === "SUPPORTED").map((m) => m.toolName);
    assert.deepEqual(supportedTools, ["get_balance", "execute_payment", "wallet_setup"]);
  });
});
