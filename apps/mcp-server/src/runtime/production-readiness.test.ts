import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { PaymentIntentRecord } from "@agentpay-ai/shared-arc";

import {
  MAINNET_USDC_ADDRESS,
  MAINNET_MIGRATION_HEAD,
  assertProductionExecutionAllowed,
  computeManifestSha256,
  evaluateProductionReadiness,
  validateProductionEnvironment,
  type RuntimeEnvironmentIdentity,
} from "./production-readiness.ts";

const baseManifest = JSON.parse(
  await readFile(new URL("../../../../test/fixtures/celo-mainnet.shadow.json", import.meta.url), "utf8"),
) as Record<string, any>;

function productionEnv(): Record<string, string> {
  return {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_HOME_CHAIN_ID: "42220",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    CELO_MAINNET_RPC_URL: "https://rpc.provider.example/celo",
    CELO_MAINNET_RPC_FALLBACK_URL: "https://forno.celo.org",
    SUPABASE_PRODUCTION_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "service-role-key",
    DIRECT_URL_PRODUCTION: "postgresql://production.example.invalid/postgres",
    AGENTPAY_RAW_TX_ENCRYPTION_KEY: "a".repeat(64),
    AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
    AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
    AGENTPAY_CONSUMER_MCP_URL: "https://wallet.agentpay.site/celo/mcp",
    AGENTPAY_PAID_MCP_URL: "https://mcp.agentpay.site/celo/mcp",
    AGENTPAY_PUBLIC_SETUP_URL: "https://wallet.agentpay.site/celo/setup",
    AGENTPAY_PUBLIC_REVIEW_URL: "https://wallet.agentpay.site/celo/review",
    AGENTPAY_ONBOARDING_MANIFEST_PATH: "/run/agentpay-celo/onboarding.json",
    AGENTPAY_ONBOARDING_MANIFEST_SHA256: "a".repeat(64),
    AGENTPAY_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    AGENTPAY_FACTORY_RUNTIME_CODE_HASH: `0x${"2".repeat(64)}`,
    AGENTPAY_SETUP_SPONSOR_ADDRESS: "0x3333333333333333333333333333333333333333",
    AGENTPAY_SETUP_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    AGENTPAY_SETUP_MODE: "PUBLIC",
    CELO_ATTRIBUTION_TAG: "celo_agentpay",
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
    chainId: 42220,
    caip2: "eip155:42220",
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
    facilitatorRef: "https://api.x402.celo.org",
    executionMode: "PUBLIC",
    status: "READY",
  };
}

const exactPaymentConfig = {
  enabled: true,
  payTo: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  price: "$0.01",
  network: "eip155:42220" as const,
  asset: MAINNET_USDC_ADDRESS,
  assetDecimals: 6,
  syncSettle: true,
  facilitatorUrl: "https://api.x402.celo.org",
  facilitatorApiKey: "test-celo-x402-api-key",
  resourceUrl: "https://mcp.agentpay.site/celo/mcp",
};

describe("production readiness gate", () => {
  it("pins production readiness to the atomic payment audit migration", () => {
    assert.equal(MAINNET_MIGRATION_HEAD, "20260721160000_celo_x402_settlement_audit");
    assert.equal(baseManifest.database.migrationHead, MAINNET_MIGRATION_HEAD);
    assert.equal(baseManifest.release.migrationHead, MAINNET_MIGRATION_HEAD);
  });

  it("requires explicit production aliases and rejects generic or staging boundaries", () => {
    const valid = validateProductionEnvironment(productionEnv());
    assert.equal(valid.valid, true, valid.errors.join("; "));
    assert.deepEqual(baseManifest.attribution, {
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

  it("requires the isolated Celo onboarding identity and canonical public routes", () => {
    const valid = validateProductionEnvironment(productionEnv());
    assert.equal(valid.valid, true, valid.errors.join("; "));

    const missing = productionEnv();
    delete missing.AGENTPAY_FACTORY_ADDRESS;
    delete missing.AGENTPAY_SETUP_SPONSOR_ADDRESS;
    delete missing.AGENTPAY_ONBOARDING_MANIFEST_SHA256;
    delete missing.AGENTPAY_SETUP_SUPABASE_PROJECT_REF;
    delete missing.CELO_MAINNET_RPC_FALLBACK_URL;
    delete missing.CELO_ATTRIBUTION_TAG;
    const missingResult = validateProductionEnvironment(missing);
    assert.equal(missingResult.valid, false);
    assert.match(
      missingResult.errors.join("; "),
      /AGENTPAY_FACTORY_ADDRESS|AGENTPAY_SETUP_SPONSOR_ADDRESS|AGENTPAY_ONBOARDING_MANIFEST_SHA256|AGENTPAY_SETUP_SUPABASE_PROJECT_REF|CELO_MAINNET_RPC_FALLBACK_URL|CELO_ATTRIBUTION_TAG/,
    );

    const drift = productionEnv();
    drift.AGENTPAY_PUBLIC_SETUP_URL = "https://celo.agentpay.site/setup";
    drift.AGENTPAY_CONSUMER_MCP_URL = "https://wallet.agentpay.site/mcp";
    drift.CELO_MAINNET_RPC_URL = "http://127.0.0.1:8545";
    drift.CELO_MAINNET_RPC_FALLBACK_URL = "https://rpc.example.com";
    drift.AGENTPAY_SETUP_SUPABASE_PROJECT_REF = "differentprojectrefx";
    drift.CELO_ATTRIBUTION_TAG = "agentpay";
    const driftResult = validateProductionEnvironment(drift);
    assert.equal(driftResult.valid, false);
    assert.match(driftResult.errors.join("; "), /PUBLIC_SETUP_URL|CONSUMER_MCP_URL|RPC|project|attribution/i);
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
      sourceChainId: 42220,
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

  it("rejects the hosted Celo facilitator when its API key is missing", async () => {
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
    assert.match(result.errors.join("; "), /CELO_X402_API_KEY/i);
  });

  it("rejects facilitator URL drift from the hosted Celo mainnet service", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: readyManifest(),
      identity: identityFor(readyManifest()),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: {
        ...exactPaymentConfig,
        facilitatorUrl: "https://facilitator.example.com",
      },
      onboardingReady: true,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /facilitator URL must be https:\/\/api\.x402\.celo\.org/i);
  });

  it("rejects paid MCP resource URL drift from the external Celo route", async () => {
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
    assert.match(result.errors.join("; "), /resource URL must be https:\/\/mcp\.agentpay\.site\/celo\/mcp/i);
  });
});
