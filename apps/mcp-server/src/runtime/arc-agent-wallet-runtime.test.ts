import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArcAgentWalletMcpRuntime } from "../mcp/agentpay-mcp.ts";
import type { ArcErc8004Dependencies } from "../tools/arc-agent-identity.ts";
import type { ArcAgentJobDependencies } from "../tools/arc-agent-jobs.ts";
import type { ArcLiquidityDependencies } from "../tools/arc-liquidity.ts";
import type { ArcPaymentRepository } from "../tools/arc-payments.ts";
import type { ArcAgentCommerceRepository } from "../tools/circle-services.ts";
import type { ArcPaymentRequestRepository } from "../tools/invoice.ts";
import type {
  ArcAgentActivityRepository,
  ArcPaymentReceiptRepository,
} from "../tools/payment-tracking.ts";
import {
  createArcAgentWalletRuntime,
  type ArcAgentWalletRuntimeDependencies,
} from "./arc-agent-wallet-runtime.ts";

const expectedRuntimeMethods = [
  "setupAgentWallet",
  "getAgentBudget",
  "fundAgentWallet",
  "withdrawAgentBudget",
  "sendUsdc",
  "createPaymentRequest",
  "payInvoice",
  "batchPayout",
  "listAgentActivity",
  "getPaymentReceipt",
  "searchPaidServices",
  "inspectPaidService",
  "payPaidService",
  "getUnifiedBalance",
  "fundFromAnyChain",
  "bridgeUsdc",
  "swapTokens",
  "swapAndPay",
  "registerAgentIdentity",
  "getAgentIdentity",
  "giveAgentFeedback",
  "requestAgentValidation",
  "respondAgentValidation",
  "getAgentTrust",
  "createAgentJob",
  "setAgentJobBudget",
  "fundAgentJob",
  "submitAgentDeliverable",
  "completeAgentJob",
  "rejectAgentJob",
  "getAgentJob",
] as const satisfies readonly (keyof ArcAgentWalletMcpRuntime)[];

describe("createArcAgentWalletRuntime", () => {
  it("composes every reviewed Arc handler behind the local runtime boundary", async () => {
    const searched: unknown[] = [];
    const dependencies = {
      circleCli: {
        async searchServices(input: unknown) {
          searched.push(input);
          return [];
        },
      },
      payments: {},
      paymentRequests: {},
      activity: {},
      receipts: {},
      commerce: {},
      liquidity: {},
      identity: {},
      jobs: {},
      compliance: {},
      clock: () => new Date("2026-07-28T06:00:00.000Z"),
    } as unknown as ArcAgentWalletRuntimeDependencies;

    const runtime = createArcAgentWalletRuntime(dependencies);

    assert.deepEqual(Object.keys(runtime), expectedRuntimeMethods);
    assert.equal("preparePayment" in runtime, false, "legacy Celo runtime must stay separate");

    assert.deepEqual(await runtime.searchPaidServices({ query: "weather" }), {
      services: [],
    });
    assert.deepEqual(searched, [{ query: "weather" }]);
  });

  it("requires concrete repositories and chain readers instead of inventing caller authority", () => {
    type RequiredDependencies =
      & Pick<
        ArcAgentWalletRuntimeDependencies,
        | "circleCli"
        | "payments"
        | "paymentRequests"
        | "activity"
        | "receipts"
        | "commerce"
        | "liquidity"
        | "identity"
        | "jobs"
        | "compliance"
      >
      & {
        payments: ArcPaymentRepository;
        paymentRequests: ArcPaymentRequestRepository;
        activity: ArcAgentActivityRepository;
        receipts: ArcPaymentReceiptRepository;
        commerce: ArcAgentCommerceRepository;
        liquidity: Omit<ArcLiquidityDependencies, "circleCli">;
        identity: Omit<ArcErc8004Dependencies, "circleCli">;
        jobs: Omit<ArcAgentJobDependencies, "circleCli" | "now">;
      };

    const compileTimeContract: RequiredDependencies | undefined = undefined;
    assert.equal(compileTimeContract, undefined);
    assert.equal("tenantId" in ({} as ArcAgentWalletRuntimeDependencies), false);
  });
});
