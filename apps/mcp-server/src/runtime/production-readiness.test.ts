import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { PaymentIntentRecord } from "@agentpay-ai/shared-arc";

import {
  ARC_CAIP2,
  ARC_CHAIN_ID,
  ARC_CONSUMER_MCP_URL,
  ARC_PAID_MCP_URL,
  ARC_SETUP_URL,
  ARC_USDC_ADDRESS,
  ARC_USDC_CODE_HASH,
  MAINNET_MIGRATION_HEAD,
  assertProductionExecutionAllowed,
  computeManifestSha256,
  evaluateProductionReadiness,
  validateProductionEnvironment,
  type RuntimeEnvironmentIdentity,
} from "./production-readiness.ts";

const frozenCeloManifest = JSON.parse(
  await readFile(new URL("../../../../test/fixtures/celo-mainnet.shadow.json", import.meta.url), "utf8"),
) as Record<string, any>;
const baseManifest = toArcManifest(frozenCeloManifest);

function toArcManifest(source: Record<string, any>): Record<string, any> {
  const manifest = structuredClone(source);
  manifest.chain = {
    chainId: ARC_CHAIN_ID,
    caip2: ARC_CAIP2,
    rpcEnvRef: "ARC_TESTNET_RPC_URL",
  };
  manifest.contract.domain.chainId = ARC_CHAIN_ID;
  manifest.contract.allowedTokens = [ARC_USDC_ADDRESS];
  manifest.token.address = ARC_USDC_ADDRESS;
  manifest.token.codeHash = ARC_USDC_CODE_HASH;
  manifest.x402.network = ARC_CAIP2;
  manifest.x402.tokenAddress = ARC_USDC_ADDRESS;
  manifest.x402.facilitatorUrl = "https://facilitator.example.com";
  manifest.onboarding.setupUrl = ARC_SETUP_URL;
  manifest.onboarding.readinessUrl = `${ARC_SETUP_URL}/readyz`;
  delete manifest.attribution;
  return manifest;
}

function productionEnv(): Record<string, string> {
  return {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_HOME_CHAIN_ID: "5042002",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
    SUPABASE_PRODUCTION_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "service-role-key",
    DIRECT_URL_PRODUCTION: "postgresql://production.example.invalid/postgres",
    AGENTPAY_RAW_TX_ENCRYPTION_KEY: "a".repeat(64),
    AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
    AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
    AGENTPAY_CONSUMER_MCP_URL: ARC_CONSUMER_MCP_URL,
    AGENTPAY_PAID_MCP_URL: ARC_PAID_MCP_URL,
    AGENTPAY_PUBLIC_SETUP_URL: ARC_SETUP_URL,
    AGENTPAY_PUBLIC_REVIEW_URL: "https://wallet.agentpay.site/arc/review",
    AGENTPAY_ONBOARDING_MANIFEST_PATH: "/run/agentpay-arc/onboarding.json",
    AGENTPAY_ONBOARDING_MANIFEST_SHA256: "a".repeat(64),
    AGENTPAY_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    AGENTPAY_FACTORY_RUNTIME_CODE_HASH: `0x${"2".repeat(64)}`,
    AGENTPAY_SETUP_SPONSOR_ADDRESS: "0x3333333333333333333333333333333333333333",
    AGENTPAY_SETUP_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    AGENTPAY_SETUP_MODE: "PUBLIC",
  };
}

function readyManifest(): Record<string, any> {
  const manifest = structuredClone(baseManifest);
  const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const owner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const executor = `0x${"c".repeat(40)}`;
  const deployer = `0x${"d".repeat(40)}`;
  const runtimeHash = `0x${"11".repeat(32)}`;
  const abiHash = "22".repeat(32);

  manifest.status = "READY";
  manifest.executionMode = "PUBLIC";
  manifest.database.projectRef = "abcdefghijklmnopqrst";
  manifest.release.commit = "a".repeat(40);
  manifest.release.runtimeBytecodeKeccak256 = runtimeHash;
  manifest.release.abiSha256 = abiHash;
  manifest.contract.address = address;
  manifest.contract.deploymentTxHash = `0x${"44".repeat(32)}`;
  manifest.contract.runtimeBytecodeHash = runtimeHash;
  manifest.contract.ownerAddress = owner;
  manifest.contract.executorAddress = executor;
  manifest.contract.deployerAddress = deployer;
  manifest.contract.domain.verifyingContract = address;
  manifest.domains.publicOrigin = "https://wallet.agentpay.site";
  manifest.x402.enabled = true;
  return manifest;
}

function identityFor(manifest: Record<string, any>): RuntimeEnvironmentIdentity {
  return {
    id: 1,
    environment: "production",
    chainId: ARC_CHAIN_ID,
    caip2: ARC_CAIP2,
    supabaseProjectRef: "abcdefghijklmnopqrst",
    migrationHead: manifest.database.migrationHead,
    releaseCommit: manifest.release.commit,
    manifestSha256: computeManifestSha256(manifest),
    accountVersion: "v2",
    accountAddress: manifest.contract.address,
    deploymentTxHash: manifest.contract.deploymentTxHash,
    creationBytecodeHash: manifest.contract.creationBytecodeHash,
    runtimeBytecodeHash: manifest.contract.runtimeBytecodeHash,
    abiSha256: manifest.release.abiSha256,
    ownerAddress: manifest.contract.ownerAddress,
    executorAddress: manifest.contract.executorAddress,
    deployerAddress: manifest.contract.deployerAddress,
    eip712VerifyingContract: manifest.contract.domain.verifyingContract,
    tokenAddress: manifest.token.address,
    tokenCodeHash: manifest.token.codeHash,
    tokenDecimals: manifest.token.decimals,
    x402Network: manifest.x402.network,
    x402Asset: manifest.x402.tokenAddress,
    x402Price: manifest.x402.price,
    x402PriceAtomic: manifest.x402.priceAtomic,
    x402SyncSettle: manifest.x402.syncSettle,
    x402Enabled: manifest.x402.enabled,
    payToAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    facilitatorRef: "https://facilitator.example.com",
    executionMode: "PUBLIC",
    status: "READY",
  };
}

const exactPaymentConfig = {
  enabled: true,
  payTo: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  price: "$0.01",
  network: ARC_CAIP2,
  asset: ARC_USDC_ADDRESS,
  assetDecimals: 6,
  syncSettle: true,
  facilitatorUrl: "https://facilitator.example.com",
  facilitatorApiKey: "test-arc-x402-api-key",
  resourceUrl: ARC_PAID_MCP_URL,
};

describe("production readiness gate", () => {
  it("pins the public runtime identity to Arc Testnet and canonical USDC", () => {
    assert.equal(ARC_CHAIN_ID, 5042002);
    assert.equal(ARC_CAIP2, "eip155:5042002");
    assert.equal(ARC_USDC_ADDRESS, "0x3600000000000000000000000000000000000000");
    assert.equal(ARC_USDC_CODE_HASH, "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d");
    assert.equal(ARC_CONSUMER_MCP_URL, "https://wallet.agentpay.site/arc/mcp");
    assert.equal(ARC_PAID_MCP_URL, "https://mcp.agentpay.site/arc/mcp");
    assert.equal(ARC_SETUP_URL, "https://wallet.agentpay.site/arc/setup");
  });
  it("pins production readiness to the atomic payment audit migration", () => {
    assert.equal(MAINNET_MIGRATION_HEAD, "20260721160000_celo_x402_settlement_audit");
    assert.equal(baseManifest.database.migrationHead, MAINNET_MIGRATION_HEAD);
    assert.equal(baseManifest.release.migrationHead, MAINNET_MIGRATION_HEAD);
  });

  it("requires explicit production aliases and rejects generic or staging boundaries", () => {
    const valid = validateProductionEnvironment(productionEnv());
    assert.equal(valid.valid, true, valid.errors.join("; "));
    assert.deepEqual(frozenCeloManifest.attribution, {
      standard: "ERC-8021",
      tagEnvRef: "CELO_ATTRIBUTION_TAG",
      appliesTo: ["agentpay-direct-transactions"],
      excludes: ["x402-facilitator-settlements"],
    });

    const invalid = productionEnv();
    invalid.CELO_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";
    invalid.CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";
    invalid.SUPABASE_URL = "https://qwywcungxmhoctmehcze.supabase.co";
    invalid.AGENTPAY_A2MCP_PAYMENT_ENABLED = "true";
    assert.equal(validateProductionEnvironment(invalid).valid, false);
    assert.match(validateProductionEnvironment(invalid).errors.join("; "), /CELO_RPC_URL|SUPABASE_URL|testnet/i);

  });

  it("requires the isolated Arc onboarding identity and canonical public routes", () => {
    const valid = validateProductionEnvironment(productionEnv());
    assert.equal(valid.valid, true, valid.errors.join("; "));

    const missing = productionEnv();
    delete missing.AGENTPAY_FACTORY_ADDRESS;
    delete missing.AGENTPAY_SETUP_SPONSOR_ADDRESS;
    delete missing.AGENTPAY_ONBOARDING_MANIFEST_SHA256;
    delete missing.AGENTPAY_SETUP_SUPABASE_PROJECT_REF;
    delete missing.ARC_TESTNET_RPC_URL;
    const missingResult = validateProductionEnvironment(missing);
    assert.equal(missingResult.valid, false);
    assert.match(
      missingResult.errors.join("; "),
      /AGENTPAY_FACTORY_ADDRESS|AGENTPAY_SETUP_SPONSOR_ADDRESS|AGENTPAY_ONBOARDING_MANIFEST_SHA256|AGENTPAY_SETUP_SUPABASE_PROJECT_REF|ARC_TESTNET_RPC_URL/,
    );

    const drift = productionEnv();
    drift.AGENTPAY_PUBLIC_SETUP_URL = "https://arc.invalid/setup";
    drift.AGENTPAY_CONSUMER_MCP_URL = "https://wallet.agentpay.site/mcp";
    drift.ARC_TESTNET_RPC_URL = "http://127.0.0.1:8545";
    drift.AGENTPAY_SETUP_SUPABASE_PROJECT_REF = "differentprojectrefx";
    const driftResult = validateProductionEnvironment(drift);
    assert.equal(driftResult.valid, false);
    assert.match(driftResult.errors.join("; "), /PUBLIC_SETUP_URL|CONSUMER_MCP_URL|RPC|project/i);
  });

  it("keeps a shadow/OFF manifest unavailable for production execution", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: structuredClone(baseManifest),
      identity: null,
      accountVerification: null,
      paymentConfig: undefined,
    });

    assert.equal(result.ready, false);
    assert.equal(result.mode, "OFF");
    assert.equal(result.executionAllowed, false);
    assert.match(result.errors.join("; "), /shadow|identity|account/i);
  });

  it("rejects a singleton identity mismatch instead of trusting process env", async () => {
    const manifest = readyManifest();
    const identity = identityFor(manifest);
    identity.manifestSha256 = "0".repeat(64);

    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: exactPaymentConfig,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /manifest.*digest|identity/i);
  });

  it("accepts a fully observed READY/PUBLIC identity and exact payment config", async () => {
    const manifest = readyManifest();
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
      onboardingReady: true,
    });

    assert.equal(result.ready, true, result.errors.join("; "));
    assert.equal(result.executionAllowed, true);
    assert.equal(result.publicPaymentAllowed, true);

    const missingRawTransactionKey = productionEnv();
    delete missingRawTransactionKey.AGENTPAY_RAW_TX_ENCRYPTION_KEY;
    const missingKeyResult = await evaluateProductionReadiness({
      env: missingRawTransactionKey,
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
      onboardingReady: true,
    });
    assert.equal(missingKeyResult.ready, false);
    assert.match(missingKeyResult.errors.join("; "), /RAW_TX_ENCRYPTION_KEY/i);
  });

  it("rejects onboarding mode drift from the effective production execution mode", async () => {
    const manifest = readyManifest();
    const result = await evaluateProductionReadiness({
      env: { ...productionEnv(), AGENTPAY_SETUP_MODE: "CANARY" },
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
      onboardingReady: true,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /onboarding mode.*production execution mode/i);
  });

  it("keeps CANARY fail-closed until the durable admission probe passes", async () => {
    const manifest = readyManifest();
    manifest.executionMode = "CANARY";
    const identity = identityFor(manifest);
    identity.executionMode = "CANARY";

    const result = await evaluateProductionReadiness({
      env: { ...productionEnv(), AGENTPAY_EXECUTION_MODE: "CANARY", AGENTPAY_SETUP_MODE: "CANARY" },
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
    });

    assert.equal(result.executionAllowed, false);
    assert.match(result.errors.join("; "), /durable Supabase ledger|allowlist/i);
  });

  it("allows CANARY only when the durable admission probe is explicitly green", async () => {
    const manifest = readyManifest();
    manifest.executionMode = "CANARY";
    const identity = identityFor(manifest);
    identity.executionMode = "CANARY";

    const result = await evaluateProductionReadiness({
      env: { ...productionEnv(), AGENTPAY_EXECUTION_MODE: "CANARY", AGENTPAY_SETUP_MODE: "CANARY" },
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
      canaryAdmissionReady: true,
      onboardingReady: true,
    });

    assert.equal(result.ready, true, result.errors.join("; "));
    assert.equal(result.executionAllowed, true);
    assert.equal(result.publicPaymentAllowed, true);
  });

  it("rejects payment drift and disallows non-direct production intents", async () => {
    const manifest = readyManifest();
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: { ...exactPaymentConfig, network: "eip155:1952", syncSettle: false },
    });
    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /network|sync/i);

    const routeIntent = {
      id: "pay_route",
      sourceChainId: ARC_CHAIN_ID,
      destinationChainId: 8453,
      sourceTokenSymbol: "USDC",
      destinationTokenSymbol: "USDC",
      sourceTokenAddress: manifest.token.address,
      destinationTokenAddress: "0x1111111111111111111111111111111111111111",
      routeProvider: "LI.FI",
    } as unknown as PaymentIntentRecord;
    assert.throws(
      () => assertProductionExecutionAllowed({ mode: "PUBLIC", environment: "production", directMainnetOnly: true }, routeIntent),
      /direct|mainnet|production/i,
    );
  });

  it("keeps CANARY and PUBLIC fail-closed until live onboarding readiness passes", async () => {
    const manifest = readyManifest();
    const input = {
      env: productionEnv(),
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: exactPaymentConfig,
    };

    const unavailable = await evaluateProductionReadiness(input);
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.checks.onboarding, false);
    assert.match(unavailable.errors.join("; "), /onboarding.*readiness/i);

    const available = await evaluateProductionReadiness({ ...input, onboardingReady: true });
    assert.equal(available.ready, true, available.errors.join("; "));
    assert.equal(available.checks.onboarding, true);
  });

  it("rejects the facilitator when its API key is missing", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: readyManifest(),
      identity: identityFor(readyManifest()),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: {
        ...exactPaymentConfig,
        facilitatorApiKey: undefined,
      },
      onboardingReady: true,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /facilitator API key/i);
  });

  it("rejects a non-HTTPS facilitator URL", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: readyManifest(),
      identity: identityFor(readyManifest()),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: {
        ...exactPaymentConfig,
        facilitatorUrl: "http://facilitator.example.com",
      },
      onboardingReady: true,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /facilitator URL must be an HTTPS URL/i);
  });

  it("rejects paid MCP resource URL drift from the Arc route", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: readyManifest(),
      identity: identityFor(readyManifest()),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: {
        ...exactPaymentConfig,
        resourceUrl: "https://mcp.agentpay.site/mcp",
      },
      onboardingReady: true,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /resource URL must be https:\/\/mcp\.agentpay\.site\/arc\/mcp/i);
  });
});
