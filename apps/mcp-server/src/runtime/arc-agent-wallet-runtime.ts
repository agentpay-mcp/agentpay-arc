import type { ArcAgentWalletMcpRuntime } from "../mcp/agentpay-mcp.ts";
import type { CircleCli } from "../services/circle-cli.ts";
import type { CompliancePaymentGate } from "../services/circle-compliance.ts";
import {
  createArcAgentIdentityHandlers,
  type ArcErc8004Dependencies,
} from "../tools/arc-agent-identity.ts";
import {
  createArcAgentJobHandlers,
  type ArcAgentJobDependencies,
} from "../tools/arc-agent-jobs.ts";
import {
  bridgeUsdc,
  fundFromAnyChain,
  getUnifiedBalance,
  swapAndPay,
  swapTokens,
  type ArcLiquidityDependencies,
} from "../tools/arc-liquidity.ts";
import {
  createArcPaymentExecutor,
  createBatchPayoutHandler,
  createSendUsdcHandler,
  type ArcPaymentRepository,
} from "../tools/arc-payments.ts";
import {
  createInspectPaidServiceHandler,
  createPayPaidServiceHandler,
  createSearchPaidServicesHandler,
  type ArcAgentCommerceRepository,
} from "../tools/circle-services.ts";
import {
  createFundAgentWalletHandler,
  createGetAgentBudgetHandler,
  createSetupAgentWalletHandler,
  createWithdrawAgentBudgetHandler,
} from "../tools/circle-agent-wallet.ts";
import {
  createCreatePaymentRequestHandler,
  createPayInvoiceHandler,
  type ArcPaymentRequestRepository,
} from "../tools/invoice.ts";
import {
  createGetPaymentReceiptHandler,
  createListAgentActivityHandler,
  type ArcAgentActivityRepository,
  type ArcPaymentReceiptRepository,
} from "../tools/payment-tracking.ts";

export interface ArcAgentWalletRuntimeDependencies {
  readonly circleCli: CircleCli;
  readonly payments: ArcPaymentRepository;
  readonly paymentRequests: ArcPaymentRequestRepository;
  readonly activity: ArcAgentActivityRepository;
  readonly receipts: ArcPaymentReceiptRepository;
  readonly commerce: ArcAgentCommerceRepository;
  readonly liquidity: Omit<ArcLiquidityDependencies, "circleCli">;
  readonly identity: Omit<ArcErc8004Dependencies, "circleCli">;
  readonly jobs: Omit<ArcAgentJobDependencies, "circleCli" | "now">;
  readonly compliance: CompliancePaymentGate;
  readonly clock?: () => Date;
}

/**
 * Composes the complete local Arc Agent Wallet runtime from explicit adapters.
 *
 * There is intentionally no tenant argument: this process runs beside the
 * user's authenticated Circle CLI session and its persistence adapter owns the
 * local authority boundary. Hosted tenant/session composition remains a
 * separate runtime and cannot reach these handlers.
 */
export function createArcAgentWalletRuntime(
  dependencies: ArcAgentWalletRuntimeDependencies,
): ArcAgentWalletMcpRuntime {
  const clock = dependencies.clock ?? (() => new Date());
  const paymentDependencies = {
    circleCli: dependencies.circleCli,
    payments: dependencies.payments,
    compliance: dependencies.compliance,
    clock,
  };
  const paymentExecutor = createArcPaymentExecutor(paymentDependencies);
  const liquidityDependencies: ArcLiquidityDependencies = {
    ...dependencies.liquidity,
    circleCli: dependencies.circleCli,
  };
  const identityHandlers = createArcAgentIdentityHandlers({
    ...dependencies.identity,
    circleCli: dependencies.circleCli,
  });
  const jobHandlers = createArcAgentJobHandlers({
    ...dependencies.jobs,
    circleCli: dependencies.circleCli,
    now: () => Math.floor(clock().getTime() / 1_000),
  });
  const listAgentActivityHandler = createListAgentActivityHandler({
    activity: dependencies.activity,
  });
  const getPaymentReceiptHandler = createGetPaymentReceiptHandler({
    receipts: dependencies.receipts,
  });

  return {
    setupAgentWallet: createSetupAgentWalletHandler({
      circleCli: dependencies.circleCli,
    }),
    getAgentBudget: createGetAgentBudgetHandler({
      circleCli: dependencies.circleCli,
    }),
    fundAgentWallet: createFundAgentWalletHandler({
      circleCli: dependencies.circleCli,
    }),
    withdrawAgentBudget: createWithdrawAgentBudgetHandler({
      circleCli: dependencies.circleCli,
    }),
    sendUsdc: createSendUsdcHandler(paymentDependencies),
    createPaymentRequest: createCreatePaymentRequestHandler({
      paymentRequests: dependencies.paymentRequests,
      clock,
    }),
    payInvoice: createPayInvoiceHandler({
      paymentRequests: dependencies.paymentRequests,
      paymentExecutor,
      clock,
    }),
    batchPayout: createBatchPayoutHandler(paymentDependencies),
    listAgentActivity: (input) =>
      listAgentActivityHandler(
        input as Parameters<typeof listAgentActivityHandler>[0],
      ),
    getPaymentReceipt: (input) =>
      getPaymentReceiptHandler(
        input as Parameters<typeof getPaymentReceiptHandler>[0],
      ),
    searchPaidServices: createSearchPaidServicesHandler({
      circleCli: dependencies.circleCli,
    }),
    inspectPaidService: createInspectPaidServiceHandler({
      circleCli: dependencies.circleCli,
      clock,
    }),
    payPaidService: createPayPaidServiceHandler({
      circleCli: dependencies.circleCli,
      commerce: dependencies.commerce,
      compliance: dependencies.compliance,
      clock,
    }),
    getUnifiedBalance: (input) =>
      getUnifiedBalance(input, liquidityDependencies),
    fundFromAnyChain: (input) =>
      fundFromAnyChain(input, liquidityDependencies),
    bridgeUsdc: (input) =>
      bridgeUsdc(input, liquidityDependencies),
    swapTokens: (input) =>
      swapTokens(input, liquidityDependencies),
    swapAndPay: (input) =>
      swapAndPay(input, liquidityDependencies),
    registerAgentIdentity: identityHandlers.registerAgentIdentity,
    getAgentIdentity: identityHandlers.getAgentIdentity,
    giveAgentFeedback: identityHandlers.giveAgentFeedback,
    requestAgentValidation: identityHandlers.requestAgentValidation,
    respondAgentValidation: identityHandlers.respondAgentValidation,
    getAgentTrust: identityHandlers.getAgentTrust,
    createAgentJob: jobHandlers.createAgentJob,
    setAgentJobBudget: jobHandlers.setAgentJobBudget,
    fundAgentJob: jobHandlers.fundAgentJob,
    submitAgentDeliverable: jobHandlers.submitAgentDeliverable,
    completeAgentJob: jobHandlers.completeAgentJob,
    rejectAgentJob: jobHandlers.rejectAgentJob,
    getAgentJob: jobHandlers.getAgentJob,
  };
}
