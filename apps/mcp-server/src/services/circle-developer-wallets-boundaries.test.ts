import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CircleDeveloperSdkClient,
  CircleDeveloperWalletsAdapter,
} from "./circle-developer-wallets.js";

const TEST_SECRET = [
  "0123456789abcdef0123456789abcdef",
  "0123456789abcdef0123456789abcdef",
].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");
const PROVISIONING_KEY = "33333333-3333-4333-8333-333333333333";

describe("CircleDeveloperWalletsAdapter response boundaries", () => {
  it("maps malformed read and mutation responses to stable errors with no provider detail", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({}),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({}),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: "not-an-array" } }),
      createTransaction: async () => ({ data: { upstreamSecret: "do-not-reflect" } }),
      createContractExecutionTransaction: async () => ({
        data: { upstreamSecret: "do-not-reflect" },
      }),
      getTransaction: async () => ({ data: { transaction: null } }),
    };
    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    await assert.rejects(
      adapter.getWalletBalances("wallet-1"),
      /Circle Developer SDK operation failed: UPSTREAM_ERROR/,
    );
    await assert.rejects(
      adapter.createDeveloperTransfer({
        walletAddress: "0x1111111111111111111111111111111111111111",
        destinationAddress: "0x2222222222222222222222222222222222222222",
        amount: "1",
        idempotencyKey: PROVISIONING_KEY,
      }),
      /Circle Developer SDK operation failed: UPSTREAM_ERROR/,
    );
    await assert.rejects(
      adapter.executeDeveloperContract({
        walletId: "wallet-1",
        contractAddress: "0x3333333333333333333333333333333333333333",
        abiFunctionSignature: "transfer(address,uint256)",
        args: [],
        idempotencyKey: PROVISIONING_KEY,
      }),
      /Circle Developer SDK operation failed: UPSTREAM_ERROR/,
    );
    await assert.rejects(
      adapter.getTransactionStatus("transaction-1"),
      /Circle Developer SDK operation failed: UPSTREAM_ERROR/,
    );
  });

  it("uses stable fallbacks when optional balance and transaction fields are absent", async () => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({}),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({}),
      getWalletTokenBalance: async () => ({
        data: { tokenBalances: [{ token: {}, amount: "5" }] },
      }),
      createTransaction: async () => ({}),
      createContractExecutionTransaction: async () => ({}),
      getTransaction: async () => ({
        data: {
          transaction: {
            id: "transaction-1",
            state: "COMPLETE",
          },
        },
      }),
    };
    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    assert.deepEqual(await adapter.getWalletBalances("wallet-1"), [
      { symbol: "USDC", amount: "5", address: undefined },
    ]);
    assert.deepEqual(await adapter.getTransactionStatus("transaction-1"), {
      transactionId: "transaction-1",
      state: "COMPLETE",
      txHash: undefined,
      walletId: undefined,
    });
  });
});
