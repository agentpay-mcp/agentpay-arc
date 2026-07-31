import { randomBytes } from "node:crypto";

import type { CeloHomeChainId, ExecutePaymentInput } from "@agentpay-ai/shared-arc";
import type { PreparePaymentInput } from "@agentpay-ai/shared-arc";
import type { GetPaymentSignatureInput } from "@agentpay-ai/shared-arc";
import type { GetBalanceInput } from "@agentpay-ai/shared-arc";
import type { ListPaymentEventsInput, ListTransactionsInput, TrackPaymentInput } from "@agentpay-ai/shared-arc";
import type { ParseInvoicePaymentInput } from "@agentpay-ai/shared-arc";
import type { ParseX402PaymentRequiredInput } from "@agentpay-ai/shared-arc";
import type { RetryX402RequestInput } from "@agentpay-ai/shared-arc";
import type { PrepareX402ServiceRequestInput, SearchX402ServicesInput } from "@agentpay-ai/shared-arc";
import type { PrepareContractCallInput } from "@agentpay-ai/shared-arc";
import type { PrepareAccountAdminTransactionInput } from "@agentpay-ai/shared-arc";
import type { QuotePaymentRouteInput } from "@agentpay-ai/shared-arc";
import type { SessionContext, SessionEnvironment } from "@agentpay-ai/shared-arc";
import type {
  CheckWalletCreationInput,
  CheckRouteTargetAllowanceInput,
  GetAgentWalletInput,
  PrepareRouteTargetAllowanceInput,
  PrepareWalletCreationInput,
} from "@agentpay-ai/shared-arc";
import {
  configureStableTokenMetadataOverrides,
  CELO_NETWORKS,
  isAssignedCeloAttributionTag,
  MAINNET_ONBOARDING_URL,
  type StableTokenMetadataOverrides,
} from "@agentpay-ai/shared-arc";
import { Wallet } from "ethers";

import { createEthersRuntimeAdapters, type EthersRuntimeConfig } from "../services/chain-executor.ts";
import { createCircleCli, type CircleCli } from "../services/circle-cli.ts";
import {
  createLifiRouteQuoteProvider,
  createLifiRouteStatusProvider,
  type LifiRouteQuoteProviderConfig,
} from "../services/lifi.ts";
import {
  createSupabaseAgentPayRepositoriesFromConfig,
  type SupabaseRuntimeConfig,
} from "../services/supabase.ts";
import type { PaymentReviewRepository } from "../services/payment-review.ts";
import {
  createX402BazaarDiscoveryProvider,
  type X402BazaarDiscoveryProviderConfig,
} from "../services/x402-bazaar.ts";
import {
  createExecuteAuthorizedPaymentHandler,
  createExecutePaymentHandler,
  createPreflightPaymentHandler,
  executePayment as executePaymentWithOptionalDurability,
} from "../tools/execute-payment.ts";
import type {
  DurableExecutionContext,
  ExecuteAuthorizedPaymentDependencies,
  ExecutePaymentDependencies,
} from "../tools/execute-payment.ts";
import type { PaymentPreflightResult } from "../tools/execute-payment.ts";
import type { PaidExecutionLifecycleStore } from "../services/paid-execution-lifecycle.ts";
import type { PaidExecutionChallengeStore } from "../services/paid-execution-challenge.ts";
import type { InvoiceExecutionOutboxStore } from "../services/paid-execution-outbox.ts";
import type { CanaryLedgerStore } from "./paid-execution-canary-ledger.ts";
import {
  reconcileInvoiceExecutionOutbox,
  type InvoiceExecutionReconciliationResult,
} from "../services/invoice-execution-reconciler.ts";
import { createGetBalanceHandler } from "../tools/get-balance.ts";
import type { GetBalanceDependencies } from "../tools/get-balance.ts";
import { createParseInvoicePaymentHandler } from "../tools/invoice.ts";
import {
  createPrepareX402ServiceRequestHandler,
  createSearchX402ServicesHandler,
} from "../tools/x402-bazaar.ts";
import {
  createParseX402PaymentRequiredHandler,
  createPinnedX402HttpClient,
  createRetryX402RequestHandler,
  type X402RetryHttpClient,
} from "../tools/x402.ts";
import { createPrepareAccountAdminTransactionHandler } from "../tools/account-admin.ts";
import type { PrepareAccountAdminTransactionDependencies } from "../tools/account-admin.ts";
import {
  createListPaymentEventsHandler,
  createListTransactionsHandler,
  createTrackPaymentHandler,
} from "../tools/payment-tracking.ts";
import type {
  ListPaymentEventsDependencies,
  ListTransactionsDependencies,
  TrackPaymentDependencies,
} from "../tools/payment-tracking.ts";
import { createPreparePaymentHandler } from "../tools/prepare-payment.ts";
import type { PreparePaymentDependencies } from "../tools/prepare-payment.ts";
import { createGetPaymentSignatureHandler } from "../tools/payment-review.ts";
import type { GetPaymentSignatureDependencies } from "../tools/payment-review.ts";
import { createPrepareContractCallHandler } from "../tools/prepare-contract-call.ts";
import type { PrepareContractCallDependencies } from "../tools/prepare-contract-call.ts";
import { createQuotePaymentRouteHandler } from "../tools/quote-payment-route.ts";
import type { QuotePaymentRouteDependencies } from "../tools/quote-payment-route.ts";
import {
  createCheckRouteTargetAllowanceHandler,
  createPrepareRouteTargetAllowanceHandler,
} from "../tools/route-target-allowance.ts";
import type {
  CheckRouteTargetAllowanceDependencies,
  PrepareRouteTargetAllowanceDependencies,
} from "../tools/route-target-allowance.ts";
import {
  createFundAgentWalletHandler,
  createGetAgentBudgetHandler,
  createSetupAgentWalletHandler,
  createWithdrawAgentBudgetHandler,
} from "../tools/circle-agent-wallet.ts";
import {
  createCheckWalletCreationHandler,
  createGetAgentWalletHandler,
  createPrepareWalletCreationHandler,
} from "../tools/wallet-setup.ts";
import type {
  CheckWalletCreationDependencies,
  GetAgentWalletDependencies,
  PrepareWalletCreationDependencies,
} from "../tools/wallet-setup.ts";
import { PRODUCTION_HOME_CHAIN_ID } from "./production-readiness.ts";
import type { ExecutionMode } from "./production-readiness.ts";

const REQUIRED_LOCAL_ENV_NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CELO_RPC_URL", "EXECUTOR_PRIVATE_KEY"];
const REQUIRED_PRODUCTION_ENV_NAMES = [
  "SUPABASE_PRODUCTION_URL",
  "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY",
  "CELO_MAINNET_RPC_URL",
  "CELO_MAINNET_RPC_FALLBACK_URL",
  "CELO_ATTRIBUTION_TAG",
  "AGENTPAY_SESSION_HASH_KEY",
  "AGENTPAY_REVIEW_TOKEN_SECRET",
  "AGENTPAY_PUBLIC_SETUP_URL",
  "SETUP_WEB_URL",
];
const PRODUCTION_FORBIDDEN_ENV_NAMES = [
  "CELO_RPC_URL",
  "CELO_SEPOLIA_RPC_URL",
  "AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS",
  "AGENTPAY_CELO_SEPOLIA_USDT_ADDRESS",
  "AGENTPAY_CELO_SEPOLIA_USDM_ADDRESS",
  "AGENTPAY_CELO_USDC_ADDRESS",
  "AGENTPAY_CELO_USDT_ADDRESS",
  "AGENTPAY_CELO_USDM_ADDRESS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DIRECT_URL",
];
const DEFAULT_SETUP_WEB_URL = "http://localhost:3000/setup";
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const setupHomeChainIds = new Set<CeloHomeChainId>([42220, 11142220]);
const runtimeHttpModes = new Set(["public", "consumer"]);
const runtimeEnvironments = new Set<SessionEnvironment>(["staging", "production"]);

export interface AgentPayRuntimeConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  celoRpcUrl: string;
  celoRpcUrls?: Partial<Record<number, string>>;
  celoRpcFallbackUrls?: Partial<Record<number, string>>;
  celoAttributionTag?: string;
  executorGasMaxWei?: bigint;
  executorPrivateKey?: string;
  executorAddress?: string;
  lifiApiKey?: string;
  lifiBaseUrl?: string;
  x402BazaarFacilitatorUrl?: string;
  setupWebUrl?: string;
  productionOnboardingUrl?: string;
  homeChainId?: CeloHomeChainId;
  stableTokenOverrides?: StableTokenMetadataOverrides;
  httpMode?: "public" | "consumer";
  sessionHashKey?: string;
  reviewTokenSecret?: string;
  rawTxEncryptionKey?: string;
  environment?: SessionEnvironment;
  executionMode?: ExecutionMode;
  /** Set only by a readiness-gated production surface. Environment text alone never authorizes execution. */
  executionModeVerified?: boolean;
  productionManifestPath?: string;
}

export interface AgentPayRuntimeFactories {
  createRepositories(config: SupabaseRuntimeConfig): Pick<PreparePaymentDependencies, "wallets" | "paymentIntents"> & {
    setupIntents: PrepareWalletCreationDependencies["setupIntents"] & CheckWalletCreationDependencies["setupIntents"];
    paymentIntents: PreparePaymentDependencies["paymentIntents"] &
      ExecutePaymentDependencies["paymentIntents"] &
      TrackPaymentDependencies["paymentIntents"] &
      ListTransactionsDependencies["paymentIntents"];
    paymentEvents: ListPaymentEventsDependencies["paymentEvents"];
    paymentReviews?: PaymentReviewRepository;
    paidExecutionLifecycle?: PaidExecutionLifecycleStore;
    paidExecutionChallenge?: PaidExecutionChallengeStore;
    invoiceExecutionOutbox?: InvoiceExecutionOutboxStore;
    canaryLedger?: CanaryLedgerStore;
  };
  createRoutes(config: LifiRouteQuoteProviderConfig): PreparePaymentDependencies["routes"] &
    TrackPaymentDependencies["routeStatuses"];
  createX402BazaarDiscovery(config: X402BazaarDiscoveryProviderConfig): ReturnType<
    typeof createX402BazaarDiscoveryProvider
  >;
  createChainAdapters(config: EthersRuntimeConfig): Pick<ExecutePaymentDependencies, "balances" | "executor"> & {
    authorizedExecutor?: import("../tools/execute-payment.ts").AuthorizedPaymentExecutor;
    sourceTransactions: TrackPaymentDependencies["sourceTransactions"];
    tokenBalances: GetBalanceDependencies["tokenBalances"];
    nativeBalances: GetBalanceDependencies["nativeBalances"];
    routeTargetAllowances: CheckRouteTargetAllowanceDependencies["routeTargetAllowances"];
  };
}

export interface AgentPayRuntimeOptions {
  fetch?: typeof fetch;
  x402HttpClient?: X402RetryHttpClient;
  x402BazaarFetch?: typeof fetch;
  clock?: () => Date;
  createId?: () => string;
  createNonce?: () => string;
  createSetupIntentId?: () => string;
  executorAddress?: string;
  approvalTtlSeconds?: number;
  setupTtlSeconds?: number;
  factories?: AgentPayRuntimeFactories;
  tenantContext?: SessionContext;
  circleCli?: CircleCli;
}

export interface AgentPayRuntime {
  circleCli?: CircleCli;
  setupAgentWallet(input: unknown): ReturnType<ReturnType<typeof createSetupAgentWalletHandler>>;
  getAgentBudget(input: unknown): ReturnType<ReturnType<typeof createGetAgentBudgetHandler>>;
  fundAgentWallet(input: unknown): ReturnType<ReturnType<typeof createFundAgentWalletHandler>>;
  withdrawAgentBudget(input: unknown): ReturnType<ReturnType<typeof createWithdrawAgentBudgetHandler>>;
  prepareWalletCreation(input: PrepareWalletCreationInput): ReturnType<ReturnType<typeof createPrepareWalletCreationHandler>>;
  checkWalletCreation(input: CheckWalletCreationInput): ReturnType<ReturnType<typeof createCheckWalletCreationHandler>>;
  getAgentWallet(input: GetAgentWalletInput): ReturnType<ReturnType<typeof createGetAgentWalletHandler>>;
  getBalance(input: GetBalanceInput): ReturnType<ReturnType<typeof createGetBalanceHandler>>;
  parseInvoicePayment(input: ParseInvoicePaymentInput): ReturnType<ReturnType<typeof createParseInvoicePaymentHandler>>;
  searchX402Services(input: SearchX402ServicesInput): ReturnType<ReturnType<typeof createSearchX402ServicesHandler>>;
  prepareX402ServiceRequest(
    input: PrepareX402ServiceRequestInput,
  ): ReturnType<ReturnType<typeof createPrepareX402ServiceRequestHandler>>;
  parseX402PaymentRequired(
    input: ParseX402PaymentRequiredInput,
  ): ReturnType<ReturnType<typeof createParseX402PaymentRequiredHandler>>;
  retryX402Request(input: RetryX402RequestInput): ReturnType<ReturnType<typeof createRetryX402RequestHandler>>;
  prepareContractCall(input: PrepareContractCallInput): ReturnType<ReturnType<typeof createPrepareContractCallHandler>>;
  quotePaymentRoute(input: QuotePaymentRouteInput): ReturnType<ReturnType<typeof createQuotePaymentRouteHandler>>;
  checkRouteTargetAllowance(
    input: CheckRouteTargetAllowanceInput,
  ): ReturnType<ReturnType<typeof createCheckRouteTargetAllowanceHandler>>;
  prepareAccountAdminTransaction(
    input: PrepareAccountAdminTransactionInput,
  ): ReturnType<ReturnType<typeof createPrepareAccountAdminTransactionHandler>>;
  prepareRouteTargetAllowance(
    input: PrepareRouteTargetAllowanceInput,
  ): ReturnType<ReturnType<typeof createPrepareRouteTargetAllowanceHandler>>;
  preparePayment(input: PreparePaymentInput): ReturnType<ReturnType<typeof createPreparePaymentHandler>>;
  getPaymentSignature(input: GetPaymentSignatureInput): ReturnType<ReturnType<typeof createGetPaymentSignatureHandler>>;
  executePayment(input: ExecutePaymentInput): ReturnType<ReturnType<typeof createExecutePaymentHandler>>;
  executePaymentWithContext?(
    input: ExecutePaymentInput,
    context: DurableExecutionContext,
  ): ReturnType<ReturnType<typeof createExecutePaymentHandler>>;
  executorAddress?: string;
  /** Read-only signature/balance/intent validation used by paid HTTP gates. */
  preflightPayment?(input: ExecutePaymentInput): Promise<PaymentPreflightResult>;
  paidExecutionLifecycle?: PaidExecutionLifecycleStore;
  paidExecutionChallenge?: PaidExecutionChallengeStore;
  invoiceExecutionOutbox?: InvoiceExecutionOutboxStore;
  canaryLedger?: CanaryLedgerStore;
  reconcileInvoiceExecutions?(): Promise<InvoiceExecutionReconciliationResult>;
  executeAuthorizedPayment(
    input: import("@agentpay-ai/shared-arc").ExecuteAuthorizedPaymentInput,
  ): ReturnType<ReturnType<typeof createExecuteAuthorizedPaymentHandler>>;
  trackPayment(input: TrackPaymentInput): ReturnType<ReturnType<typeof createTrackPaymentHandler>>;
  listTransactions(input: ListTransactionsInput): ReturnType<ReturnType<typeof createListTransactionsHandler>>;
  listPaymentEvents(input: ListPaymentEventsInput): ReturnType<ReturnType<typeof createListPaymentEventsHandler>>;
}

export function parseAgentPayEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AgentPayRuntimeConfig {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value?.trim()]),
  ) as Record<string, string | undefined>;
  const homeChainId = parseOptionalHomeChainId(normalized.AGENTPAY_HOME_CHAIN_ID);
  const celoRpcUrls = parseCeloRpcUrls(normalized);
  const celoRpcFallbackUrls = parseCeloRpcFallbackUrls(normalized);
  const stableTokenOverrides = parseStableTokenOverrides(normalized);
  const isProduction = normalized.AGENTPAY_ENVIRONMENT === "production";
  const isProductionConsumer = isProduction && normalized.AGENTPAY_HTTP_MODE === "consumer";
  const requiredEnvNames = isProduction
    ? [
        ...REQUIRED_PRODUCTION_ENV_NAMES,
        isProductionConsumer ? "AGENTPAY_EXECUTOR_ADDRESS" : "EXECUTOR_PRIVATE_KEY",
      ]
    : REQUIRED_LOCAL_ENV_NAMES;
  const supabaseUrl = isProduction ? normalized.SUPABASE_PRODUCTION_URL : normalized.SUPABASE_URL;
  const serviceRoleKey = isProduction ? normalized.SUPABASE_PRODUCTION_SERVICE_ROLE_KEY : normalized.SUPABASE_SERVICE_ROLE_KEY;
  const celoRpcUrl = isProduction ? normalized.CELO_MAINNET_RPC_URL : normalized.CELO_RPC_URL;
  const missing = requiredEnvNames.filter((name) => {
    if (name === "SUPABASE_URL" || name === "SUPABASE_PRODUCTION_URL") return !supabaseUrl;
    if (name === "SUPABASE_SERVICE_ROLE_KEY" || name === "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY") return !serviceRoleKey;
    if (name === "CELO_RPC_URL" || name === "CELO_MAINNET_RPC_URL") return !celoRpcUrl;
    return !normalized[name];
  });
  const invalid = [
    supabaseUrl && !isHttpUrl(supabaseUrl) ? (isProduction ? "SUPABASE_PRODUCTION_URL" : "SUPABASE_URL") : undefined,
    celoRpcUrl && !isHttpUrl(celoRpcUrl) ? (isProduction ? "CELO_MAINNET_RPC_URL" : "CELO_RPC_URL") : undefined,
    normalized.CELO_MAINNET_RPC_URL && !isHttpUrl(normalized.CELO_MAINNET_RPC_URL)
      ? "CELO_MAINNET_RPC_URL"
      : undefined,
    normalized.CELO_SEPOLIA_RPC_URL && !isHttpUrl(normalized.CELO_SEPOLIA_RPC_URL)
      ? "CELO_SEPOLIA_RPC_URL"
      : undefined,
    normalized.CELO_MAINNET_RPC_FALLBACK_URL &&
    normalized.CELO_MAINNET_RPC_FALLBACK_URL !== "https://forno.celo.org"
      ? "CELO_MAINNET_RPC_FALLBACK_URL"
      : undefined,
    normalized.CELO_ATTRIBUTION_TAG && !isAssignedCeloAttributionTag(normalized.CELO_ATTRIBUTION_TAG)
      ? "CELO_ATTRIBUTION_TAG"
      : undefined,
    normalized.EXECUTOR_PRIVATE_KEY && !privateKeyPattern.test(normalized.EXECUTOR_PRIVATE_KEY)
      ? "EXECUTOR_PRIVATE_KEY"
      : undefined,
    normalized.AGENTPAY_EXECUTOR_ADDRESS && !addressPattern.test(normalized.AGENTPAY_EXECUTOR_ADDRESS)
      ? "AGENTPAY_EXECUTOR_ADDRESS"
      : undefined,
    normalized.EXECUTOR_PRIVATE_KEY &&
    normalized.AGENTPAY_EXECUTOR_ADDRESS &&
    privateKeyPattern.test(normalized.EXECUTOR_PRIVATE_KEY) &&
    addressPattern.test(normalized.AGENTPAY_EXECUTOR_ADDRESS) &&
    new Wallet(normalized.EXECUTOR_PRIVATE_KEY).address.toLowerCase() !== normalized.AGENTPAY_EXECUTOR_ADDRESS.toLowerCase()
      ? "executor identity"
      : undefined,
    normalized.LIFI_BASE_URL && !isHttpUrl(normalized.LIFI_BASE_URL) ? "LIFI_BASE_URL" : undefined,
    normalized.X402_BAZAAR_FACILITATOR_URL && !isHttpUrl(normalized.X402_BAZAAR_FACILITATOR_URL)
      ? "X402_BAZAAR_FACILITATOR_URL"
      : undefined,
    normalized.SETUP_WEB_URL && !isSecureReviewUrl(normalized.SETUP_WEB_URL) ? "SETUP_WEB_URL" : undefined,
    isProduction && normalized.SETUP_WEB_URL && isLoopbackReviewUrl(normalized.SETUP_WEB_URL)
      ? "SETUP_WEB_URL"
      : undefined,
    normalized.AGENTPAY_HOME_CHAIN_ID && !homeChainId ? "AGENTPAY_HOME_CHAIN_ID" : undefined,
    normalized.AGENTPAY_HTTP_MODE && !runtimeHttpModes.has(normalized.AGENTPAY_HTTP_MODE) ? "AGENTPAY_HTTP_MODE" : undefined,
    normalized.AGENTPAY_ENVIRONMENT && !runtimeEnvironments.has(normalized.AGENTPAY_ENVIRONMENT as SessionEnvironment)
      ? "AGENTPAY_ENVIRONMENT"
      : undefined,
    normalized.AGENTPAY_SESSION_HASH_KEY && normalized.AGENTPAY_SESSION_HASH_KEY.length < 16
      ? "AGENTPAY_SESSION_HASH_KEY"
      : undefined,
    normalized.AGENTPAY_REVIEW_TOKEN_SECRET && normalized.AGENTPAY_REVIEW_TOKEN_SECRET.length < 32
      ? "AGENTPAY_REVIEW_TOKEN_SECRET"
      : undefined,
    isProductionConsumer && (normalized.EXECUTOR_PRIVATE_KEY || normalized.AGENTPAY_RAW_TX_ENCRYPTION_KEY)
      ? "consumer secret isolation"
      : undefined,
    isProduction && normalized.AGENTPAY_ACCOUNT_VERSION !== "v2" ? "AGENTPAY_ACCOUNT_VERSION" : undefined,
    isProduction && normalized.AGENTPAY_HOME_CHAIN_ID !== PRODUCTION_HOME_CHAIN_ID ? "AGENTPAY_HOME_CHAIN_ID" : undefined,
    isProduction && normalized.AGENTPAY_PUBLIC_SETUP_URL !== MAINNET_ONBOARDING_URL
      ? "AGENTPAY_PUBLIC_SETUP_URL"
      : undefined,
    isProduction && PRODUCTION_FORBIDDEN_ENV_NAMES.some((name) => normalized[name])
      ? "production environment isolation"
      : undefined,
    ...validateStableTokenOverrideAddresses(normalized),
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(createConfigErrorMessage(missing, invalid));
  }

  return omitUndefined({
    supabaseUrl,
    serviceRoleKey,
    celoRpcUrl,
    celoRpcUrls,
    celoRpcFallbackUrls,
    celoAttributionTag: normalized.CELO_ATTRIBUTION_TAG,
    executorPrivateKey: normalized.EXECUTOR_PRIVATE_KEY,
    executorAddress: normalized.AGENTPAY_EXECUTOR_ADDRESS,
    lifiApiKey: normalized.LIFI_API_KEY,
    lifiBaseUrl: normalized.LIFI_BASE_URL,
    x402BazaarFacilitatorUrl: normalized.X402_BAZAAR_FACILITATOR_URL,
    setupWebUrl: normalized.SETUP_WEB_URL,
    productionOnboardingUrl: isProduction ? normalized.AGENTPAY_PUBLIC_SETUP_URL : undefined,
    homeChainId,
    stableTokenOverrides,
    httpMode: normalized.AGENTPAY_HTTP_MODE as AgentPayRuntimeConfig["httpMode"],
    sessionHashKey: normalized.AGENTPAY_SESSION_HASH_KEY,
    reviewTokenSecret: normalized.AGENTPAY_REVIEW_TOKEN_SECRET,
    rawTxEncryptionKey: normalized.AGENTPAY_RAW_TX_ENCRYPTION_KEY,
    environment: normalized.AGENTPAY_ENVIRONMENT as SessionEnvironment | undefined,
    executionMode: normalized.AGENTPAY_EXECUTION_MODE as ExecutionMode | undefined,
    productionManifestPath: normalized.AGENTPAY_MAINNET_MANIFEST_PATH,
  }) as AgentPayRuntimeConfig;
}

export function createAgentPayRuntime(config: AgentPayRuntimeConfig, options: AgentPayRuntimeOptions = {}): AgentPayRuntime {
  configureStableTokenMetadataOverrides(config.stableTokenOverrides ?? {});
  const factories = options.factories ?? defaultAgentPayRuntimeFactories;
  const clock = options.clock ?? (() => new Date());
  const effectiveHomeChainId = requireOptionalCeloHomeChainId(options.tenantContext?.homeChainId ?? config.homeChainId);
  const repositories = factories.createRepositories(
    omitUndefined({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
      fetch: options.fetch,
      tenantContext: options.tenantContext,
    }) as SupabaseRuntimeConfig,
  );
  const routes = factories.createRoutes(
    omitUndefined({
      apiKey: config.lifiApiKey,
      baseUrl: config.lifiBaseUrl,
      integrator: "agentpay",
      fetch: options.fetch,
    }) as LifiRouteQuoteProviderConfig,
  );
  const chainAdapters = factories.createChainAdapters(
    omitUndefined({
      rpcUrl: config.celoRpcUrl,
      rpcUrls: config.celoRpcUrls,
      rpcFallbackUrls: config.celoRpcFallbackUrls,
      celoAttributionTag: config.celoAttributionTag,
      executorGasMaxWei: config.executorGasMaxWei,
      executorPrivateKey: config.executorPrivateKey,
    }) as EthersRuntimeConfig,
  );
  const x402BazaarDiscovery = factories.createX402BazaarDiscovery(
    omitUndefined({
      facilitatorUrl: config.x402BazaarFacilitatorUrl,
      fetch: options.x402BazaarFetch ?? options.fetch,
    }) as X402BazaarDiscoveryProviderConfig,
  );
  const executorAddress = options.executorAddress ?? config.executorAddress ??
    (config.executorPrivateKey ? new Wallet(config.executorPrivateKey).address : undefined);
  if (!executorAddress) {
    throw new Error("AgentPay runtime requires a pinned executor address or signing key.");
  }
  const executionPolicy = config.environment
    ? {
        environment: config.environment,
        mode:
          config.environment === "production" && !config.executionModeVerified
            ? ("OFF" as const)
            : config.executionMode ?? ("OFF" as const),
        directMainnetOnly: config.environment === "production",
      }
    : undefined;
  const executePaymentDependencies: ExecutePaymentDependencies = {
    paymentIntents: repositories.paymentIntents,
    balances: chainAdapters.balances,
    executor: chainAdapters.executor,
    authorizedExecutor: chainAdapters.authorizedExecutor,
    clock,
    executionPolicy,
  };
  const executeAuthorizedPaymentDependencies: ExecuteAuthorizedPaymentDependencies = {
    paymentIntents: repositories.paymentIntents,
    balances: chainAdapters.balances,
    authorizedExecutor: chainAdapters.authorizedExecutor,
    clock,
    executionPolicy,
  };
  const circleCli = options.circleCli ?? createCircleCli();

  return {
    circleCli,
    setupAgentWallet: createSetupAgentWalletHandler({ circleCli }),
    getAgentBudget: createGetAgentBudgetHandler({ circleCli }),
    fundAgentWallet: createFundAgentWalletHandler({ circleCli }),
    withdrawAgentBudget: createWithdrawAgentBudgetHandler({ circleCli }),
    prepareWalletCreation: createPrepareWalletCreationHandler(
      omitUndefined({
        setupIntents: repositories.setupIntents,
        executorAddress,
        setupWebUrl: config.setupWebUrl ?? DEFAULT_SETUP_WEB_URL,
        productionOnboardingUrl: config.productionOnboardingUrl,
        clock,
        createSetupIntentId: options.createSetupIntentId ?? (() => createSetupIntentId()),
        homeChainId: effectiveHomeChainId,
        setupTtlSeconds: options.setupTtlSeconds,
      }) as PrepareWalletCreationDependencies,
    ),
    checkWalletCreation: createCheckWalletCreationHandler({
      setupIntents: repositories.setupIntents,
      clock,
    }),
    getAgentWallet: createGetAgentWalletHandler({
      wallets: repositories.wallets,
      homeChainId: effectiveHomeChainId,
    } satisfies GetAgentWalletDependencies),
    getBalance: createGetBalanceHandler({
      wallets: repositories.wallets,
      tokenBalances: chainAdapters.tokenBalances,
      nativeBalances: chainAdapters.nativeBalances,
      homeChainId: effectiveHomeChainId,
    }),
    parseInvoicePayment: createParseInvoicePaymentHandler(),
    searchX402Services: createSearchX402ServicesHandler({
      discovery: x402BazaarDiscovery,
    }),
    prepareX402ServiceRequest: createPrepareX402ServiceRequestHandler(),
    parseX402PaymentRequired: createParseX402PaymentRequiredHandler(),
    retryX402Request: createRetryX402RequestHandler({
      paymentIntents: repositories.paymentIntents,
      httpClient: options.x402HttpClient ?? createPinnedX402HttpClient(),
    }),
    prepareContractCall: createPrepareContractCallHandler(
      omitUndefined({
        wallets: repositories.wallets,
        balances: chainAdapters.balances,
        paymentIntents: repositories.paymentIntents,
        clock,
        createId: options.createId ?? (() => createPaymentIntentId()),
        createNonce: options.createNonce ?? (() => createPaymentNonce()),
        homeChainId: effectiveHomeChainId,
        approvalTtlSeconds: options.approvalTtlSeconds,
      }) as PrepareContractCallDependencies,
    ),
    quotePaymentRoute: createQuotePaymentRouteHandler({
      wallets: repositories.wallets,
      routes,
      balances: chainAdapters.balances,
      homeChainId: effectiveHomeChainId,
    } satisfies QuotePaymentRouteDependencies),
    checkRouteTargetAllowance: createCheckRouteTargetAllowanceHandler({
      wallets: repositories.wallets,
      routeTargetAllowances: chainAdapters.routeTargetAllowances,
      homeChainId: effectiveHomeChainId,
    } satisfies CheckRouteTargetAllowanceDependencies),
    prepareAccountAdminTransaction: createPrepareAccountAdminTransactionHandler({
      wallets: repositories.wallets,
      homeChainId: effectiveHomeChainId,
    } satisfies PrepareAccountAdminTransactionDependencies),
    prepareRouteTargetAllowance: createPrepareRouteTargetAllowanceHandler({
      wallets: repositories.wallets,
      homeChainId: effectiveHomeChainId,
    } satisfies PrepareRouteTargetAllowanceDependencies),
    preparePayment: createPreparePaymentHandler(
      omitUndefined({
        wallets: repositories.wallets,
        routes,
        balances: chainAdapters.balances,
        paymentIntents: repositories.paymentIntents,
        clock,
        createId: options.createId ?? (() => createPaymentIntentId()),
        createNonce: options.createNonce ?? (() => createPaymentNonce()),
        homeChainId: effectiveHomeChainId,
        approvalTtlSeconds: options.approvalTtlSeconds,
        tenantId: options.tenantContext?.tenantId,
        setupWebUrl: config.setupWebUrl ?? DEFAULT_SETUP_WEB_URL,
        reviewTokenSecret: config.reviewTokenSecret ?? config.serviceRoleKey,
        paymentReviews: repositories.paymentReviews,
      }) as PreparePaymentDependencies,
    ),
    getPaymentSignature: createGetPaymentSignatureHandler({
      paymentReviews: repositories.paymentReviews,
      paymentIntents: repositories.paymentIntents,
      clock,
    } satisfies GetPaymentSignatureDependencies),
    executePayment: createExecutePaymentHandler(executePaymentDependencies),
    executePaymentWithContext: (input, context) =>
      executePaymentWithOptionalDurability(input, executePaymentDependencies, context),
    preflightPayment: createPreflightPaymentHandler({
      paymentIntents: repositories.paymentIntents,
      balances: chainAdapters.balances,
      authorizedExecutor: chainAdapters.authorizedExecutor,
      clock,
      executionPolicy,
    }),
    paidExecutionLifecycle: repositories.paidExecutionLifecycle,
    paidExecutionChallenge: repositories.paidExecutionChallenge,
    invoiceExecutionOutbox: repositories.invoiceExecutionOutbox,
    canaryLedger: repositories.canaryLedger,
    reconcileInvoiceExecutions: async () => {
      if (!repositories.invoiceExecutionOutbox) {
        return { inspected: 0, pending: 0, finalized: 0, stalled: 0, errors: 0 };
      }
      return reconcileInvoiceExecutionOutbox({
        outbox: repositories.invoiceExecutionOutbox,
        sourceTransactions: chainAdapters.sourceTransactions,
        lifecycle: repositories.paidExecutionLifecycle,
        at: clock().toISOString(),
      });
    },
    executorAddress,
    executeAuthorizedPayment: createExecuteAuthorizedPaymentHandler(executeAuthorizedPaymentDependencies),
    trackPayment: createTrackPaymentHandler({
      paymentIntents: repositories.paymentIntents,
      routeStatuses: routes,
      sourceTransactions: chainAdapters.sourceTransactions,
      clock,
    }),
    listTransactions: createListTransactionsHandler({
      paymentIntents: repositories.paymentIntents,
    }),
    listPaymentEvents: createListPaymentEventsHandler({
      paymentEvents: repositories.paymentEvents,
    }),
  };
}

export function createPaymentIntentId(randomByteSource: (size: number) => Uint8Array = randomBytes): string {
  return `pay_${Buffer.from(randomByteSource(12)).toString("hex")}`;
}

export function createPaymentNonce(randomByteSource: (size: number) => Uint8Array = randomBytes): string {
  return BigInt(`0x${Buffer.from(randomByteSource(16)).toString("hex")}`).toString();
}

export function createSetupIntentId(randomByteSource: (size: number) => Uint8Array = randomBytes): string {
  return `setup_${Buffer.from(randomByteSource(12)).toString("hex")}`;
}

const defaultAgentPayRuntimeFactories: AgentPayRuntimeFactories = {
  createRepositories: createSupabaseAgentPayRepositoriesFromConfig,
  createRoutes(config) {
    return {
      ...createLifiRouteQuoteProvider(config),
      ...createLifiRouteStatusProvider(config),
    };
  },
  createX402BazaarDiscovery: createX402BazaarDiscoveryProvider,
  createChainAdapters: createEthersRuntimeAdapters,
};

function createConfigErrorMessage(missing: string[], invalid: string[]): string {
  const parts = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    invalid.length > 0 ? `invalid: ${invalid.join(", ")}` : undefined,
  ].filter(Boolean);

  return `Invalid AgentPay runtime environment (${parts.join("; ")}).`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSecureReviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackReviewUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseOptionalHomeChainId(value: string | undefined): CeloHomeChainId | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && setupHomeChainIds.has(parsed as CeloHomeChainId)
    ? (parsed as CeloHomeChainId)
    : undefined;
}

function parseCeloRpcUrls(env: Record<string, string | undefined>): Partial<Record<number, string>> | undefined {
  const rpcUrls = omitUndefined({
    42220: env.CELO_MAINNET_RPC_URL,
    11142220: env.CELO_SEPOLIA_RPC_URL,
  }) as Partial<Record<number, string>>;

  return Object.keys(rpcUrls).length > 0 ? rpcUrls : undefined;
}

function parseCeloRpcFallbackUrls(
  env: Record<string, string | undefined>,
): Partial<Record<number, string>> | undefined {
  if (!env.CELO_MAINNET_RPC_FALLBACK_URL) return undefined;
  return {
    [CELO_NETWORKS.mainnet.chainId]: env.CELO_MAINNET_RPC_FALLBACK_URL,
  };
}

function parseStableTokenOverrides(env: Record<string, string | undefined>): StableTokenMetadataOverrides | undefined {
  const celoOverrides = {
    ...(env.AGENTPAY_CELO_USDC_ADDRESS
      ? {
          USDC: {
            address: env.AGENTPAY_CELO_USDC_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_CELO_USDT_ADDRESS
      ? {
          USDT: {
            address: env.AGENTPAY_CELO_USDT_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_CELO_USDM_ADDRESS
      ? {
          USDm: {
            address: env.AGENTPAY_CELO_USDM_ADDRESS,
          },
        }
      : {}),
  };
  const celoSepoliaOverrides = {
    ...(env.AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS
      ? {
          USDC: {
            address: env.AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_CELO_SEPOLIA_USDT_ADDRESS
      ? {
          USDT: {
            address: env.AGENTPAY_CELO_SEPOLIA_USDT_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_CELO_SEPOLIA_USDM_ADDRESS
      ? {
          USDm: {
            address: env.AGENTPAY_CELO_SEPOLIA_USDM_ADDRESS,
          },
        }
      : {}),
  };

  const overrides = omitUndefined({
    42220: Object.keys(celoOverrides).length > 0 ? celoOverrides : undefined,
    11142220: Object.keys(celoSepoliaOverrides).length > 0 ? celoSepoliaOverrides : undefined,
  }) as StableTokenMetadataOverrides;

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function validateStableTokenOverrideAddresses(env: Record<string, string | undefined>): string[] {
  return [
    "AGENTPAY_CELO_USDC_ADDRESS",
    "AGENTPAY_CELO_USDT_ADDRESS",
    "AGENTPAY_CELO_USDM_ADDRESS",
    "AGENTPAY_CELO_SEPOLIA_USDC_ADDRESS",
    "AGENTPAY_CELO_SEPOLIA_USDT_ADDRESS",
    "AGENTPAY_CELO_SEPOLIA_USDM_ADDRESS",
  ].filter((name) => env[name] && !addressPattern.test(env[name]));
}

function requireOptionalCeloHomeChainId(value: number | undefined): CeloHomeChainId | undefined {
  if (value === undefined) return undefined;
  if (setupHomeChainIds.has(value as CeloHomeChainId)) return value as CeloHomeChainId;
  throw new Error(`Unsupported AgentPay Celo home chain ${value}.`);
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}
