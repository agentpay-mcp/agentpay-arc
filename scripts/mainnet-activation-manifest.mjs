import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MAINNET_CAIP2,
  MAINNET_CHAIN_ID,
  MAINNET_EXECUTOR_GAS_MAX_CELO,
  MAINNET_SHADOW_MANIFEST_PATH,
  MAINNET_USDC_ADDRESS,
  MAINNET_USDC_CODE_HASH,
  MAINNET_USDC_DECIMALS,
  MAINNET_X402_FACILITATOR_URL,
  assertMainnetShadowManifest,
  computeArtifactDigests,
} from "./mainnet-shadow-manifest.mjs";

export const MAINNET_ACTIVATED_MANIFEST_PATH = fileURLToPath(
  new URL("../ops/manifests/celo-mainnet.activated.json", import.meta.url),
);
export const MAINNET_CANARY_MANIFEST_PATH = fileURLToPath(
  new URL("../ops/manifests/celo-mainnet.canary.json", import.meta.url),
);
export const MAINNET_CANARY_MAX_ACCEPTED_LIFECYCLES = 2;
export const MAINNET_CANARY_BINDING = Object.freeze({
  tenantId: "3cf8d1e5-3b17-4069-b2ec-7db81752e415",
  payerAddress: "0x98802C2d45284F2bcA06BF3d6bdb41221a7Cc5cD",
  recipientAddress: "0x9CEef6d89915628331C25F48360FfE97CD71B3EE",
  accountAddress: "0xA495Eaff5809Efb32beb6eCd18a48e9469Acf121",
  deploymentTxHash: "0x212ccf9ca2a0f8ef08a5533705e3b319bf8fe57db260b8048b2dc28c7603d8fa",
  runtimeBytecodeHash: "0xa1a627f011931eba8d6aeb3f16290f3d91f0f777a8fabc635f00882c457c38a3",
  abiSha256: "2e2c3a0610e7f4961423baa07284c7d69ebef5f4cef9b285a99595e4b01d30e6",
  ownerAddress: "0x9CEef6d89915628331C25F48360FfE97CD71B3EE",
  executorAddress: "0x645d39b3943D27cfE53184a446f551a69a4b1FDe",
  deployerAddress: "0x72936d76E840ddBB18976705779b6E24834B4d93",
  projectRef: "hxnrqujmyltkumfipkuk",
  releaseCommit: "725bab9a446364dbf4086263c9f679d1869ea416",
  publicOrigin: "https://mcp.agentpay.site",
  consumerOrigin: "https://wallet.agentpay.site/celo/mcp",
  siweAudience: "https://wallet.agentpay.site/celo/mcp",
  x402PayToEnvRef: "AGENTPAY_A2MCP_PAYMENT_PAY_TO",
  x402FacilitatorEnvRef: "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL",
  policy: Object.freeze({
    maxAcceptedLifecycles: MAINNET_CANARY_MAX_ACCEPTED_LIFECYCLES,
    invoiceMaxUsdc: "0.05",
    accountFundingUsdc: "0.05",
    payerFeeWalletFundingMaxUsdc: "0.05",
    aspFeeUsdc: "0.01",
    executorGasMaxCelo: MAINNET_EXECUTOR_GAS_MAX_CELO,
  }),
  secretRefs: Object.freeze({
    namespace: "agentpay-celo/production",
    executorPrivateKeyEnvRef: "EXECUTOR_PRIVATE_KEY",
    setupDeployerPrivateKeyEnvRef: "AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY",
    sessionHashKeyEnvRef: "AGENTPAY_SESSION_HASH_KEY",
    reviewTokenSecretEnvRef: "AGENTPAY_REVIEW_TOKEN_SECRET",
    rawTransactionEncryptionKeyEnvRef: "AGENTPAY_RAW_TX_ENCRYPTION_KEY",
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const HASH_PATTERN = /^0x[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_BEARING_KEYS = new Set([
  "accessToken",
  "apiKey",
  "bearerToken",
  "executorPrivateKey",
  "facilitatorCredential",
  "mnemonic",
  "password",
  "privateKey",
  "rawTransaction",
  "secret",
  "seedPhrase",
  "serviceRoleKey",
  "sessionSigningKey",
  "setupDeployerPrivateKey",
]);

function arrayEquals(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function addressesEqual(left, right) {
  return typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase();
}

function visitForSecretKeys(value, path, add) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitForSecretKeys(entry, `${path}[${index}]`, add));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_BEARING_KEYS.has(key)) {
      add(`${path}.${key}`, "secret-bearing fields are forbidden in a canary manifest");
    }
    visitForSecretKeys(child, `${path}.${key}`, add);
  }
}

async function writeCanaryManifestAtomically(outputPath, manifest) {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink()) {
      throw new Error("Canary output path must not be a symbolic link.");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFile;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o644);
    await temporaryFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (temporaryFile) await temporaryFile.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeActivationManifestSha256(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function buildMainnetActivatedManifest({ shadowManifest } = {}) {
  if (!isRecord(shadowManifest)) {
    throw new Error("A generated mainnet shadow manifest is required for activation.");
  }
  if (shadowManifest.status !== "SHADOW_ONLY" || shadowManifest.executionMode !== "OFF") {
    throw new Error("Activation requires an unchanged SHADOW_ONLY/OFF source manifest.");
  }

  const manifest = structuredClone(shadowManifest);
  manifest.kind = "agentpay-mainnet-activated-manifest";
  manifest.status = "DEPLOYED";
  manifest.executionMode = "OFF";
  manifest.activation = {
    sourceManifest: "celo-mainnet.shadow.json",
    accountDeployment: "PENDING",
    executionEnabled: false,
  };

  if (manifest.x402?.enabled !== false) {
    throw new Error("Mainnet activation must keep x402 disabled until account deployment.");
  }
  const contract = manifest.contract;
  for (const key of [
    "address",
    "deploymentTxHash",
    "runtimeBytecodeHash",
    "ownerAddress",
    "executorAddress",
    "deployerAddress",
  ]) {
    if (contract?.[key] !== null) {
      throw new Error(`Mainnet activation cannot provision contract.${key}.`);
    }
  }
  if (contract?.domain?.verifyingContract !== null) {
    throw new Error("Mainnet activation cannot provision contract.domain.verifyingContract.");
  }

  return manifest;
}

export function buildMainnetDeployedManifest({ activationManifest, deployment } = {}) {
  if (!isRecord(activationManifest)) {
    throw new Error("A DEPLOYED/OFF activation manifest is required.");
  }
  if (activationManifest.status !== "DEPLOYED" || activationManifest.executionMode !== "OFF") {
    throw new Error("Account deployment promotion requires a DEPLOYED/OFF activation manifest.");
  }
  if (activationManifest.activation?.accountDeployment !== "PENDING") {
    throw new Error("Account deployment promotion requires a PENDING account deployment.");
  }
  if (activationManifest.x402?.enabled !== false) {
    throw new Error("Account deployment promotion requires x402 to remain disabled.");
  }
  if (!isRecord(deployment)) {
    throw new Error("Verified deployment identity is required.");
  }

  const requiredAddresses = ["accountAddress", "ownerAddress", "executorAddress", "deployerAddress"];
  for (const key of requiredAddresses) {
    if (typeof deployment[key] !== "string" || !ADDRESS_PATTERN.test(deployment[key])) {
      throw new Error(`deployment.${key} must be a valid address.`);
    }
  }
  if (deployment.ownerAddress.toLowerCase() === deployment.executorAddress.toLowerCase()) {
    throw new Error("deployment.ownerAddress and deployment.executorAddress must differ.");
  }
  if (typeof deployment.deploymentTxHash !== "string" || !HASH_PATTERN.test(deployment.deploymentTxHash)) {
    throw new Error("deployment.deploymentTxHash must be a 32-byte transaction hash.");
  }
  if (typeof deployment.runtimeBytecodeHash !== "string" || !HASH_PATTERN.test(deployment.runtimeBytecodeHash)) {
    throw new Error("deployment.runtimeBytecodeHash must be a 32-byte hash.");
  }
  if (typeof deployment.abiSha256 !== "string" || !SHA256_PATTERN.test(deployment.abiSha256)) {
    throw new Error("deployment.abiSha256 must be a SHA-256 digest.");
  }

  const manifest = structuredClone(activationManifest);
  manifest.activation = {
    ...manifest.activation,
    accountDeployment: "DEPLOYED",
  };
  manifest.release = {
    ...manifest.release,
    runtimeBytecodeKeccak256: deployment.runtimeBytecodeHash.toLowerCase(),
    abiSha256: deployment.abiSha256.toLowerCase(),
  };
  manifest.contract = {
    ...manifest.contract,
    address: deployment.accountAddress,
    deploymentTxHash: deployment.deploymentTxHash.toLowerCase(),
    runtimeBytecodeHash: deployment.runtimeBytecodeHash.toLowerCase(),
    ownerAddress: deployment.ownerAddress,
    executorAddress: deployment.executorAddress,
    deployerAddress: deployment.deployerAddress,
    paused: false,
    domain: {
      ...manifest.contract.domain,
      verifyingContract: deployment.accountAddress,
    },
  };

  return manifest;
}

export function bindMainnetCanaryPolicy({ deployedManifest, tenantId, payerAddress, recipientAddress } = {}) {
  if (!isRecord(deployedManifest)) {
    throw new Error("A deployed manifest is required before canary binding.");
  }
  if (deployedManifest.status !== "DEPLOYED" || deployedManifest.executionMode !== "OFF") {
    throw new Error("Canary binding requires a DEPLOYED/OFF manifest.");
  }
  if (deployedManifest.activation?.accountDeployment !== "DEPLOYED") {
    throw new Error("Canary binding requires a deployed account.");
  }
  if (deployedManifest.x402?.enabled !== false) {
    throw new Error("Canary binding requires x402 to remain disabled.");
  }
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    throw new Error("canary tenantId must be a valid UUID.");
  }
  for (const [name, value] of [["payerAddress", payerAddress], ["recipientAddress", recipientAddress]]) {
    if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
      throw new Error(`canary ${name} must be a valid address.`);
    }
  }

  const contract = deployedManifest.contract;
  if (
    !isRecord(contract) ||
    typeof contract.address !== "string" ||
    !ADDRESS_PATTERN.test(contract.address) ||
    typeof contract.ownerAddress !== "string" ||
    !ADDRESS_PATTERN.test(contract.ownerAddress)
  ) {
    throw new Error("Canary binding requires a deployed account and owner address.");
  }

  const existing = isRecord(deployedManifest.canaryPolicy) ? deployedManifest.canaryPolicy : {};
  const expected = {
    allowlistedTenantId: tenantId,
    allowlistedOwnerAddress: contract.ownerAddress,
    allowlistedAccountAddress: contract.address,
    payerAddress,
    recipientAddress,
  };
  for (const [key, value] of Object.entries(expected)) {
    const previous = existing[key];
    if (previous !== null && previous !== undefined && String(previous).toLowerCase() !== String(value).toLowerCase()) {
      throw new Error(`Canary policy ${key} is already bound to a different value.`);
    }
  }

  return {
    ...structuredClone(deployedManifest),
    canaryPolicy: {
      ...existing,
      ...expected,
    },
  };
}

export function buildMainnetCanaryManifest({ deployedManifest, projectRef, releaseCommit, publicOrigin } = {}) {
  if (!isRecord(deployedManifest)) {
    throw new Error("A deployed manifest is required before canary activation.");
  }
  if (deployedManifest.status !== "DEPLOYED" || deployedManifest.executionMode !== "OFF") {
    throw new Error("Canary activation requires a DEPLOYED/OFF manifest.");
  }
  if (deployedManifest.activation?.accountDeployment !== "DEPLOYED") {
    throw new Error("Canary activation requires a deployed account.");
  }
  if (deployedManifest.x402?.enabled !== false) {
    throw new Error("Canary activation requires x402 to remain disabled before promotion.");
  }
  if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error("projectRef must be a 20-character Supabase project reference.");
  }
  if (typeof releaseCommit !== "string" || !COMMIT_PATTERN.test(releaseCommit)) {
    throw new Error("releaseCommit must be an immutable 40-character commit SHA.");
  }
  if (typeof publicOrigin !== "string" || !/^https:\/\//.test(publicOrigin)) {
    throw new Error("publicOrigin must be an HTTPS URL.");
  }

  const policy = deployedManifest.canaryPolicy;
  if (
    !isRecord(policy) ||
    typeof policy.allowlistedTenantId !== "string" ||
    !UUID_PATTERN.test(policy.allowlistedTenantId) ||
    [
      policy.allowlistedOwnerAddress,
      policy.allowlistedAccountAddress,
      policy.payerAddress,
      policy.recipientAddress,
    ].some((value) => typeof value !== "string" || !ADDRESS_PATTERN.test(value))
  ) {
    throw new Error("Canary activation requires a fully bound tenant, account, payer, and recipient policy.");
  }

  const manifest = structuredClone(deployedManifest);
  manifest.status = "READY";
  manifest.executionMode = "CANARY";
  manifest.x402 = {
    ...manifest.x402,
    enabled: true,
  };
  manifest.database = {
    ...manifest.database,
    projectRef,
  };
  manifest.release = {
    ...manifest.release,
    commit: releaseCommit.toLowerCase(),
  };
  manifest.domains = {
    ...manifest.domains,
    publicOrigin,
  };
  manifest.onboarding = {
    ...manifest.onboarding,
    setupMode: "CANARY",
  };
  manifest.canaryPolicy = {
    ...manifest.canaryPolicy,
    ...MAINNET_CANARY_BINDING.policy,
  };
  manifest.secretRefs = {
    ...manifest.secretRefs,
    ...MAINNET_CANARY_BINDING.secretRefs,
  };
  manifest.activation = {
    ...manifest.activation,
    executionEnabled: true,
  };
  return manifest;
}

export function validateMainnetActivationManifest(manifest, { artifactDigests } = {}) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);

  if (!isRecord(manifest)) return { valid: false, errors: ["manifest: must be an object"] };
  if (manifest.schemaVersion !== 1) add("schemaVersion", "must be 1");
  if (manifest.kind !== "agentpay-mainnet-activated-manifest") add("kind", "must be agentpay-mainnet-activated-manifest");
  if (manifest.status !== "DEPLOYED") add("status", "must be DEPLOYED");
  if (manifest.environment !== "production") add("environment", "must be production");
  if (manifest.executionMode !== "OFF") add("executionMode", "must be OFF");
  if (manifest.chain?.chainId !== 42220 || manifest.chain?.caip2 !== "eip155:42220") add("chain", "must target Celo mainnet");
  if (manifest.x402?.enabled !== false) add("x402.enabled", "must remain false while execution is OFF");
  if (manifest.activation?.sourceManifest !== "celo-mainnet.shadow.json") add("activation.sourceManifest", "must point to the frozen shadow artifact");
  const accountDeployment = manifest.activation?.accountDeployment;
  if (accountDeployment !== "PENDING" && accountDeployment !== "DEPLOYED") {
    add("activation.accountDeployment", "must be PENDING or DEPLOYED");
  }
  if (manifest.activation?.executionEnabled !== false) add("activation.executionEnabled", "must remain false");

  if (accountDeployment === "PENDING") {
    for (const key of [
      "address",
      "deploymentTxHash",
      "runtimeBytecodeHash",
      "ownerAddress",
      "executorAddress",
      "deployerAddress",
    ]) {
      if (manifest.contract?.[key] !== null) add(`contract.${key}`, "must remain null before deployment");
    }
    if (manifest.contract?.domain?.verifyingContract !== null) {
      add("contract.domain.verifyingContract", "must remain null before deployment");
    }
  }

  if (accountDeployment === "DEPLOYED") {
    for (const key of ["address", "ownerAddress", "executorAddress", "deployerAddress"]) {
      if (typeof manifest.contract?.[key] !== "string" || !ADDRESS_PATTERN.test(manifest.contract[key])) {
        add(`contract.${key}`, "must be a valid deployed address");
      }
    }
    if (typeof manifest.contract?.deploymentTxHash !== "string" || !HASH_PATTERN.test(manifest.contract.deploymentTxHash)) {
      add("contract.deploymentTxHash", "must be a valid deployment transaction hash");
    }
    if (typeof manifest.contract?.runtimeBytecodeHash !== "string" || !HASH_PATTERN.test(manifest.contract.runtimeBytecodeHash)) {
      add("contract.runtimeBytecodeHash", "must be a valid deployed runtime hash");
    }
    if (manifest.contract?.ownerAddress?.toLowerCase() === manifest.contract?.executorAddress?.toLowerCase()) {
      add("contract.ownerAddress", "must differ from contract.executorAddress");
    }
    if (manifest.contract?.paused !== false) add("contract.paused", "must be false before canary approval");
    if (manifest.contract?.domain?.verifyingContract?.toLowerCase() !== manifest.contract?.address?.toLowerCase()) {
      add("contract.domain.verifyingContract", "must match contract.address");
    }
    if (typeof manifest.release?.runtimeBytecodeKeccak256 !== "string" || !HASH_PATTERN.test(manifest.release.runtimeBytecodeKeccak256)) {
      add("release.runtimeBytecodeKeccak256", "must be a deployed runtime hash");
    }
    if (manifest.release?.runtimeBytecodeKeccak256?.toLowerCase() !== manifest.contract?.runtimeBytecodeHash?.toLowerCase()) {
      add("release.runtimeBytecodeKeccak256", "must match contract.runtimeBytecodeHash");
    }
    if (typeof manifest.release?.abiSha256 !== "string" || !SHA256_PATTERN.test(manifest.release.abiSha256)) {
      add("release.abiSha256", "must be an ABI SHA-256 digest after deployment");
    }
  }

  if (artifactDigests) {
    if (manifest.release?.packageLockSha256 !== artifactDigests.packageLockSha256) {
      add("release.packageLockSha256", "does not match the frozen artifact");
    }
    if (manifest.release?.creationBytecodeKeccak256?.toLowerCase() !== artifactDigests.creationBytecodeKeccak256?.toLowerCase()) {
      add("release.creationBytecodeKeccak256", "does not match the frozen artifact");
    }
    if (manifest.contract?.creationBytecodeHash?.toLowerCase() !== artifactDigests.creationBytecodeKeccak256?.toLowerCase()) {
      add("contract.creationBytecodeHash", "does not match the frozen artifact");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateMainnetCanaryManifest(manifest, { artifactDigests } = {}) {
  const errors = [];
  const binding = MAINNET_CANARY_BINDING;
  const add = (path, message) => errors.push(`${path}: ${message}`);
  const requireEqual = (value, expected, path) => {
    if (value !== expected) add(path, `must equal ${JSON.stringify(expected)}`);
  };
  const requireAddress = (value, path) => {
    if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
      add(path, "must be a valid deployed address");
    }
  };
  const requireHash = (value, path) => {
    if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
      add(path, "must be a 32-byte hex hash");
    }
  };

  if (!isRecord(manifest)) return { valid: false, errors: ["manifest: must be an object"] };
  visitForSecretKeys(manifest, "manifest", add);
  requireEqual(manifest.schemaVersion, 1, "schemaVersion");
  requireEqual(manifest.kind, "agentpay-mainnet-activated-manifest", "kind");
  requireEqual(manifest.status, "READY", "status");
  requireEqual(manifest.environment, "production", "environment");
  requireEqual(manifest.executionMode, "CANARY", "executionMode");

  requireEqual(manifest.chain?.name, "Celo", "chain.name");
  requireEqual(manifest.chain?.chainId, MAINNET_CHAIN_ID, "chain.chainId");
  requireEqual(manifest.chain?.caip2, MAINNET_CAIP2, "chain.caip2");
  requireEqual(manifest.database?.environment, "production", "database.environment");
  requireEqual(manifest.database?.projectRef, binding.projectRef, "database.projectRef");
  requireEqual(manifest.release?.commit, binding.releaseCommit, "release.commit");
  requireEqual(manifest.domains?.publicOrigin, binding.publicOrigin, "domains.publicOrigin");
  requireEqual(manifest.domains?.consumerOrigin, binding.consumerOrigin, "domains.consumerOrigin");
  requireEqual(manifest.domains?.siweAudience, binding.siweAudience, "domains.siweAudience");
  requireEqual(manifest.onboarding?.setupMode, "CANARY", "onboarding.setupMode");

  if (!isRecord(manifest.secretRefs)) {
    add("secretRefs", "must be an object");
  } else {
    for (const key of Object.keys(manifest.secretRefs)) {
      if (!Object.hasOwn(binding.secretRefs, key)) add(`secretRefs.${key}`, "is unexpected");
    }
    for (const [key, value] of Object.entries(binding.secretRefs)) {
      requireEqual(manifest.secretRefs[key], value, `secretRefs.${key}`);
    }
  }

  requireEqual(manifest.activation?.sourceManifest, "celo-mainnet.shadow.json", "activation.sourceManifest");
  requireEqual(manifest.activation?.accountDeployment, "DEPLOYED", "activation.accountDeployment");
  requireEqual(manifest.activation?.executionEnabled, true, "activation.executionEnabled");

  for (const key of ["address", "ownerAddress", "executorAddress", "deployerAddress"]) {
    requireAddress(manifest.contract?.[key], `contract.${key}`);
  }
  requireHash(manifest.contract?.deploymentTxHash, "contract.deploymentTxHash");
  requireHash(manifest.contract?.runtimeBytecodeHash, "contract.runtimeBytecodeHash");
  requireEqual(manifest.contract?.version, "v2", "contract.version");
  requireEqual(manifest.contract?.address, binding.accountAddress, "contract.address");
  requireEqual(manifest.contract?.deploymentTxHash, binding.deploymentTxHash, "contract.deploymentTxHash");
  requireEqual(manifest.contract?.runtimeBytecodeHash, binding.runtimeBytecodeHash, "contract.runtimeBytecodeHash");
  requireEqual(manifest.contract?.ownerAddress, binding.ownerAddress, "contract.ownerAddress");
  requireEqual(manifest.contract?.executorAddress, binding.executorAddress, "contract.executorAddress");
  requireEqual(manifest.contract?.deployerAddress, binding.deployerAddress, "contract.deployerAddress");
  requireEqual(manifest.contract?.paused, false, "contract.paused");
  requireEqual(manifest.contract?.domain?.name, "AgentPay", "contract.domain.name");
  requireEqual(manifest.contract?.domain?.version, "1", "contract.domain.version");
  requireEqual(manifest.contract?.domain?.chainId, MAINNET_CHAIN_ID, "contract.domain.chainId");
  requireEqual(
    manifest.contract?.domain?.verifyingContract,
    binding.accountAddress,
    "contract.domain.verifyingContract",
  );
  if (!arrayEquals(manifest.contract?.allowedTokens, [MAINNET_USDC_ADDRESS])) {
    add("contract.allowedTokens", `must equal ${JSON.stringify([MAINNET_USDC_ADDRESS])}`);
  }
  if (!arrayEquals(manifest.contract?.allowedRouteTargets, [])) {
    add("contract.allowedRouteTargets", "must remain empty for the canary");
  }
  if (addressesEqual(manifest.contract?.ownerAddress, manifest.contract?.executorAddress)) {
    add("contract.ownerAddress", "must differ from contract.executorAddress");
  }

  requireEqual(manifest.token?.symbol, "USDC", "token.symbol");
  requireEqual(manifest.token?.address, MAINNET_USDC_ADDRESS, "token.address");
  requireEqual(manifest.token?.decimals, MAINNET_USDC_DECIMALS, "token.decimals");
  requireEqual(manifest.token?.codeHash, MAINNET_USDC_CODE_HASH, "token.codeHash");

  requireEqual(manifest.x402?.enabled, true, "x402.enabled");
  requireEqual(manifest.x402?.network, MAINNET_CAIP2, "x402.network");
  requireEqual(manifest.x402?.asset, "USDC", "x402.asset");
  requireEqual(manifest.x402?.tokenAddress, MAINNET_USDC_ADDRESS, "x402.tokenAddress");
  requireEqual(manifest.x402?.decimals, MAINNET_USDC_DECIMALS, "x402.decimals");
  requireEqual(manifest.x402?.price, "$0.01", "x402.price");
  requireEqual(manifest.x402?.priceAtomic, "10000", "x402.priceAtomic");
  requireEqual(manifest.x402?.syncSettle, true, "x402.syncSettle");
  requireEqual(manifest.x402?.payToEnvRef, binding.x402PayToEnvRef, "x402.payToEnvRef");
  requireEqual(
    manifest.x402?.facilitatorEnvRef,
    binding.x402FacilitatorEnvRef,
    "x402.facilitatorEnvRef",
  );
  requireEqual(manifest.x402?.facilitatorUrl, MAINNET_X402_FACILITATOR_URL, "x402.facilitatorUrl");
  if (!arrayEquals(manifest.x402?.toolAllowlist, ["execute_payment"])) {
    add("x402.toolAllowlist", "must equal [\"execute_payment\"]");
  }

  const policy = manifest.canaryPolicy;
  if (!isRecord(policy)) {
    add("canaryPolicy", "must be an object");
  } else {
    const exactPolicy = {
      ...binding.policy,
      maxNativeFee: "0",
      executorGasMaxCelo: MAINNET_EXECUTOR_GAS_MAX_CELO,
      allowlistedTenantId: binding.tenantId,
      allowlistedOwnerAddress: binding.ownerAddress,
      allowlistedAccountAddress: binding.accountAddress,
      payerAddress: binding.payerAddress,
      recipientAddress: binding.recipientAddress,
    };
    for (const key of Object.keys(policy)) {
      if (!Object.hasOwn(exactPolicy, key)) {
        add(`canaryPolicy.${key}`, "is unexpected in the frozen canary policy");
      }
    }
    for (const [key, value] of Object.entries(exactPolicy)) {
      requireEqual(policy[key], value, `canaryPolicy.${key}`);
    }
    if (!addressesEqual(policy.allowlistedOwnerAddress, manifest.contract?.ownerAddress)) {
      add("canaryPolicy.allowlistedOwnerAddress", "must match contract.ownerAddress");
    }
    if (!addressesEqual(policy.allowlistedAccountAddress, manifest.contract?.address)) {
      add("canaryPolicy.allowlistedAccountAddress", "must match contract.address");
    }
  }

  requireHash(manifest.release?.runtimeBytecodeKeccak256, "release.runtimeBytecodeKeccak256");
  requireEqual(
    manifest.release?.runtimeBytecodeKeccak256,
    binding.runtimeBytecodeHash,
    "release.runtimeBytecodeKeccak256",
  );
  if (
    typeof manifest.release?.runtimeBytecodeKeccak256 === "string" &&
    typeof manifest.contract?.runtimeBytecodeHash === "string" &&
    manifest.release.runtimeBytecodeKeccak256.toLowerCase() !== manifest.contract.runtimeBytecodeHash.toLowerCase()
  ) {
    add("release.runtimeBytecodeKeccak256", "must match contract.runtimeBytecodeHash");
  }
  if (typeof manifest.release?.abiSha256 !== "string" || !SHA256_PATTERN.test(manifest.release.abiSha256)) {
    add("release.abiSha256", "must be an ABI SHA-256 digest");
  }
  requireEqual(manifest.release?.abiSha256, binding.abiSha256, "release.abiSha256");

  if (!isRecord(artifactDigests)) {
    add("artifactDigests", "are required for fail-closed canary validation");
  } else {
    requireEqual(
      manifest.release?.packageLockSha256,
      artifactDigests.packageLockSha256,
      "release.packageLockSha256",
    );
    requireEqual(
      manifest.release?.creationBytecodeKeccak256,
      artifactDigests.creationBytecodeKeccak256,
      "release.creationBytecodeKeccak256",
    );
    requireEqual(
      manifest.contract?.creationBytecodeHash,
      artifactDigests.creationBytecodeKeccak256,
      "contract.creationBytecodeHash",
    );
  }

  return { valid: errors.length === 0, errors };
}

export function assertMainnetCanaryManifest(manifest, options = {}) {
  const result = validateMainnetCanaryManifest(manifest, options);
  if (!result.valid) {
    throw new Error(`PRODUCTION_NOT_READY: invalid mainnet canary manifest (${result.errors.join("; ")})`);
  }
  return manifest;
}

export async function generateMainnetActivatedManifest({ outputPath = MAINNET_ACTIVATED_MANIFEST_PATH } = {}) {
  const artifactDigests = await computeArtifactDigests();
  const shadowManifest = JSON.parse(await readFile(MAINNET_SHADOW_MANIFEST_PATH, "utf8"));
  assertMainnetShadowManifest(shadowManifest, { artifactDigests });
  const manifest = buildMainnetActivatedManifest({ shadowManifest });
  const result = validateMainnetActivationManifest(manifest, { artifactDigests });
  if (!result.valid) throw new Error(`Invalid mainnet activation manifest: ${result.errors.join("; ")}`);

  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    outputPath: resolvedOutputPath,
    manifest,
    artifactDigests,
    manifestSha256: computeActivationManifestSha256(manifest),
  };
}

export async function generateMainnetCanaryManifest({
  sourcePath = MAINNET_ACTIVATED_MANIFEST_PATH,
  outputPath = MAINNET_CANARY_MANIFEST_PATH,
  artifactDigests: suppliedArtifactDigests,
} = {}) {
  const resolvedSourcePath = resolve(sourcePath);
  const resolvedOutputPath = resolve(outputPath);
  if (resolvedSourcePath === resolvedOutputPath) {
    throw new Error("Canary source and output paths must differ; the DEPLOYED/OFF manifest is immutable.");
  }

  const artifactDigests = suppliedArtifactDigests ?? await computeArtifactDigests();
  const deployedManifest = JSON.parse(await readFile(resolvedSourcePath, "utf8"));
  const sourceValidation = validateMainnetActivationManifest(deployedManifest, { artifactDigests });
  if (!sourceValidation.valid) {
    throw new Error(`Invalid DEPLOYED/OFF source manifest: ${sourceValidation.errors.join("; ")}`);
  }
  if (deployedManifest.activation?.accountDeployment !== "DEPLOYED") {
    throw new Error("Canary generation requires a DEPLOYED account in the DEPLOYED/OFF source manifest.");
  }

  const boundManifest = bindMainnetCanaryPolicy({
    deployedManifest,
    tenantId: MAINNET_CANARY_BINDING.tenantId,
    payerAddress: MAINNET_CANARY_BINDING.payerAddress,
    recipientAddress: MAINNET_CANARY_BINDING.recipientAddress,
  });
  const manifest = buildMainnetCanaryManifest({
    deployedManifest: boundManifest,
    projectRef: MAINNET_CANARY_BINDING.projectRef,
    releaseCommit: MAINNET_CANARY_BINDING.releaseCommit,
    publicOrigin: MAINNET_CANARY_BINDING.publicOrigin,
  });
  assertMainnetCanaryManifest(manifest, { artifactDigests });

  await writeCanaryManifestAtomically(resolvedOutputPath, manifest);

  return {
    sourcePath: resolvedSourcePath,
    outputPath: resolvedOutputPath,
    manifest,
    artifactDigests,
    manifestSha256: computeActivationManifestSha256(manifest),
  };
}

function requireCliValue(value, optionName) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${optionName}.`);
  }
  return value;
}

function parseCliArgs(args) {
  const options = { mode: "activate" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--canary") {
      options.mode = "canary";
    } else if (arg === "--source") {
      options.sourcePath = requireCliValue(args[index + 1], arg);
      index += 1;
    } else if (arg === "--out") {
      options.outputPath = requireCliValue(args[index + 1], arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.mode !== "canary" && options.sourcePath) {
    throw new Error("--source is only valid with --canary.");
  }
  return options;
}

function helpText() {
  return [
    "Generate a non-secret Celo mainnet activation manifest.",
    "",
    "Usage:",
    "  npm run manifest:mainnet:activate [-- --out path]",
    "  npm run manifest:mainnet:activate -- --canary [--source path] [--out path]",
    "",
    `DEPLOYED/OFF output: ${MAINNET_ACTIVATED_MANIFEST_PATH}`,
    `READY/CANARY output: ${MAINNET_CANARY_MANIFEST_PATH}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
    } else if (options.mode === "canary") {
      const result = await generateMainnetCanaryManifest({
        sourcePath: options.sourcePath,
        outputPath: options.outputPath,
      });
      console.log(`Generated READY/CANARY manifest at ${result.outputPath}`);
      console.log(`Source DEPLOYED/OFF manifest: ${result.sourcePath}`);
      console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    } else {
      const result = await generateMainnetActivatedManifest({ outputPath: options.outputPath });
      console.log(`Generated DEPLOYED/OFF activation manifest at ${result.outputPath}`);
      console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to generate mainnet activation manifest.");
    process.exitCode = 1;
  }
}
