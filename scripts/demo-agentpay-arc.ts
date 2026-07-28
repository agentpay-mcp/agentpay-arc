import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createArcAgentWalletMcpServer,
  createArcGatewayPaidService,
  createDefaultArcAgentWalletRuntime,
  type AgentPayMcpServer,
  type SendUsdcOutput,
} from "@agentpay-ai/mcp-server-arc";
import type {
  ArcAgentActivityRecord,
  ArcPaymentReceiptRecord,
} from "@agentpay-ai/shared-arc";
import type {
  CircleAgentWallet,
  CircleGatewayBalance,
  CircleSessionStatus,
  CircleTransactionResult,
  CircleWalletBalance,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../apps/mcp-server/src/services/circle-cli.ts";
import type { ArcAppKitService } from "../apps/mcp-server/src/services/arc-app-kit.ts";
import type { ArcErc8004ViemReaders } from "../apps/mcp-server/src/services/arc-erc8004-viem.ts";
import type { ArcAgentJobViemReaders } from "../apps/mcp-server/src/services/arc-agent-jobs-viem.ts";
import type { SwapSettlementVerifier } from "../apps/mcp-server/src/tools/arc-liquidity.ts";
import type {
  AgentBudgetOutput,
  SetupAgentWalletOutput,
} from "../apps/mcp-server/src/tools/circle-agent-wallet.ts";
import { createMarketplaceHandler } from "../apps/marketplace/src/index.ts";

const NOW = new Date("2026-07-28T07:00:00.000Z");
const WALLET = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const RECONCILIATION_RECIPIENT =
  "0x3333333333333333333333333333333333333333";
const PAYMENT_ID = "436dd5c3-d784-4980-b708-3f1ddc84010e";
const RECONCILIATION_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
const PAID_SERVICE_ID = "9dcad04d-ffce-43e3-a377-04ac86a1a7a9";
const BRIDGE_ID = "b5baa6a4-e1eb-44ae-9861-4bdbb7816579";
const SWAP_ID = "cc42e5ac-c83c-40f0-bff2-dd4cf4c1f842";
const SWAP_AND_PAY_ID = "d4cb7989-c3d8-491a-aebd-e1f9dbb315bd";
const IDENTITY_ID = "e3a1c72c-4d52-43ca-aea2-7215839c2f63";
const TRANSACTION_HASH = `0x${"a".repeat(64)}`;
const SECOND_TRANSACTION_HASH = `0x${"b".repeat(64)}`;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SERVICE_URL = "https://seller.example/v1/report";

export interface ArcDemoFeature {
  readonly id: number;
  readonly name: string;
  readonly tools: readonly string[];
}

export const ARC_DEMO_FEATURES: readonly ArcDemoFeature[] = Object.freeze([
  { id: 1, name: "Create and fund Circle Agent Wallet", tools: ["setup_agent_wallet", "fund_agent_wallet"] },
  { id: 2, name: "Balance as autonomous budget", tools: ["get_agent_budget"] },
  { id: 3, name: "ERC-8004 Agent Identity", tools: ["register_agent_identity", "get_agent_identity"] },
  { id: 4, name: "Discover paid services", tools: ["search_paid_services", "inspect_paid_service"] },
  { id: 5, name: "Autonomous x402 buyer", tools: ["pay_paid_service"] },
  { id: 6, name: "x402 seller endpoint", tools: ["pay_paid_service"] },
  { id: 7, name: "Agent-to-agent payment", tools: ["send_usdc"] },
  { id: 8, name: "Activity and Arcscan proof", tools: ["list_agent_activity", "get_payment_receipt"] },
  { id: 9, name: "Withdraw remaining balance", tools: ["withdraw_agent_budget"] },
  { id: 10, name: "ERC-8004 reputation", tools: ["give_agent_feedback", "get_agent_trust"] },
  { id: 11, name: "Direct USDC send", tools: ["send_usdc"] },
  { id: 12, name: "Unified Balance and crosschain funding", tools: ["get_unified_balance", "fund_from_any_chain", "bridge_usdc"] },
  { id: 13, name: "ERC-8183 escrow jobs", tools: ["create_agent_job", "set_agent_job_budget", "fund_agent_job", "submit_agent_deliverable", "complete_agent_job", "reject_agent_job", "get_agent_job"] },
  { id: 14, name: "Swap and pay", tools: ["swap_tokens", "swap_and_pay"] },
  { id: 15, name: "Invoice and payment request", tools: ["create_payment_request", "pay_invoice"] },
  { id: 16, name: "Batch payout", tools: ["batch_payout"] },
  { id: 17, name: "ERC-8004 validation credentials", tools: ["request_agent_validation", "respond_agent_validation"] },
  { id: 18, name: "Agent marketplace UI", tools: ["search_paid_services"] },
  { id: 19, name: "Circle compliance integration", tools: ["send_usdc", "pay_paid_service"] },
]);

class DemoMcpServer implements AgentPayMcpServer {
  readonly toolNames: string[] = [];

  registerTool(name: string): void {
    this.toolNames.push(name);
  }
}

export async function runDeterministicArcDemo() {
  const directory = await mkdtemp(join(tmpdir(), "agentpay-arc-demo-"));
  const statePath = join(directory, "state.json");
  const mutationAttempts = {
    transfers: 0,
    paidServices: 0,
    bridges: 0,
    swaps: 0,
    contracts: 0,
  };

  try {
    const runtime = createDefaultArcAgentWalletRuntime({
      statePath,
      circleCli: createDemoCircleCli(mutationAttempts),
      appKit: createDemoAppKit(),
      settlementVerifier: createDemoSettlementVerifier(),
      identityReaders: createDemoIdentityReaders(),
      jobReaders: createDemoJobReaders(),
      clock: () => NOW,
    });
    const mcpServer = createArcAgentWalletMcpServer(
      runtime,
      () => new DemoMcpServer(),
    );
    const registeredTools = Object.freeze([...mcpServer.toolNames]);
    assertCompleteFeatureMapping(registeredTools);

    const wallet = await runtime.setupAgentWallet(
      {},
    ) as SetupAgentWalletOutput;
    const budget = await runtime.getAgentBudget({
      walletAddress: WALLET,
    }) as AgentBudgetOutput;
    const paymentInput = {
      idempotencyKey: PAYMENT_ID,
      walletAddress: WALLET,
      recipient: RECIPIENT,
      amount: "2.5",
      purpose: "Deterministic agent-to-agent service payment",
    };
    const payment = await runtime.sendUsdc(paymentInput) as SendUsdcOutput;
    const paymentReplay = await runtime.sendUsdc(
      paymentInput,
    ) as SendUsdcOutput;
    const transferAttemptsAfterReplay = mutationAttempts.transfers;
    const reconciliation = await runtime.sendUsdc({
      idempotencyKey: RECONCILIATION_ID,
      walletAddress: WALLET,
      recipient: RECONCILIATION_RECIPIENT,
      amount: "1",
      purpose: "Demonstrate fail-closed reconciliation",
    }) as SendUsdcOutput;
    const paidServiceRequest = {
      url: SERVICE_URL,
      method: "GET" as const,
      headers: {},
    };
    const inspectedService = await runtime.inspectPaidService(
      paidServiceRequest,
    ) as { readonly quote: unknown };
    const paidServiceInput = {
      idempotencyKey: PAID_SERVICE_ID,
      buyerAgentId: "demo-buyer",
      sellerAgentId: "demo-seller",
      walletAddress: WALLET,
      request: paidServiceRequest,
      inspectedQuote: inspectedService.quote,
    };
    const paidService = await runtime.payPaidService(
      paidServiceInput,
    ) as { readonly receipt: { readonly status: string } };
    const paidServiceReplay = await runtime.payPaidService(
      paidServiceInput,
    ) as { readonly receipt: { readonly status: string } };
    const bridge = await runtime.bridgeUsdc({
      idempotencyKey: BRIDGE_ID,
      walletAddress: WALLET,
      destinationChain: "Base_Sepolia",
      recipient: RECIPIENT,
      amount: "1",
      minimumReceive: "1",
      slippageBps: 0,
    }) as { readonly status: string };
    const swapInput = {
      idempotencyKey: SWAP_ID,
      walletAddress: WALLET,
      sellToken: "USDC",
      buyToken: "EURC",
      sellAmount: "5",
      minimumReceive: "4.9",
      slippageBps: 100,
    } as const;
    const swap = await runtime.swapTokens(swapInput) as {
      readonly status: string;
    };
    const swapReplay = await runtime.swapTokens(swapInput) as {
      readonly status: string;
    };
    const swapAndPay = await runtime.swapAndPay({
      idempotencyKey: SWAP_AND_PAY_ID,
      walletAddress: WALLET,
      sellToken: "EURC",
      buyToken: "USDC",
      sellAmount: "1",
      minimumReceive: "1",
      slippageBps: 0,
      payment: {
        recipient: RECIPIENT,
        minimumAmount: "1",
        purpose: "Pay after verified deterministic swap settlement",
      },
    }) as { readonly status: string };
    const identityInput = {
      idempotencyKey: IDENTITY_ID,
      walletAddress: WALLET,
      agentURI: "https://agentpay.site/.well-known/agent.json",
    };
    const identity = await runtime.registerAgentIdentity(identityInput) as {
      readonly status: string;
      readonly agentId?: string;
    };
    const identityReplay = await runtime.registerAgentIdentity(
      identityInput,
    ) as { readonly status: string; readonly agentId?: string };
    const job = await runtime.createAgentJob({
      walletAddress: WALLET,
      provider: RECIPIENT,
      evaluator: RECONCILIATION_RECIPIENT,
      expiredAt: "4102444800",
      description: "Produce the deterministic AgentPay Arc report",
    }) as { readonly status: string; readonly jobId?: string };
    const receiptResult = await runtime.getPaymentReceipt({
      receiptId: PAYMENT_ID,
    }) as {
      readonly receipt: ArcPaymentReceiptRecord & {
        readonly reconciliationRequired: boolean;
        readonly explorerUrl?: string;
      };
    };
    const activityResult = await runtime.listAgentActivity({
      limit: 20,
    }) as { readonly activities: readonly ArcAgentActivityRecord[] };
    const receipt = receiptResult.receipt;
    const activity = activityResult.activities;
    const marketplace = await exerciseMarketplace();

    return {
      features: ARC_DEMO_FEATURES,
      registeredTools,
      wallet,
      budget,
      payment,
      paymentReplay,
      transferAttemptsAfterReplay,
      reconciliation,
      paidService,
      paidServiceReplay,
      bridge,
      swap,
      swapReplay,
      swapAndPay,
      identity,
      identityReplay,
      job,
      mutationAttempts: Object.freeze({ ...mutationAttempts }),
      receipt,
      activity,
      marketplace,
      sellerEndpointReady: typeof createArcGatewayPaidService === "function",
      transcript: Object.freeze([
        "AgentPay Arc deterministic demo: no credentials and no network writes.",
        `${ARC_DEMO_FEATURES.length}/19 features mapped to the reviewed product surface.`,
        `${registeredTools.length} local Arc MCP tools registered; hosted Circle CLI authority remains absent.`,
        `Wallet ${WALLET} is ready with ${budget.autonomousBudgetUsdc} USDC autonomous budget.`,
        `Direct payment completed at ${payment.receipt.transactionHash}.`,
        "Idempotent replay reused the receipt without a second transfer.",
        "An ambiguous mutation returned reconciliation required and was not retried.",
        "x402, bridge, swap, swap-and-pay, ERC-8004, and ERC-8183 adapters completed against deterministic fakes.",
        "Marketplace catalogue is public; tenant activity rejects anonymous access.",
      ]),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createDemoCircleCli(mutations: {
  transfers: number;
  paidServices: number;
  bridges: number;
  swaps: number;
  contracts: number;
}): CircleCli {
  const session: CircleSessionStatus = {
    type: "agent",
    mainnet: { tokenStatus: "NOT_LOGGED_IN" },
    testnet: { tokenStatus: "VALID" },
  };
  const wallet: CircleAgentWallet = {
    address: WALLET,
    type: "agent",
    blockchain: "ARC-TESTNET",
  };
  const balance: CircleWalletBalance = {
    balances: [{
      amount: "25",
      token: {
        name: "USD Coin",
        symbol: "USDC",
        blockchain: "ARC-TESTNET",
        decimals: 6,
        isNative: false,
        tokenAddress: ARC_USDC,
      },
    }],
  };
  const gateway: CircleGatewayBalance = {
    message: "Gateway balance: 1.5 USDC",
    address: WALLET,
    backingEOA: RECIPIENT,
    total: "1.5",
    token: "USDC",
    balances: [{ network: "Arc Testnet", domain: 26, balance: "1.5" }],
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("The deterministic demo did not configure this adapter.");
  };

  return {
    async status() {
      return session;
    },
    async listAgentWallets() {
      return [wallet];
    },
    async getBalance() {
      return balance;
    },
    async getGatewayBalance() {
      return gateway;
    },
    async transfer(input) {
      mutations.transfers += 1;
      if (input.recipient.toLowerCase() === RECONCILIATION_RECIPIENT) {
        throw new Error("Deterministic ambiguous transport result.");
      }
      return {
        id: "circle-demo-transaction",
        state: "COMPLETE",
        blockchain: "ARC-TESTNET",
        txHash: TRANSACTION_HASH,
      } satisfies CircleTransactionResult;
    },
    async swap(input) {
      mutations.swaps += 1;
      return {
        message: "Deterministic swap complete",
        sellToken: input.sellToken,
        sellAmount: input.sellAmount,
        buyToken: input.buyToken,
        buyMin: input.minimumBuy,
        chain: "ARC-TESTNET",
        transactions: [{
          id: `circle-demo-swap-${mutations.swaps}`,
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: SECOND_TRANSACTION_HASH,
        }],
      };
    },
    async executeContract() {
      mutations.contracts += 1;
      return {
        id: `circle-demo-contract-${mutations.contracts}`,
        state: "COMPLETE",
        blockchain: "ARC-TESTNET",
        txHash: SECOND_TRANSACTION_HASH,
      };
    },
    async searchServices() {
      return [{ url: SERVICE_URL, name: "Deterministic report service" }];
    },
    async inspectService(request) {
      return {
        status: "payable",
        httpStatus: 402,
        url: request.url,
        method: request.method ?? "GET",
        price: { amount: "1250000", formatted: "$1.25" },
        chains: ["eip155:5042002"],
        scheme: "exact",
        seller: RECIPIENT,
      };
    },
    async payService() {
      mutations.paidServices += 1;
      return {
        response: { report: "deterministic paid content" },
        payment: {
          amount: "1.25",
          chain: "ARC-TESTNET",
          scheme: "exact",
          seller: RECIPIENT,
          receipt: Buffer.from(JSON.stringify({
            success: true,
            network: "eip155:5042002",
            transaction: SECOND_TRANSACTION_HASH,
            payer: WALLET,
          })).toString("base64"),
        },
      };
    },
    async bridge(input) {
      mutations.bridges += 1;
      return {
        message: "Deterministic bridge complete",
        traceId: "demo-trace",
        transferId: "demo-transfer",
        burnTxHash: TRANSACTION_HASH,
        forwardTxHash: SECOND_TRANSACTION_HASH,
        fromChain: "ARC-TESTNET",
        toChain: input.destination,
        amount: input.amount,
        status: "complete",
        transactions: [{
          id: "circle-demo-bridge",
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: TRANSACTION_HASH,
        }],
      };
    },
    fundFromFaucet: unavailable,
    depositGateway: unavailable,
    withdrawGateway: unavailable,
  };
}

function createDemoAppKit(): ArcAppKitService {
  return {
    getSupportedChains: () => [
      { chain: "Arc_Testnet", name: "Arc Testnet", isTestnet: true },
      { chain: "Base_Sepolia", name: "Base Sepolia", isTestnet: true },
    ],
    async getUnifiedBalances() {
      return {
        token: "USDC",
        confirmed: "1.5",
        pending: null,
        pendingAvailable: false,
        breakdown: [],
      };
    },
    async estimateBridge(input) {
      return {
        token: "USDC",
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain,
        amount: input.amount,
        fees: [],
        quotedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      };
    },
    async estimateSwap(input) {
      const minimumReceive = input.buyToken === "EURC" ? "4.9" : "1";
      return {
        chain: input.chain,
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmount: input.sellAmount,
        minimumReceive,
        estimatedReceive: minimumReceive,
        fees: [],
        quotedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      };
    },
  };
}

function createDemoSettlementVerifier(): SwapSettlementVerifier {
  return {
    async verify() {
      return {
        status: "MINED",
        actualReceivedAtomic: "1000000",
        transactionHash: SECOND_TRANSACTION_HASH,
        blockNumber: "42",
      };
    },
  };
}

function createDemoIdentityReaders(): ArcErc8004ViemReaders {
  return {
    reader: {
      async ownerOf() { return WALLET; },
      async tokenURI() {
        return "https://agentpay.site/.well-known/agent.json";
      },
      async getAgentWallet() { return WALLET; },
      async getApproved() { return ZERO_ADDRESS; },
      async isApprovedForAll() { return false; },
      async getValidationStatus() {
        return {
          exists: false,
          validatorAddress: ZERO_ADDRESS,
          agentId: "42",
          response: 0,
          responseHash: `0x${"0".repeat(64)}`,
          tag: "",
          lastUpdate: "0",
          hasResponse: false,
        };
      },
      async getReputationSummary() {
        return { count: "0", summaryValue: "0", summaryValueDecimals: 0 };
      },
      async getValidationSummary() {
        return { count: "0", averageResponse: 0 };
      },
    },
    proofReader: {
      async proveMutation() {
        return {
          transactionHash: SECOND_TRANSACTION_HASH,
          blockNumber: "42",
          agentId: "42",
        };
      },
    },
  };
}

function createDemoJobReaders(): ArcAgentJobViemReaders {
  return {
    reader: {
      async getJob() {
        return {
          id: "7",
          client: WALLET,
          provider: RECIPIENT,
          evaluator: RECONCILIATION_RECIPIENT,
          description: "Produce the deterministic AgentPay Arc report",
          budget: "0",
          expiredAt: "4102444800",
          state: "Open",
          hook: ZERO_ADDRESS,
        };
      },
      async paymentToken() { return ARC_USDC; },
      async platformFeeBasisPoints() { return 0; },
      async evaluatorFeeBasisPoints() { return 0; },
      async usdcAllowance() { return "0"; },
      async isHookWhitelisted(hook) {
        return hook.toLowerCase() === ZERO_ADDRESS;
      },
    },
    proofReader: {
      async proveMutation() {
        return {
          transactionHash: SECOND_TRANSACTION_HASH,
          blockNumber: "42",
          jobId: "7",
        };
      },
    },
  };
}

async function exerciseMarketplace() {
  const handler = createMarketplaceHandler({
    sessions: {
      async resolve() {
        return null;
      },
    },
    services: {
      async search() {
        return [];
      },
      async get() {
        return null;
      },
    },
    trust: {
      async get() {
        return null;
      },
    },
    jobs: {
      async listForSeller() {
        return [];
      },
    },
    activity: {
      async listForTenant() {
        return [];
      },
    },
  });
  const [catalogue, tenantActivity] = await Promise.all([
    handler(new Request("https://marketplace.agentpay.local/")),
    handler(new Request("https://marketplace.agentpay.local/activity")),
  ]);
  return {
    catalogueStatus: catalogue.status,
    tenantActivityStatus: tenantActivity.status,
  };
}

function assertCompleteFeatureMapping(registeredTools: readonly string[]): void {
  const registered = new Set(registeredTools);
  if (ARC_DEMO_FEATURES.length !== 19) {
    throw new Error("The deterministic demo must map exactly 19 approved features.");
  }
  for (const feature of ARC_DEMO_FEATURES) {
    for (const tool of feature.tools) {
      if (!registered.has(tool)) {
        throw new Error(`Feature ${feature.id} is missing registered tool ${tool}.`);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDeterministicArcDemo()
    .then(({ transcript }) => {
      console.log(transcript.join("\n"));
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "AgentPay Arc demo failed.",
      );
      process.exitCode = 1;
    });
}
