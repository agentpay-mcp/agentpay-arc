import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CircleHostedWalletFacade,
  ARC_HOSTED_TOOL_CAPABILITY_MATRIX,
  ALL_ARC_MCP_TOOL_NAMES,
} from "./circle-hosted-wallet-facade.js";
import {
  CircleDeveloperWalletsAdapter,
  CircleDeveloperSdkClient,
  ARC_HOSTED_USDC_TOKEN_ADDRESS,
} from "./circle-developer-wallets.js";
import { ArcHostedAccountRepository } from "./arc-hosted-accounts.js";
import type {
  ArcAppKitService,
  ArcBridgeQuoteInput,
  ArcSwapQuoteInput,
} from "./arc-app-kit.js";
import { ArcHostedAuthority } from "@agentpay-ai/shared-arc";

const TEST_SECRET = ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"].join("");
const MOCK_API_KEY = ["mock", "api", "key"].join("_");

const VALID_USER_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_USER_ID = "33333333-3333-4333-8333-333333333333";
const VALID_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ATTACKER_TENANT_ID = "44444444-4444-4444-8444-444444444444";

const EXPECTED_LOCAL_ARC_TOOLS = [
  "setup_agent_wallet",
  "get_agent_budget",
  "fund_agent_wallet",
  "withdraw_agent_budget",
  "send_usdc",
  "create_payment_request",
  "pay_invoice",
  "batch_payout",
  "list_agent_activity",
  "get_payment_receipt",
  "search_paid_services",
  "inspect_paid_service",
  "pay_paid_service",
  "get_unified_balance",
  "fund_from_any_chain",
  "bridge_usdc",
  "swap_tokens",
  "swap_and_pay",
  "register_agent_identity",
  "get_agent_identity",
  "give_agent_feedback",
  "request_agent_validation",
  "respond_agent_validation",
  "get_agent_trust",
  "create_agent_job",
  "set_agent_job_budget",
  "fund_agent_job",
  "submit_agent_deliverable",
  "complete_agent_job",
  "reject_agent_job",
  "get_agent_job",
] as const;

describe("CircleHostedWalletFacade", () => {
  const validAuthority: ArcHostedAuthority = {
    authUserId: VALID_USER_ID,
    tenantId: VALID_TENANT_ID,
    walletAddress: "0x1111111111111111111111111111111111111111",
    accountStatus: "ACTIVE",
    authEpoch: 1,
    capabilities: ["wallet:read", "payment:send"],
  };

  const createTestContext = (
    customSdk?: Partial<CircleDeveloperSdkClient>,
    appKitService?: ArcAppKitService,
  ) => {
    const mockSdk: CircleDeveloperSdkClient = {
      listWalletSets: async () => ({ data: { walletSets: [] } }),
      createWalletSet: async () => ({ data: {} }),
      listWallets: async () => ({ data: { wallets: [] } }),
      createWallets: async () => ({ data: { wallets: [] } }),
      getWalletTokenBalance: async () => ({ data: { tokenBalances: [] } }),
      createTransaction: async () => ({ data: { id: "tx-1", state: "PENDING" } }),
      createContractExecutionTransaction: async () => ({ data: { id: "tx-c1", state: "PENDING" } }),
      getTransaction: async () => ({ data: { transaction: { id: "tx-1", state: "COMPLETE" } } }),
      ...customSdk,
    };

    const adapter = new CircleDeveloperWalletsAdapter(
      { apiKey: MOCK_API_KEY, entitySecret: TEST_SECRET },
      mockSdk,
    );

    const mockRepo: ArcHostedAccountRepository = {
      claimHostedAccount: async () => {
        throw new Error("claimHostedAccount is not used by this facade test");
      },
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

    const facade = new CircleHostedWalletFacade(
      adapter,
      mockRepo,
      appKitService ? () => appKitService : undefined,
    );
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
      capabilities: ["wallet:read", "payment:send"],
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
      capabilities: ["wallet:read", "payment:send"],
    };

    await assert.rejects(
      facade.getWallet(maliciousAuthority),
      /Cross-tenant or missing private wallet binding/,
    );
  });

  it("fetches balances for tenant-bound wallet", async () => {
    let queriedId = "";
    const { facade } = createTestContext({
      getWalletTokenBalance: async (input) => {
        queriedId = input.id;
        return {
          data: {
            tokenBalances: [
              {
                token: {
                  symbol: "USDC",
                  tokenAddress: ARC_HOSTED_USDC_TOKEN_ADDRESS,
                },
                amount: "250.00",
              },
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

  it("transfers tokens using the tenant-bound wallet address and canonical Arc USDC tokenAddress", async () => {
    const txInputs: Array<
      Parameters<CircleDeveloperSdkClient["createTransaction"]>[0]
    > = [];
    const { facade } = createTestContext({
      createTransaction: async (input) => {
        txInputs.push(input);
        return { data: { id: "tx-facade-1", state: "INITIATED" } };
      },
    });

    const res = await facade.transferTokens(validAuthority, {
      toAddress: "0x2222222222222222222222222222222222222222",
      amount: "10.0",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    assert.deepEqual(res, { transactionId: "tx-facade-1", state: "INITIATED" });
    const txInput = txInputs[0];
    assert.ok(txInput);
    assert.equal(txInput.walletAddress, validAuthority.walletAddress);
    assert.equal(txInput.destinationAddress, "0x2222222222222222222222222222222222222222");
    assert.deepEqual(txInput.amount, ["10.0"]);
    assert.equal(txInput.tokenAddress, ARC_HOSTED_USDC_TOKEN_ADDRESS);
    assert.equal(txInput.blockchain, "ARC-TESTNET");
    assert.equal(txInput.tokenId, undefined);
  });

  it("rejects caller-controlled token selection instead of silently stripping it", async () => {
    const { facade } = createTestContext();
    const untrustedInput = {
      toAddress: "0x2222222222222222222222222222222222222222",
      amount: "10.0",
      tokenId: "caller-controlled-circle-token-id",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    };

    await assert.rejects(
      facade.transferTokens(validAuthority, untrustedInput),
      /Unrecognized key.*tokenId/,
    );
  });

  it("rejects a zero-value hosted transfer before calling Circle", async () => {
    let createTransactionCalls = 0;
    const { facade } = createTestContext({
      createTransaction: async () => {
        createTransactionCalls++;
        return { data: { id: "tx-zero", state: "INITIATED" } };
      },
    });

    await assert.rejects(
      facade.transferTokens(validAuthority, {
        toAddress: "0x2222222222222222222222222222222222222222",
        amount: "0",
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
      /Expected a positive decimal amount/,
    );
    assert.equal(createTransactionCalls, 0);
  });

  it("executes contract functions resolving private wallet ID", async () => {
    let contractInput:
      | Parameters<CircleDeveloperSdkClient["createContractExecutionTransaction"]>[0]
      | undefined;
    const { facade } = createTestContext({
      createContractExecutionTransaction: async (input) => {
        contractInput = input;
        return { data: { id: "tx-contract-1", state: "INITIATED" } };
      },
    });

    const res = await facade.executeContract(validAuthority, {
      contractAddress: "0x3333333333333333333333333333333333333333",
      abiFunctionSignature: "transfer(address,uint256)",
      args: ["0x2222222222222222222222222222222222222222", "100"],
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    assert.deepEqual(res, { transactionId: "tx-contract-1", state: "INITIATED" });
    assert.ok(contractInput);
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

  it("creates fully tenant-bound ArcAppKitService adapter instance enforcing balances, bridge, and swap", async () => {
    const calls: {
      balanceAddress?: string;
      bridge?: ArcBridgeQuoteInput;
      swap?: ArcSwapQuoteInput;
    } = {};
    const fakeAppKitService: ArcAppKitService = {
      getSupportedChains: () => [],
      getUnifiedBalances: async (address) => {
        calls.balanceAddress = address;
        return {
          token: "USDC",
          confirmed: "1",
          pending: null,
          pendingAvailable: false,
          breakdown: [],
        };
      },
      estimateBridge: async (input) => {
        calls.bridge = input;
        return {
          token: "USDC",
          sourceChain: input.sourceChain,
          destinationChain: input.destinationChain,
          amount: input.amount,
          fees: [],
          quotedAt: "2026-07-30T00:00:00.000Z",
          expiresAt: "2026-07-30T00:05:00.000Z",
        };
      },
      estimateSwap: async (input) => {
        calls.swap = input;
        return {
          chain: input.chain,
          sellToken: input.sellToken,
          buyToken: input.buyToken,
          sellAmount: input.sellAmount,
          minimumReceive: "9",
          estimatedReceive: "10",
          fees: [],
          quotedAt: "2026-07-30T00:00:00.000Z",
          expiresAt: "2026-07-30T00:05:00.000Z",
        };
      },
    };
    const { facade } = createTestContext(undefined, fakeAppKitService);
    const appKitService = await facade.createAppKitAdapter(validAuthority);

    await assert.rejects(
      appKitService.getUnifiedBalances("0x9999999999999999999999999999999999999999", false),
      /Access denied: address does not match tenant-bound wallet address/,
    );

    await assert.rejects(
      appKitService.estimateBridge({
        sourceChain: "Arc_Testnet",
        destinationChain: "Base_Sepolia",
        sourceAddress: "0x9999999999999999999999999999999999999999",
        recipient: "0x1111111111111111111111111111111111111111",
        amount: "10",
      }),
      /Access denied: sourceAddress does not match tenant-bound wallet address/,
    );

    await assert.rejects(
      appKitService.estimateSwap({
        chain: "Arc_Testnet",
        walletAddress: "0x9999999999999999999999999999999999999999",
        sellToken: "USDC",
        buyToken: "EURC",
        sellAmount: "10",
        slippageBps: 50,
      }),
      /Access denied: walletAddress does not match tenant-bound wallet address/,
    );

    await appKitService.getUnifiedBalances(validAuthority.walletAddress, false);
    await appKitService.estimateBridge({
      sourceChain: "Arc_Testnet",
      destinationChain: "Base_Sepolia",
      sourceAddress: validAuthority.walletAddress,
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "10",
    });
    await appKitService.estimateSwap({
      chain: "Arc_Testnet",
      walletAddress: validAuthority.walletAddress,
      sellToken: "USDC",
      buyToken: "EURC",
      sellAmount: "10",
      slippageBps: 50,
    });

    assert.equal(calls.balanceAddress, validAuthority.walletAddress);
    assert.equal(calls.bridge?.sourceAddress, validAuthority.walletAddress);
    assert.equal(calls.swap?.walletAddress, validAuthority.walletAddress);
  });

  it("returns capability matrix matching all 31 Arc MCP tool names", () => {
    const { facade } = createTestContext();
    const matrix = facade.getCapabilityMatrix();
    assert.deepEqual(ALL_ARC_MCP_TOOL_NAMES, EXPECTED_LOCAL_ARC_TOOLS);
    assert.deepEqual(matrix.map((entry) => entry.toolName), EXPECTED_LOCAL_ARC_TOOLS);
    assert.equal(new Set(matrix.map((entry) => entry.toolName)).size, 31);

    const supportedTools = matrix.filter((m) => m.hostedStatus === "SUPPORTED").map((m) => m.toolName);
    assert.deepEqual(supportedTools.sort(), [
      "get_agent_budget",
      "get_payment_receipt",
      "get_unified_balance",
      "send_usdc",
      "setup_agent_wallet",
    ]);
  });
});
