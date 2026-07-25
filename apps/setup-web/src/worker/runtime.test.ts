import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Wallet, keccak256 } from "ethers";

import { MAINNET_SETUP_USDC } from "@agentpay-ai/shared-arc";
import {
  assertProductionSetupWorkerChainId,
  parseProductionSetupWorkerConfig,
  readProductionSetupWorkerScopedToken,
} from "./runtime.ts";

const signer = new Wallet(`0x${"09".repeat(32)}`);
const factory = "0x3333333333333333333333333333333333333333";
const executor = "0x2222222222222222222222222222222222222222";
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const nowUnix = 1_800_000_000;

function token(role: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: nowUnix + 3600 })}.signature`;
}

function fixture() {
  const artifact = {
    bytecode: `0x${"60".repeat(80)}`,
    immutableReferences: [{ start: 20, length: 20 }],
    creationCodeHash: hash("5"),
    runtimeTemplateHash: keccak256(`0x${"60".repeat(80)}`),
  };
  const manifest = {
    environment: "production", chainId: 42220, setupMode: "PUBLIC",
    onboardingOrigin: "https://wallet.agentpay.site",
    factory: { address: factory, deploymentTxHash: hash("8"), deploymentBlock: 100,
      runtimeCodeHash: hash("3"), executor, usdc: MAINNET_SETUP_USDC,
      policyVersion: "0x7ca42c75d0d0ce25c514495482839ca84b4d4e3e445080004653e98bdebeb16c" },
    account: { creationCodeHash: artifact.creationCodeHash, runtimeTemplateHash: artifact.runtimeTemplateHash,
      immutableReferences: artifact.immutableReferences, routeTargets: [] },
    sponsor: { deployerAddress: signer.address, maxDeploymentsPerDay: 10, maxNativeCostPerDayWei: "1000000000000000000",
      maxGasPerDeployment: 2000000, maxPending: 4 },
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const digest = createHash("sha256").update(canonical(manifest)).digest("hex");
  const env = {
    AGENTPAY_ENVIRONMENT: "production", AGENTPAY_SETUP_MODE: "PUBLIC",
    AGENTPAY_SETUP_WORKER_TOKEN_PATH: "/run/agentpay/setup-worker.jwt", SUPABASE_URL: "https://prod.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_agentpay_test_key_1234567890",
    CELO_ATTRIBUTION_TAG: "celo_agentpay",
    CELO_MAINNET_RPC_URL: "https://rpc.celo.tech", AGENTPAY_ONBOARDING_MANIFEST_PATH: "/private/manifest.json",
    AGENTPAY_ONBOARDING_MANIFEST_SHA256: digest, AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH: "/private/runtime.json",
    AGENTPAY_FACTORY_ADDRESS: factory, AGENTPAY_FACTORY_RUNTIME_CODE_HASH: hash("3"),
    AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY: `0x${"09".repeat(32)}`,
    AGENTPAY_SETUP_RAW_TX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    AGENTPAY_SETUP_WORKER_ID: "worker-production-1", AGENTPAY_SETUP_WORKER_LEASE_SECONDS: "120",
    AGENTPAY_SETUP_WORKER_POLL_INTERVAL_MS: "1000", AGENTPAY_SETUP_MAX_DEPLOYMENTS_PER_DAY: "10",
    AGENTPAY_SETUP_RECEIPT_TIMEOUT_SECONDS: "300",
    AGENTPAY_SETUP_MAX_GAS_PER_DEPLOYMENT: "2000000",
    AGENTPAY_SETUP_MAX_NATIVE_COST_PER_DAY_WEI: "1000000000000000000", AGENTPAY_SETUP_MAX_PENDING: "4",
    AGENTPAY_SETUP_MAX_FEE_PER_GAS_WEI: "3000000000",
    AGENTPAY_SETUP_MAX_PRIORITY_FEE_PER_GAS_WEI: "2000000000",
    AGENTPAY_SETUP_MIN_SIGNER_BALANCE_WEI: "1000000000000000",
    AGENTPAY_SETUP_MAX_SIGNER_BALANCE_WEI: "100000000000000000",
  };
  return { env, manifest, artifact, digest };
}

describe("production setup worker runtime config", () => {
  it("accepts only Celo mainnet for worker readiness", () => {
    assert.doesNotThrow(() => assertProductionSetupWorkerChainId(42220n));
    assert.throws(() => assertProductionSetupWorkerChainId(196n), /SETUP_WORKER_RUNTIME_MISMATCH/);
    assert.throws(() => assertProductionSetupWorkerChainId(11142220n), /SETUP_WORKER_RUNTIME_MISMATCH/);
  });

  it("loads only a worker-scoped mainnet signer boundary and exact manifest limits", () => {
    const input = fixture();
    const config = parseProductionSetupWorkerConfig(input.env, {
      manifestJson: JSON.stringify(input.manifest), runtimeArtifactJson: JSON.stringify(input.artifact),
      scopedToken: token("agentpay_setup_worker"), nowUnix,
    });
    assert.equal(config.chainId, 42220);
    assert.equal(config.signerAddress, signer.address.toLowerCase());
    assert.equal(config.factoryDeploymentBlock, 100);
    assert.equal(config.limits.maxGasLimit, 2_000_000n);
    assert.equal(config.encryptionKey.byteLength, 32);
    assert.equal(config.supabaseApiKey, "sb_publishable_agentpay_test_key_1234567890");
    assert.equal(config.scopedWorkerTokenPath, "/run/agentpay/setup-worker.jwt");
    assert.equal(config.celoAttributionTag, "celo_agentpay");
    assert.ok(!Object.values(config).includes(input.env.AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY as never));
  });

  it("rejects web/service tokens, testnet, forbidden cross-process secrets, and limit drift", () => {
    const input = fixture();
    for (const overrides of [
      { AGENTPAY_SETUP_WORKER_TOKEN: token("agentpay_setup_worker") },
      { AGENTPAY_SETUP_WEB_TOKEN_PATH: "/run/agentpay/setup-web.jwt" },
      { CELO_SEPOLIA_RPC_URL: "https://testrpc.example" },
      { SUPABASE_SERVICE_ROLE_KEY: "secret" },
      { SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden" },
      { CELO_ATTRIBUTION_TAG: "agentpay" },
      { AGENTPAY_REVIEW_TOKEN_SECRET: "secret" },
      { AGENTPAY_SETUP_MAX_PENDING: "5" },
      { AGENTPAY_SETUP_MAX_SIGNER_BALANCE_WEI: "1000000000000000001" },
    ]) {
      assert.throws(() => parseProductionSetupWorkerConfig({ ...input.env, ...overrides }, {
        manifestJson: JSON.stringify(input.manifest), runtimeArtifactJson: JSON.stringify(input.artifact),
        scopedToken: token("agentpay_setup_worker"), nowUnix,
      }));
    }
    for (const scopedToken of [token("agentpay_setup_web"), token("service_role")]) {
      assert.throws(() => parseProductionSetupWorkerConfig(input.env, {
        manifestJson: JSON.stringify(input.manifest), runtimeArtifactJson: JSON.stringify(input.artifact),
        scopedToken, nowUnix,
      }));
    }
  });

  it("reloads a rotated worker token from its scoped credential file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpay-setup-worker-token-"));
    const tokenPath = join(directory, "setup-worker.jwt");
    try {
      const first = token("agentpay_setup_worker");
      await writeFile(tokenPath, first);
      assert.equal(await readProductionSetupWorkerScopedToken(tokenPath, nowUnix), first);

      const rotated = token("agentpay_setup_worker").replace(".signature", ".rotated");
      await writeFile(tokenPath, rotated);
      assert.equal(await readProductionSetupWorkerScopedToken(tokenPath, nowUnix), rotated);

      await writeFile(tokenPath, token("agentpay_setup_web"));
      await assert.rejects(readProductionSetupWorkerScopedToken(tokenPath, nowUnix));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
