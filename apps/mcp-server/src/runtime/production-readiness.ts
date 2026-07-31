import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  type PaymentIntentRecord,
  type SessionEnvironment,
} from "@agentpay-ai/shared-arc";

import type { MainnetAccountVerificationResult } from "../services/mainnet-account-verifier.ts";

export type ExecutionMode = "OFF" | "CANARY" | "PUBLIC" | "DRAIN";
export type RuntimeIdentityStatus = "SHADOW_ONLY" | "DEPLOYED" | "READY" | "DRAINING";

export const ARC_CHAIN_ID = 5042002;
export const ARC_CAIP2 = "eip155:5042002";

/**
 * The home chain id a production process is configured with at boot.
 *
 * This is the single source of truth for that value. `parseAgentPayEnv` gates
 * startup on it and this module's readiness check gates `/readyz` on it, and
 * both run inside one hosted process -- so a second, independently maintained
 * copy is a defect waiting to happen. It already was one: readiness required
 * Arc while startup required Celo mainnet, which left no environment able to
 * satisfy both. A server could start and never become ready, and each half was
 * covered by its own passing tests.
 *
 * Note this is the *legacy* Celo-shaped HTTP surface. The Arc hosted surface
 * boots from `hosted-arc-start.ts`, validates its own `ARC_*` environment, and
 * calls neither validator; it is unaffected by this constant. Migrating this
 * surface to Arc means changing this value and the `CeloHomeChainId` domain it
 * feeds -- a separate piece of work, not a redefinition of this constant.
 */
export const PRODUCTION_HOME_CHAIN_ID = "42220";
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const ARC_USDC_CODE_HASH =
  "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d";
export const ARC_CONSUMER_MCP_URL = "https://wallet.agentpay.site/arc/mcp";
export const ARC_PAID_MCP_URL = "https://mcp.agentpay.site/arc/mcp";
export const ARC_SETUP_URL = "https://wallet.agentpay.site/arc/setup";
export const ARC_REVIEW_URL = "https://wallet.agentpay.site/arc/review";
/** Legacy Celo production constants retained for frozen evidence and Celo-only modules. */
export const MAINNET_CHAIN_ID = 42220;
export const MAINNET_CAIP2 = "eip155:42220";
export const MAINNET_USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
export const MAINNET_USDC_CODE_HASH =
  "0x14254a76b7b2554180021c6390e814e73dee647ae91b7198da08de5145214493";
export const MAINNET_MIGRATION_HEAD = "20260721160000_celo_x402_settlement_audit";
export const MAINNET_CONSUMER_MCP_URL = "https://wallet.agentpay.site/celo/mcp";
export const MAINNET_PAID_MCP_URL = "https://mcp.agentpay.site/celo/mcp";
export const MAINNET_SETUP_URL = "https://wallet.agentpay.site/celo/setup";
export const MAINNET_REVIEW_URL = "https://wallet.agentpay.site/celo/review";
export const DEFAULT_PRODUCTION_MANIFEST_PATH = fileURLToPath(
  new URL("../../../../ops/manifests/celo-mainnet.shadow.json", import.meta.url),
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const HEX_HASH_PATTERN = /^0x[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const PRODUCTION_ENVIRONMENT_KEYS = [
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
  "AGENTPAY_SETUP_WEB_TOKEN",
  "AGENTPAY_SETUP_WORKER_TOKEN",
  "AGENTPAY_SETUP_WEB_TOKEN_PATH",
  "AGENTPAY_SETUP_WORKER_TOKEN_PATH",
  "AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY",
  "SETUP_DEPLOYER_PRIVATE_KEY",
];
const EXECUTION_MODES = new Set<ExecutionMode>(["OFF", "CANARY", "PUBLIC", "DRAIN"]);
const MANIFEST_STATUSES = new Set<RuntimeIdentityStatus>(["SHADOW_ONLY", "DEPLOYED", "READY", "DRAINING"]);

export interface RuntimeEnvironmentIdentity {
  id: number;
  environment: SessionEnvironment;
  chainId: number;
  caip2: string;
  supabaseProjectRef: string;
  migrationHead: string;
  releaseCommit: string | null;
  manifestSha256: string;
  accountVersion: "v2";
  accountAddress: string | null;
  deploymentTxHash: string | null;
  creationBytecodeHash: string;
  runtimeBytecodeHash: string | null;
  abiSha256: string | null;
  ownerAddress: string | null;
  executorAddress: string | null;
  deployerAddress: string | null;
  eip712VerifyingContract: string | null;
  tokenAddress: string;
  tokenCodeHash: string;
  tokenDecimals: number;
  x402Network: string;
  x402Asset: string;
  x402Price: string;
  x402PriceAtomic: string;
  x402SyncSettle: boolean;
  x402Enabled: boolean;
  payToAddress: string | null;
  facilitatorRef: string | null;
  publicOrigin?: string | null;
  executionMode: ExecutionMode;
  status: RuntimeIdentityStatus;
}

export interface ProductionPaymentConfigSnapshot {
  enabled: boolean;
  payTo: string;
  price: string;
  network: string;
  asset?: string;
  assetDecimals: number;
  syncSettle?: boolean;
  facilitatorUrl?: string;
  facilitatorApiKey?: string;
  resourceUrl: string;
}

export interface ProductionReadinessResult {
  ready: boolean;
  executionAllowed: boolean;
  publicPaymentAllowed: boolean;
  mode: ExecutionMode;
  status: RuntimeIdentityStatus;
  errors: string[];
  checks: Record<string, boolean>;
  /** Internal immutable snapshot used to detect post-start database drift. */
  identityFingerprint?: string;
}

export interface ProductionReadinessInput {
  env: Record<string, string | undefined>;
  manifest: unknown;
  identity: RuntimeEnvironmentIdentity | null;
  accountVerification: MainnetAccountVerificationResult | null;
  paymentConfig?: ProductionPaymentConfigSnapshot;
  /** True only after the durable Supabase ledger and frozen allowlist probe pass. */
  canaryAdmissionReady?: boolean;
  /** Live `/celo/setup/readyz` result; the onboarding service revalidates its rotated scoped token. */
  onboardingReady?: boolean;
}

export async function loadProductionManifest(path = DEFAULT_PRODUCTION_MANIFEST_PATH): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateProductionEnvironment(env: Record<string, string | undefined>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const add = (name: string, message: string) => errors.push(`${name}: ${message}`);
  const has = (name: string) => typeof env[name] === "string" && env[name]!.trim() !== "";

  if (env.AGENTPAY_ENVIRONMENT !== "production") add("AGENTPAY_ENVIRONMENT", "must be production");
  // Readiness verifies the process that is actually running. Demanding a
  // different chain than the one startup booted with cannot be satisfied by
  // any deployment, whichever chain is the right answer.
  if (String(env.AGENTPAY_HOME_CHAIN_ID ?? "") !== PRODUCTION_HOME_CHAIN_ID) {
    add("AGENTPAY_HOME_CHAIN_ID", `must be ${PRODUCTION_HOME_CHAIN_ID}, matching the configured home chain at startup`);
  }
  if (env.AGENTPAY_ACCOUNT_VERSION !== "v2") add("AGENTPAY_ACCOUNT_VERSION", "must be v2");

  for (const name of [
    "SUPABASE_PRODUCTION_URL",
    "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY",
    "ARC_TESTNET_RPC_URL",
    "AGENTPAY_SESSION_HASH_KEY",
    "AGENTPAY_REVIEW_TOKEN_SECRET",
    "AGENTPAY_CONSUMER_MCP_URL",
    "AGENTPAY_PAID_MCP_URL",
    "AGENTPAY_PUBLIC_SETUP_URL",
    "AGENTPAY_PUBLIC_REVIEW_URL",
    "AGENTPAY_ONBOARDING_MANIFEST_PATH",
    "AGENTPAY_ONBOARDING_MANIFEST_SHA256",
    "AGENTPAY_FACTORY_ADDRESS",
    "AGENTPAY_FACTORY_RUNTIME_CODE_HASH",
    "AGENTPAY_SETUP_SPONSOR_ADDRESS",
    "AGENTPAY_SETUP_SUPABASE_PROJECT_REF",
    "AGENTPAY_SETUP_MODE",
  ]) {
    if (!has(name)) add(name, "is required for production");
  }

  if (has("ARC_TESTNET_RPC_URL")) {
    try {
      const rpcUrl = new URL(env.ARC_TESTNET_RPC_URL!);
      if (
        rpcUrl.protocol !== "https:" ||
        ["localhost", "127.0.0.1", "::1"].includes(rpcUrl.hostname)
      ) {
        add("ARC_TESTNET_RPC_URL", "must be an HTTPS Arc Testnet RPC URL");
      }
    } catch {
      add("ARC_TESTNET_RPC_URL", "must be a valid HTTPS URL");
    }
  }

  const publicRoutes = {
    AGENTPAY_CONSUMER_MCP_URL: ARC_CONSUMER_MCP_URL,
    AGENTPAY_PAID_MCP_URL: ARC_PAID_MCP_URL,
    AGENTPAY_PUBLIC_SETUP_URL: ARC_SETUP_URL,
    AGENTPAY_PUBLIC_REVIEW_URL: ARC_REVIEW_URL,
  } as const;
  for (const [name, expected] of Object.entries(publicRoutes)) {
    if (has(name) && env[name] !== expected) add(name, `must be ${expected}`);
  }

  if (has("AGENTPAY_ONBOARDING_MANIFEST_PATH") && !env.AGENTPAY_ONBOARDING_MANIFEST_PATH!.startsWith("/")) {
    add("AGENTPAY_ONBOARDING_MANIFEST_PATH", "must be an absolute path");
  }
  if (has("AGENTPAY_ONBOARDING_MANIFEST_SHA256") && !SHA256_PATTERN.test(env.AGENTPAY_ONBOARDING_MANIFEST_SHA256!)) {
    add("AGENTPAY_ONBOARDING_MANIFEST_SHA256", "must be a lowercase SHA-256 digest");
  }
  for (const name of ["AGENTPAY_FACTORY_ADDRESS", "AGENTPAY_SETUP_SPONSOR_ADDRESS"]) {
    if (has(name) && (!ADDRESS_PATTERN.test(env[name]!) || env[name]!.toLowerCase() === ZERO_ADDRESS)) {
      add(name, "must be a non-zero EVM address");
    }
  }
  if (has("AGENTPAY_FACTORY_RUNTIME_CODE_HASH") && !HEX_HASH_PATTERN.test(env.AGENTPAY_FACTORY_RUNTIME_CODE_HASH!)) {
    add("AGENTPAY_FACTORY_RUNTIME_CODE_HASH", "must be a 32-byte hash");
  }
  if (has("AGENTPAY_SETUP_MODE") && !EXECUTION_MODES.has(env.AGENTPAY_SETUP_MODE as ExecutionMode)) {
    add("AGENTPAY_SETUP_MODE", "must be OFF, CANARY, PUBLIC, or DRAIN");
  }
  const setupProjectRef = env.AGENTPAY_SETUP_SUPABASE_PROJECT_REF;
  const productionProjectRef = extractSupabaseProjectRef(env.SUPABASE_PRODUCTION_URL);
  if (has("AGENTPAY_SETUP_SUPABASE_PROJECT_REF") && !/^[a-z0-9]{20}$/.test(setupProjectRef!)) {
    add("AGENTPAY_SETUP_SUPABASE_PROJECT_REF", "must be a Supabase project ref");
  } else if (setupProjectRef && setupProjectRef !== productionProjectRef) {
    add("AGENTPAY_SETUP_SUPABASE_PROJECT_REF", "must match the isolated production Supabase project");
  }
  if (
    has("AGENTPAY_FACTORY_ADDRESS") &&
    has("AGENTPAY_SETUP_SPONSOR_ADDRESS") &&
    env.AGENTPAY_FACTORY_ADDRESS!.toLowerCase() === env.AGENTPAY_SETUP_SPONSOR_ADDRESS!.toLowerCase()
  ) {
    add("AGENTPAY_SETUP_SPONSOR_ADDRESS", "must differ from the factory address");
  }

  if (has("SUPABASE_PRODUCTION_URL")) {
    try {
      const supabaseUrl = new URL(env.SUPABASE_PRODUCTION_URL!);
      if (supabaseUrl.protocol !== "https:" || !supabaseUrl.hostname.endsWith(".supabase.co")) {
        add("SUPABASE_PRODUCTION_URL", "must be an HTTPS Supabase project URL");
      }
    } catch {
      add("SUPABASE_PRODUCTION_URL", "must be a valid HTTPS URL");
    }
  }

  for (const name of PRODUCTION_ENVIRONMENT_KEYS) {
    if (has(name)) add(name, "generic or staging runtime reference is forbidden in production");
  }
  for (const name of ["AGENTPAY_SESSION_HASH_KEY", "AGENTPAY_REVIEW_TOKEN_SECRET"]) {
    if (has(name) && env[name]!.length < 32) add(name, "must be at least 32 characters");
  }
  if (has("AGENTPAY_EXECUTION_MODE") && !EXECUTION_MODES.has(env.AGENTPAY_EXECUTION_MODE as ExecutionMode)) {
    add("AGENTPAY_EXECUTION_MODE", "must be OFF, CANARY, PUBLIC, or DRAIN");
  }

  return { valid: errors.length === 0, errors };
}

export function validateProductionManifest(manifest: unknown): { valid: boolean; errors: string[]; status: RuntimeIdentityStatus; mode: ExecutionMode } {
  const errors: string[] = [];
  const add = (path: string, message: string) => errors.push(`${path}: ${message}`);
  const record = manifest as Record<string, any>;
  const isRecord = record !== null && typeof record === "object" && !Array.isArray(record);
  if (!isRecord) return { valid: false, errors: ["manifest: must be an object"], status: "SHADOW_ONLY", mode: "OFF" };

  const status = MANIFEST_STATUSES.has(record.status) ? (record.status as RuntimeIdentityStatus) : "SHADOW_ONLY";
  const mode = EXECUTION_MODES.has(record.executionMode) ? (record.executionMode as ExecutionMode) : "OFF";
  if (!MANIFEST_STATUSES.has(record.status)) add("status", "must be SHADOW_ONLY, DEPLOYED, READY, or DRAINING");
  if (!EXECUTION_MODES.has(record.executionMode)) add("executionMode", "must be OFF, CANARY, PUBLIC, or DRAIN");
  if (record.environment !== "production") add("environment", "must be production");
  if (record.schemaVersion !== 1) add("schemaVersion", "must be 1");
  if (record.chain?.chainId !== ARC_CHAIN_ID) add("chain.chainId", "must be 5042002");
  if (record.chain?.caip2 !== ARC_CAIP2) add("chain.caip2", "must be eip155:5042002");
  if (record.chain?.rpcEnvRef !== "ARC_TESTNET_RPC_URL") add("chain.rpcEnvRef", "must be ARC_TESTNET_RPC_URL");
  if (record.database?.environment !== "production") add("database.environment", "must be production");
  if (record.database?.migrationHead !== MAINNET_MIGRATION_HEAD) add("database.migrationHead", "does not match the identity migration head");
  if (record.release?.migrationHead !== MAINNET_MIGRATION_HEAD) add("release.migrationHead", "does not match the identity migration head");
  if (record.contract?.version !== "v2") add("contract.version", "must be v2");
  if (record.contract?.domain?.name !== "AgentPay" || record.contract?.domain?.version !== "1" || record.contract?.domain?.chainId !== ARC_CHAIN_ID) {
    add("contract.domain", "must be AgentPay/1 on chain 5042002");
  }
  if (record.token?.symbol !== "USDC" || record.token?.address?.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) add("token", "must be Arc Testnet USDC");
  if (record.token?.decimals !== 6 || record.token?.codeHash?.toLowerCase() !== ARC_USDC_CODE_HASH.toLowerCase()) add("token", "code hash and decimals must match Arc Testnet USDC");
  if (JSON.stringify(record.contract?.allowedTokens ?? []) !== JSON.stringify([ARC_USDC_ADDRESS])) add("contract.allowedTokens", "must contain only Arc Testnet USDC");
  if (!Array.isArray(record.contract?.allowedRouteTargets) || record.contract.allowedRouteTargets.length !== 0) add("contract.allowedRouteTargets", "must be empty");
  if (record.x402?.network !== ARC_CAIP2 || record.x402?.asset !== "USDC" || record.x402?.tokenAddress?.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) add("x402", "must target Arc Testnet USDC on eip155:5042002");
  if (record.x402?.decimals !== 6 || record.x402?.price !== "$0.01" || record.x402?.priceAtomic !== "10000" || record.x402?.syncSettle !== true) add("x402", "must use 6 decimals, $0.01/10000, and synchronous settlement");
  if (JSON.stringify(record.x402?.toolAllowlist ?? []) !== JSON.stringify(["execute_payment"])) add("x402.toolAllowlist", "must contain only execute_payment");
  if (record.onboarding?.setupUrl !== ARC_SETUP_URL) add("onboarding.setupUrl", `must be ${ARC_SETUP_URL}`);
  if (record.onboarding?.readinessUrl !== `${ARC_SETUP_URL}/readyz`) {
    add("onboarding.readinessUrl", `must be ${ARC_SETUP_URL}/readyz`);
  }
  if (record.onboarding?.manifestPathEnvRef !== "AGENTPAY_ONBOARDING_MANIFEST_PATH") {
    add("onboarding.manifestPathEnvRef", "must be AGENTPAY_ONBOARDING_MANIFEST_PATH");
  }
  if (record.onboarding?.manifestSha256EnvRef !== "AGENTPAY_ONBOARDING_MANIFEST_SHA256") {
    add("onboarding.manifestSha256EnvRef", "must be AGENTPAY_ONBOARDING_MANIFEST_SHA256");
  }
  if (record.onboarding?.factoryAddressEnvRef !== "AGENTPAY_FACTORY_ADDRESS") {
    add("onboarding.factoryAddressEnvRef", "must be AGENTPAY_FACTORY_ADDRESS");
  }
  if (record.onboarding?.sponsorAddressEnvRef !== "AGENTPAY_SETUP_SPONSOR_ADDRESS") {
    add("onboarding.sponsorAddressEnvRef", "must be AGENTPAY_SETUP_SPONSOR_ADDRESS");
  }
  if (mode === "OFF" && status !== "SHADOW_ONLY" && status !== "DEPLOYED") add("executionMode", "OFF is only valid before activation");
  if (status === "SHADOW_ONLY" && mode !== "OFF") add("executionMode", "SHADOW_ONLY manifests must remain OFF");

  const isReadySurface = status === "READY" || status === "DRAINING";
  if (isReadySurface) {
    if (record.x402?.enabled !== true) add("x402.enabled", "must be true for a ready surface");
    if (!/^[a-z0-9]{20}$/.test(record.database?.projectRef ?? "")) add("database.projectRef", "must be provisioned for a ready surface");
    if (typeof record.release?.commit !== "string" || !COMMIT_PATTERN.test(record.release.commit)) add("release.commit", "must be a frozen commit");
    if (typeof record.release?.runtimeBytecodeKeccak256 !== "string" || !HEX_HASH_PATTERN.test(record.release.runtimeBytecodeKeccak256)) add("release.runtimeBytecodeKeccak256", "must be pinned for a ready surface");
    if (typeof record.release?.abiSha256 !== "string" || !SHA256_PATTERN.test(record.release.abiSha256)) add("release.abiSha256", "must be pinned for a ready surface");
    for (const path of ["address", "deploymentTxHash", "runtimeBytecodeHash", "ownerAddress", "executorAddress", "deployerAddress"]) {
      const value = path === "deploymentTxHash" ? record.contract?.[path] : record.contract?.[path];
      const isHash = path === "deploymentTxHash" || path === "runtimeBytecodeHash";
      if (typeof value !== "string" || (isHash ? !HEX_HASH_PATTERN.test(value) : !ADDRESS_PATTERN.test(value))) add(`contract.${path}`, "must be provisioned for a ready surface");
    }
    if (!ADDRESS_PATTERN.test(record.contract?.domain?.verifyingContract ?? "")) add("contract.domain.verifyingContract", "must be provisioned for a ready surface");
    if (typeof record.domains?.publicOrigin !== "string" || !record.domains.publicOrigin.startsWith("https://")) add("domains.publicOrigin", "must be HTTPS for a ready surface");
  }

  return { valid: errors.length === 0, errors, status, mode };
}

export function computeManifestSha256(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export async function evaluateProductionReadiness(input: ProductionReadinessInput): Promise<ProductionReadinessResult> {
  const envResult = validateProductionEnvironment(input.env);
  const manifestResult = validateProductionManifest(input.manifest);
  const errors = [...envResult.errors, ...manifestResult.errors];
  const checks: Record<string, boolean> = {
    environment: envResult.valid,
    manifest: manifestResult.valid,
  };
  const identity = input.identity;
  const mode = identity?.executionMode ?? (input.env.AGENTPAY_EXECUTION_MODE as ExecutionMode | undefined) ?? manifestResult.mode;
  const status = identity?.status ?? manifestResult.status;

  if (!identity) {
    checks.identity = false;
    errors.push("runtime identity: singleton production identity is missing");
  } else {
    const identityErrors = validateIdentityAgainstManifest(identity, input.manifest, input.env);
    checks.identity = identityErrors.length === 0;
    errors.push(...identityErrors);
  }

  const paymentErrors = validatePaymentConfig(input.paymentConfig, mode);
  checks.payment = paymentErrors.length === 0;
  errors.push(...paymentErrors);
  const rawTransactionEncryptionReady = mode === "OFF" || mode === "DRAIN"
    ? true
    : /^[a-fA-F0-9]{64}$/.test(String(input.env.AGENTPAY_RAW_TX_ENCRYPTION_KEY ?? ""));
  checks.rawTransactionEncryption = rawTransactionEncryptionReady;
  if (!rawTransactionEncryptionReady) {
    errors.push("raw transaction encryption: AGENTPAY_RAW_TX_ENCRYPTION_KEY must be a 32-byte hex key");
  }

  if ((mode === "PUBLIC" || mode === "CANARY") && !input.accountVerification) {
    checks.account = false;
    errors.push("mainnet account: read-only account verification is missing");
  } else if (input.accountVerification) {
    checks.account = input.accountVerification.valid;
    errors.push(...input.accountVerification.errors.map((error) => `mainnet account: ${error}`));
  } else {
    checks.account = false;
  }

  const canaryAdmissionReady = mode !== "CANARY" || input.canaryAdmissionReady === true;
  checks.canaryAdmission = canaryAdmissionReady;
  if (!canaryAdmissionReady) {
    errors.push("canary admission: durable Supabase ledger and frozen allowlist are required");
  }

  const setupMode = input.env.AGENTPAY_SETUP_MODE as ExecutionMode | undefined;
  const onboardingModeMatches = mode !== "CANARY" && mode !== "PUBLIC" ? true : setupMode === mode;
  checks.onboardingMode = onboardingModeMatches;
  if (!onboardingModeMatches) {
    errors.push("onboarding mode: AGENTPAY_SETUP_MODE must match the effective production execution mode");
  }

  const onboardingReady = mode === "OFF" || mode === "DRAIN" || input.onboardingReady === true;
  checks.onboarding = onboardingReady;
  if (!onboardingReady) {
    errors.push("onboarding readiness: live /celo/setup/readyz verification is required");
  }

  if (mode === "PUBLIC" && status !== "READY") errors.push("execution mode: PUBLIC requires READY identity status");
  if (mode === "CANARY" && status !== "READY") errors.push("execution mode: CANARY requires READY identity status");
  if (mode === "OFF" || mode === "DRAIN") errors.push(`execution mode: ${mode} does not accept new public executions`);
  if (input.env.AGENTPAY_EXECUTION_MODE && identity && input.env.AGENTPAY_EXECUTION_MODE !== identity.executionMode) {
    errors.push("execution mode: environment value does not match the database identity");
  }

  const ready = errors.length === 0 && (mode === "PUBLIC" || mode === "CANARY");
  return {
    ready,
    executionAllowed: ready,
    publicPaymentAllowed: ready && (mode === "PUBLIC" || mode === "CANARY") && input.paymentConfig?.enabled === true,
    mode,
    status,
    errors,
    checks,
    identityFingerprint: identity ? fingerprintRuntimeIdentity(identity) : undefined,
  };
}

export function assertProductionExecutionAllowed(
  policy: { mode: ExecutionMode; environment?: SessionEnvironment; directMainnetOnly?: boolean },
  intent: PaymentIntentRecord,
): void {
  if (policy.environment !== "production") return;
  if (policy.mode !== "PUBLIC" && policy.mode !== "CANARY") {
    throw new Error("PRODUCTION_NOT_READY: execution mode does not allow new payments.");
  }
  if (!policy.directMainnetOnly) return;
  const direct =
    intent.sourceChainId === ARC_CHAIN_ID &&
    intent.destinationChainId === ARC_CHAIN_ID &&
    intent.sourceTokenSymbol === "USDC" &&
    intent.destinationTokenSymbol === "USDC" &&
    intent.sourceTokenAddress.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase() &&
    intent.destinationTokenAddress.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase() &&
    intent.routeProvider === "DIRECT" &&
    intent.routeTarget.toLowerCase() === ZERO_ADDRESS &&
    intent.routeCalldata === "0x" &&
    intent.maxNativeFee === "0";
  if (!direct) {
    throw new Error("PRODUCTION_EXECUTION_RESTRICTED: only direct Arc Testnet USDC payments are enabled.");
  }
}

function validateIdentityAgainstManifest(
  identity: RuntimeEnvironmentIdentity,
  manifest: unknown,
  env: Record<string, string | undefined>,
): string[] {
  const errors: string[] = [];
  const record = manifest as Record<string, any>;
  const projectRef = extractSupabaseProjectRef(env.SUPABASE_PRODUCTION_URL);
  const manifestDigest = computeManifestSha256(manifest);
  const compare = (name: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) errors.push(`runtime identity: ${name} does not match the manifest/environment`);
  };
  compare("id", identity.id, 1);
  compare("environment", identity.environment, "production");
  compare("chainId", identity.chainId, ARC_CHAIN_ID);
  compare("caip2", identity.caip2, ARC_CAIP2);
  compare("Supabase project", identity.supabaseProjectRef, projectRef);
  compare("migration head", identity.migrationHead, record.database?.migrationHead);
  compare("manifest digest", identity.manifestSha256, manifestDigest);
  compare("account version", identity.accountVersion, "v2");
  compare("execution mode", identity.executionMode, record.executionMode);
  compare("status", identity.status, record.status);
  compare("x402 enabled", identity.x402Enabled, record.x402?.enabled);
  compare("EIP-712 verifying contract", identity.eip712VerifyingContract?.toLowerCase() ?? null, record.contract?.domain?.verifyingContract?.toLowerCase() ?? null);
  compare("creation bytecode", identity.creationBytecodeHash, record.contract?.creationBytecodeHash);
  compare("token address", identity.tokenAddress.toLowerCase(), String(record.token?.address ?? "").toLowerCase());
  compare("token code hash", identity.tokenCodeHash.toLowerCase(), String(record.token?.codeHash ?? "").toLowerCase());
  compare("token decimals", identity.tokenDecimals, record.token?.decimals);
  compare("x402 network", identity.x402Network, record.x402?.network);
  compare("x402 asset", identity.x402Asset.toLowerCase(), String(record.x402?.tokenAddress ?? "").toLowerCase());
  compare("x402 price", identity.x402Price, record.x402?.price);
  compare("x402 price atomic", identity.x402PriceAtomic, record.x402?.priceAtomic);
  compare("x402 sync settlement", identity.x402SyncSettle, record.x402?.syncSettle);
  if (record.status === "READY" || record.status === "DRAINING") {
    compare("release commit", identity.releaseCommit, record.release?.commit);
    compare("account address", identity.accountAddress, record.contract?.address);
    compare("deployment tx", identity.deploymentTxHash, record.contract?.deploymentTxHash);
    compare("runtime bytecode", identity.runtimeBytecodeHash, record.contract?.runtimeBytecodeHash);
    compare("ABI digest", identity.abiSha256, record.release?.abiSha256);
    compare("owner", identity.ownerAddress, record.contract?.ownerAddress);
    compare("executor", identity.executorAddress, record.contract?.executorAddress);
    compare("deployer", identity.deployerAddress, record.contract?.deployerAddress);
    compare("facilitator", identity.facilitatorRef, record.x402?.facilitatorUrl);
    if (!identity.payToAddress || !ADDRESS_PATTERN.test(identity.payToAddress)) errors.push("runtime identity: payTo address is not provisioned");
    if (!identity.facilitatorRef) errors.push("runtime identity: facilitator reference is not provisioned");
  }
  return errors;
}

function validatePaymentConfig(config: ProductionPaymentConfigSnapshot | undefined, mode: ExecutionMode): string[] {
  const errors: string[] = [];
  if (mode === "OFF" || mode === "DRAIN") {
    if (config?.enabled) errors.push("payment config: payment must remain disabled in OFF/DRAIN mode");
    return errors;
  }
  if (!config?.enabled) {
    errors.push("payment config: public mode requires enabled x402 payment");
    return errors;
  }
  if (config.network !== ARC_CAIP2) errors.push("payment config: network must be eip155:5042002");
  if (config.asset?.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) {
    errors.push("payment config: asset must be the canonical Arc Testnet USDC contract");
  }
  if (config.price !== "$0.01") errors.push("payment config: price must be $0.01");
  if (config.assetDecimals !== 6) errors.push("payment config: asset decimals must be 6 for USDC");
  if (config.syncSettle !== true) errors.push("payment config: synchronous settlement must be explicitly true");
  if (!ADDRESS_PATTERN.test(config.payTo) || config.payTo.toLowerCase() === ZERO_ADDRESS) errors.push("payment config: payTo must be a non-zero EVM address");
  if (!config.facilitatorUrl || !isHttpsUrl(config.facilitatorUrl)) {
    errors.push("payment config: facilitator URL must be an HTTPS URL");
  }
  if (config.resourceUrl !== ARC_PAID_MCP_URL) {
    errors.push(`payment config: resource URL must be ${ARC_PAID_MCP_URL}`);
  }
  if (!config.facilitatorApiKey) {
    errors.push("payment config: facilitator API key is required");
  }
  return errors;
}

function extractSupabaseProjectRef(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintRuntimeIdentity(identity: RuntimeEnvironmentIdentity): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}
