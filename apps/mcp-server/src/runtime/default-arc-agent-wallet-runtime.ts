import { homedir } from "node:os";
import { join } from "node:path";

import {
  createArcAgentJobViemReaders,
  type ArcAgentJobViemReaders,
} from "../services/arc-agent-jobs-viem.ts";
import {
  createArcAppKitService,
  type ArcAppKitService,
} from "../services/arc-app-kit.ts";
import {
  createArcErc8004ViemReaders,
  type ArcErc8004ViemReaders,
} from "../services/arc-erc8004-viem.ts";
import { createArcLocalStateRepositories } from "../services/arc-local-state.ts";
import { createArcSwapSettlementViemVerifier } from "../services/arc-swap-settlement-viem.ts";
import { createCircleCli, type CircleCli } from "../services/circle-cli.ts";
import { createCircleComplianceGate } from "../services/circle-compliance.ts";
import type {
  SwapPaymentExecutor,
  SwapSettlementVerifier,
} from "../tools/arc-liquidity.ts";
import { createArcPaymentExecutor } from "../tools/arc-payments.ts";
import {
  createArcAgentWalletRuntime,
  type ArcAgentWalletRuntimeDependencies,
} from "./arc-agent-wallet-runtime.ts";

export interface DefaultArcAgentWalletRuntimeOptions {
  readonly statePath?: string;
  readonly circleCli?: CircleCli;
  readonly appKit?: ArcAppKitService;
  readonly settlementVerifier?: SwapSettlementVerifier;
  readonly identityReaders?: ArcErc8004ViemReaders;
  readonly jobReaders?: ArcAgentJobViemReaders;
  readonly clock?: () => Date;
}

/**
 * Builds the config-free, user-owned Arc runtime used by `agent-wallet-mcp`.
 *
 * Circle CLI owns wallet authentication and signing. AgentPay owns only the
 * local operation ledger at ~/.agentpay/arc-state.json; no tenant identifier,
 * private key, or hosted service credential is accepted by this factory.
 */
export function createDefaultArcAgentWalletRuntime(
  options: DefaultArcAgentWalletRuntimeOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const circleCli = options.circleCli ?? createCircleCli();
  const state = createArcLocalStateRepositories({
    filePath: options.statePath ?? join(homedir(), ".agentpay", "arc-state.json"),
  });
  const compliance = createCircleComplianceGate({
    mode: "DISABLED",
    evidence: state.compliance,
    clock,
  });
  const directPayments = createArcPaymentExecutor({
    circleCli,
    payments: state.payments,
    compliance,
    clock,
  });
  const paymentExecutor: SwapPaymentExecutor = {
    async pay(input) {
      const result = await directPayments.sendUsdc(input);
      if (result.status !== "COMPLETED") {
        throw new Error(
          "Swap payment was submitted but is not yet confirmed; reconciliation is required.",
        );
      }
      return {
        transactionHash: result.receipt.transactionHash,
        transactionId: result.receipt.transactionId,
      };
    },
  };
  const identityReaders =
    options.identityReaders ?? createArcErc8004ViemReaders();
  const jobReaders = options.jobReaders ?? createArcAgentJobViemReaders();

  const dependencies: ArcAgentWalletRuntimeDependencies = {
    circleCli,
    payments: state.payments,
    paymentRequests: state.paymentRequests,
    activity: state.activity,
    receipts: state.receipts,
    commerce: state.commerce,
    liquidity: {
      appKit: options.appKit ?? createArcAppKitService({ clock }),
      operations: state.liquidity,
      settlementVerifier:
        options.settlementVerifier ?? createArcSwapSettlementViemVerifier(),
      paymentExecutor,
      clock,
    },
    identity: {
      ...identityReaders,
      evidence: state.identity,
    },
    jobs: {
      ...jobReaders,
      repository: state.jobs,
    },
    compliance,
    clock,
  };

  return createArcAgentWalletRuntime(dependencies);
}
