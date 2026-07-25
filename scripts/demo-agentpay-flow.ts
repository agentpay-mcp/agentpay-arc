import { pathToFileURL } from "node:url";

import {
  createAgentPayRuntime,
  type AgentPayRuntimeFactories,
  type AgentWallet,
} from "@agentpay-ai/mcp-server-arc";
import type { PaymentEventRecord, PaymentIntentRecord, RouteQuote, SetupIntentRecord } from "@agentpay-ai/shared-arc";

import {
  completeWalletSetup,
  type CompleteWalletSetupDependencies,
} from "../apps/setup-web/src/services/complete-wallet-setup.ts";

const demoNow = new Date("2026-07-03T12:00:00.000Z");
const sourceTxHash = `0x${"a".repeat(64)}`;
const destinationTxHash = `0x${"b".repeat(64)}`;
const setupDeploymentTxHash = `0x${"d".repeat(64)}`;
const setupSignature = `0x${"c".repeat(130)}`;
const demoInvoice = [
  "Invoice ID: inv_demo",
  "Recipient: 0x1111111111111111111111111111111111111111",
  "Destination Chain: Base",
  "Token: USDC",
  "Amount: 10",
  "Purpose: design bounty",
].join("\n");
const demoX402PaymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Premium market data",
    serviceName: "Market API",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    },
  ],
};

const demoWallet: AgentWallet = {
  ownerAddress: "0x2222222222222222222222222222222222222222",
  accountAddress: "0x3333333333333333333333333333333333333333",
  homeChainId: 11142220,
  executorAddress: "0x4444444444444444444444444444444444444444",
  status: "ACTIVE",
};

const demoRouteQuote: RouteQuote = {
  routeProvider: "LI.FI",
  sourceTokenAddress: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
  destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  maxAmountIn: "0.011",
  maxNativeFee: "2500000000000000",
  routeTarget: "0x7777777777777777777777777777777777777777",
  routeCalldata: "0x1234",
  routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
  routeSummary: "Bridge USDC from Celo Sepolia and pay USDC on Base.",
  estimatedFee: "0.12",
  estimatedEtaSeconds: 120,
};

export interface LocalAgentPayDemoResult {
  initialWallet: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["getAgentWallet"]>>;
  setup: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["prepareWalletCreation"]>>;
  completedSetup: Awaited<ReturnType<typeof completeWalletSetup>>;
  checkedSetup: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["checkWalletCreation"]>>;
  wallet: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["getAgentWallet"]>>;
  balance: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["getBalance"]>>;
  invoice: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["parseInvoicePayment"]>>;
  x402: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["parseX402PaymentRequired"]>>;
  quote: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["quotePaymentRoute"]>>;
  routeAllowance: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["checkRouteTargetAllowance"]>>;
  prepared: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["preparePayment"]>>;
  executed: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["executePayment"]>>;
  tracked: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["trackPayment"]>>;
  x402Retry: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["retryX402Request"]>>;
  transactions: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["listTransactions"]>>;
  events: Awaited<ReturnType<ReturnType<typeof createAgentPayRuntime>["listPaymentEvents"]>>;
  transcript: string[];
}

interface DemoState {
  wallet: AgentWallet | null;
  paymentIntents: Map<string, PaymentIntentRecord>;
  setupIntents: Map<string, SetupIntentRecord>;
  paymentEvents: PaymentEventRecord[];
  nextEventNumber: number;
}

export async function runLocalAgentPayDemo(): Promise<LocalAgentPayDemoResult> {
  const state = createDemoState();
  const runtime = createAgentPayRuntime(
    {
      supabaseUrl: "https://agentpay-demo.supabase.co",
      serviceRoleKey: "demo-service-role-key",
      celoRpcUrl: "https://celo-sepolia-demo-rpc.example",
      executorPrivateKey: `0x${"1".repeat(64)}`,
      setupWebUrl: "https://setup.agentpay.local/setup",
    },
    {
      factories: createDemoFactories(state),
      executorAddress: demoWallet.executorAddress,
      clock: () => demoNow,
      createId: () => "pay_demo",
      createNonce: () => "42",
      createSetupIntentId: () => "setup_demo",
      approvalTtlSeconds: 900,
      setupTtlSeconds: 900,
      x402HttpClient: {
        async request() {
          return new Response(JSON.stringify({ market: "premium" }), {
            status: 200,
            headers: {
              "x-payment-response": "settled",
            },
          });
        },
      },
    },
  );

  const initialWallet = await runtime.getAgentWallet({});
  const setup = await runtime.prepareWalletCreation({ ownerAddress: demoWallet.ownerAddress });
  if (setup.status !== "PENDING") {
    throw new Error("The local demo requires the legacy in-memory setup intent path.");
  }
  const completedSetup = await completeWalletSetup(
    {
      setupIntentId: setup.setupIntentId,
      signature: setupSignature,
    },
    createSetupCompletionDependencies(state),
  );
  const checkedSetup = await runtime.checkWalletCreation({ setupIntentId: setup.setupIntentId });
  const wallet = await runtime.getAgentWallet({});
  const balance = await runtime.getBalance({});
  const invoice = await runtime.parseInvoicePayment({ invoice: demoInvoice });
  const x402 = await runtime.parseX402PaymentRequired({ paymentRequired: demoX402PaymentRequired });
  const quote = await runtime.quotePaymentRoute(x402.paymentInput);
  const routeAllowance = await runtime.checkRouteTargetAllowance({ routeTarget: quote.routeTarget });
  const prepared = await runtime.preparePayment(x402.paymentInput);
  const executed = await runtime.executePayment({
    paymentIntentId: prepared.paymentIntentId,
    approvalText: prepared.approvalPhrase,
  });
  const tracked = await runtime.trackPayment({ paymentIntentId: prepared.paymentIntentId });
  const x402Retry = await runtime.retryX402Request({
    paymentRequired: demoX402PaymentRequired,
    paymentIntentId: prepared.paymentIntentId,
  });
  const transactions = await runtime.listTransactions({ limit: 5 });
  const events = await runtime.listPaymentEvents({ paymentIntentId: prepared.paymentIntentId, limit: 10 });

  return {
    initialWallet,
    setup,
    completedSetup,
    checkedSetup,
    wallet,
    balance,
    invoice,
    x402,
    quote,
    routeAllowance,
    prepared,
    executed,
    tracked,
    x402Retry,
    transactions,
    events,
    transcript: [
      `Initial wallet: ${initialWallet.status}.`,
      `Setup intent: ${setup.setupIntentId} at ${setup.setupUrl}.`,
      `Setup completed: ${completedSetup.accountAddress}.`,
      `Wallet: ${demoWallet.accountAddress} on Celo Sepolia.`,
      `Invoice parsed: ${invoice.invoiceId ?? "without id"}.`,
      `x402 parsed: ${x402.resource.serviceName}; AgentPay proof retry available after approval.`,
      `Quote: spend up to ${quote.maxAmountIn} ${quote.sourceTokenSymbol}; max native fee ${quote.maxNativeFeeDisplay}.`,
      `Route target allowlisted: ${routeAllowance.routeTargetAllowed}.`,
      `Approval required: ${prepared.approvalPhrase}.`,
      `Execution started: ${executed.sourceTxHash}.`,
      `Tracking result: ${tracked.status}${tracked.destinationTxHash ? ` at ${tracked.destinationTxHash}` : ""}.`,
      `x402 retry result: ${x402Retry.httpStatus} with ${x402Retry.paymentResponse ?? "no payment response"}.`,
    ],
  };
}

function createDemoState(): DemoState {
  return {
    wallet: null,
    paymentIntents: new Map(),
    setupIntents: new Map(),
    paymentEvents: [],
    nextEventNumber: 1,
  };
}

function createDemoFactories(state: DemoState): AgentPayRuntimeFactories {
  const paymentIntents = {
    async createPaymentIntent(intent: PaymentIntentRecord): Promise<void> {
      const saved = { ...intent, createdAt: demoNow.toISOString() };
      state.paymentIntents.set(intent.id, saved);
      addPaymentEvent(state, intent.id, "PAYMENT_PREPARED", "Payment intent prepared.", {
        routeProvider: intent.routeProvider,
      });
    },
    async getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
      const intent = state.paymentIntents.get(paymentIntentId);
      return intent ? clone(intent) : null;
    },
    async claimPaymentApproval(paymentIntentId: string, approvedAt: string): Promise<boolean> {
      const intent = state.paymentIntents.get(paymentIntentId);
      if (!intent || intent.status !== "AWAITING_APPROVAL") {
        return false;
      }

      state.paymentIntents.set(paymentIntentId, { ...intent, status: "APPROVED", approvedAt });
      addPaymentEvent(state, paymentIntentId, "PAYMENT_APPROVED", "Exact approval phrase accepted.", {
        approvedAt,
      });
      return true;
    },
    async markPaymentExecuting(paymentIntentId: string, txHash: string, approvedAt: string): Promise<void> {
      updatePaymentIntent(state, paymentIntentId, {
        status: "EXECUTING",
        sourceTxHash: txHash,
        approvedAt,
      });
      addPaymentEvent(state, paymentIntentId, "PAYMENT_EXECUTING", "Relayer transaction submitted.", {
        sourceTxHash: txHash,
      });
    },
    async markPaymentFailed(paymentIntentId: string, errorCode: string, errorMessage: string): Promise<void> {
      updatePaymentIntent(state, paymentIntentId, {
        status: "FAILED",
        errorCode,
        errorMessage,
      });
      addPaymentEvent(state, paymentIntentId, "PAYMENT_FAILED", errorMessage, { errorCode });
    },
    async markPaymentExpired(paymentIntentId: string): Promise<void> {
      updatePaymentIntent(state, paymentIntentId, { status: "EXPIRED" });
      addPaymentEvent(state, paymentIntentId, "PAYMENT_EXPIRED", "Payment approval deadline expired.");
    },
    async markPaymentCompleted(
      paymentIntentId: string,
      txHash: string | undefined,
      completedAt: string,
    ): Promise<void> {
      updatePaymentIntent(state, paymentIntentId, {
        status: "COMPLETED",
        destinationTxHash: txHash,
        completedAt,
      });
      addPaymentEvent(state, paymentIntentId, "PAYMENT_COMPLETED", "Payment completed.", {
        destinationTxHash: txHash,
      });
    },
    async listPaymentIntents(request: { limit: number }): Promise<PaymentIntentRecord[]> {
      return [...state.paymentIntents.values()]
        .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
        .slice(0, request.limit)
        .map(clone);
    },
  };

  return {
    createRepositories() {
      return {
        wallets: {
          async getActiveWallet() {
            return state.wallet ? clone(state.wallet) : null;
          },
        },
        setupIntents: {
          async createSetupIntent(intent: SetupIntentRecord) {
            state.setupIntents.set(intent.id, clone(intent));
          },
          async getSetupIntent(setupIntentId: string) {
            const intent = state.setupIntents.get(setupIntentId);
            return intent ? clone(intent) : null;
          },
        },
        paymentIntents,
        paymentEvents: {
          async listPaymentEvents(request: { paymentIntentId: string; limit: number }) {
            return state.paymentEvents
              .filter((event) => event.paymentIntentId === request.paymentIntentId)
              .slice(0, request.limit)
              .map(clone);
          },
        },
      };
    },
    createRoutes() {
      return {
        async quotePaymentRoute() {
          return clone(demoRouteQuote);
        },
        async getRouteStatus() {
          return {
            status: "DONE" as const,
            destinationTxHash,
            substatusMessage: "Payment completed.",
          };
        },
      };
    },
    createX402BazaarDiscovery() {
      return {
        async search() {
          return {
            resources: [],
          };
        },
      };
    },
    createChainAdapters() {
      return {
        balances: {
          async hasSufficientTokenBalance() {
            return true;
          },
        },
        executor: {
          async executeDirectPayment() {
            return { sourceTxHash };
          },
          async executeRoutePayment() {
            return { sourceTxHash };
          },
          async executeContractCall() {
            return { sourceTxHash };
          },
        },
        sourceTransactions: {
          async getSourceTransactionStatus() {
            return { status: "SUCCESS" as const };
          },
        },
        tokenBalances: {
          async getTokenBalance(request: { tokenSymbol: string }) {
            return { amount: request.tokenSymbol === "USDC" ? "25" : "0" };
          },
        },
        nativeBalances: {
          async getNativeBalance() {
            return { amount: "0.05" };
          },
        },
        routeTargetAllowances: {
          async isRouteTargetAllowed() {
            return true;
          },
        },
      };
    },
  };
}

function createSetupCompletionDependencies(state: DemoState): CompleteWalletSetupDependencies {
  return {
    setupIntents: {
      async getSetupIntent(setupIntentId) {
        const intent = state.setupIntents.get(setupIntentId);
        return intent ? clone(intent) : null;
      },
      async markSetupSigned(setupIntentId, ownerAddress, signature) {
        updateSetupIntent(state, setupIntentId, {
          ownerAddress,
          signature,
          status: "SIGNED",
        });
      },
      async markSetupCompleted(setupIntentId, accountAddress, completedAt) {
        updateSetupIntent(state, setupIntentId, {
          accountAddress,
          completedAt,
          status: "COMPLETED",
        });
      },
      async markSetupExpired(setupIntentId) {
        updateSetupIntent(state, setupIntentId, { status: "EXPIRED" });
      },
      async markSetupFailed(setupIntentId, errorCode, errorMessage) {
        updateSetupIntent(state, setupIntentId, {
          errorCode,
          errorMessage,
          status: "FAILED",
        });
      },
    },
    wallets: {
      async createAgentWallet(wallet) {
        state.wallet = clone(wallet);
      },
    },
    deployer: {
      async deployAgentPayAccount(request) {
        if (request.ownerAddress.toLowerCase() !== demoWallet.ownerAddress.toLowerCase()) {
          throw new Error("Demo setup owner did not match the prepared owner.");
        }

        if (request.executorAddress.toLowerCase() !== demoWallet.executorAddress.toLowerCase()) {
          throw new Error("Demo setup executor did not match the runtime executor.");
        }

        return {
          accountAddress: demoWallet.accountAddress,
          deploymentTxHash: setupDeploymentTxHash,
        };
      },
    },
    signatureVerifier: {
      async recoverSignerAddress(message, signature) {
        if (signature !== setupSignature || !message.includes("Setup ID: setup_demo")) {
          throw new Error("Unexpected demo setup signature.");
        }

        return demoWallet.ownerAddress;
      },
    },
    clock: () => demoNow,
    homeChainId: demoWallet.homeChainId,
  };
}

function updatePaymentIntent(state: DemoState, paymentIntentId: string, patch: Partial<PaymentIntentRecord>): void {
  const intent = state.paymentIntents.get(paymentIntentId);
  if (!intent) {
    throw new Error(`Payment intent ${paymentIntentId} was not found.`);
  }

  state.paymentIntents.set(paymentIntentId, { ...intent, ...patch });
}

function updateSetupIntent(state: DemoState, setupIntentId: string, patch: Partial<SetupIntentRecord>): void {
  const intent = state.setupIntents.get(setupIntentId);
  if (!intent) {
    throw new Error(`Setup intent ${setupIntentId} was not found.`);
  }

  state.setupIntents.set(setupIntentId, { ...intent, ...patch });
}

function addPaymentEvent(
  state: DemoState,
  paymentIntentId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
): void {
  state.paymentEvents.push({
    id: `evt_${String(state.nextEventNumber).padStart(3, "0")}`,
    paymentIntentId,
    eventType,
    message,
    metadata,
    createdAt: demoNow.toISOString(),
  });
  state.nextEventNumber += 1;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalAgentPayDemo()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "AgentPay local demo failed.");
      process.exitCode = 1;
    });
}
