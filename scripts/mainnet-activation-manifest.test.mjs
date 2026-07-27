import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAINNET_ACTIVATED_MANIFEST_PATH,
  MAINNET_CANARY_BINDING,
  buildMainnetActivatedManifest,
  buildMainnetCanaryManifest,
  buildMainnetDeployedManifest,
  bindMainnetCanaryPolicy,
  computeActivationManifestSha256,
  generateMainnetCanaryManifest,
  validateMainnetActivationManifest,
  validateMainnetCanaryManifest,
} from "./mainnet-activation-manifest.mjs";
import { buildMainnetShadowManifest, computeArtifactDigests } from "./mainnet-shadow-manifest.mjs";

const artifactDigests = await computeArtifactDigests();
const shadowManifest = buildMainnetShadowManifest({
  artifactDigests,
  generatedAt: "2026-07-13T00:00:00.000Z",
});
const deployedMainnetManifest = JSON.parse(
  await readFile(MAINNET_ACTIVATED_MANIFEST_PATH, "utf8"),
);
const frozenArtifactDigests = Object.freeze({
  packageLockSha256: deployedMainnetManifest.release.packageLockSha256,
  creationBytecodeKeccak256: deployedMainnetManifest.release.creationBytecodeKeccak256,
});

function makeProductionCanaryManifest() {
  const boundManifest = bindMainnetCanaryPolicy({
    deployedManifest: deployedMainnetManifest,
    tenantId: MAINNET_CANARY_BINDING.tenantId,
    payerAddress: MAINNET_CANARY_BINDING.payerAddress,
    recipientAddress: MAINNET_CANARY_BINDING.recipientAddress,
  });

  return buildMainnetCanaryManifest({
    deployedManifest: boundManifest,
    projectRef: MAINNET_CANARY_BINDING.projectRef,
    releaseCommit: MAINNET_CANARY_BINDING.releaseCommit,
    publicOrigin: MAINNET_CANARY_BINDING.publicOrigin,
  });
}

describe("Celo mainnet activation manifest", () => {
  it("promotes the frozen shadow surface to DEPLOYED/OFF without provisioning an account", () => {
    const manifest = buildMainnetActivatedManifest({ shadowManifest });
    const result = validateMainnetActivationManifest(manifest, { artifactDigests });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(manifest.status, "DEPLOYED");
    assert.equal(manifest.executionMode, "OFF");
    assert.equal(manifest.x402.enabled, false);
    assert.equal(manifest.activation.accountDeployment, "PENDING");
    assert.equal(manifest.contract.address, null);
    assert.equal(manifest.contract.domain.verifyingContract, null);
    assert.match(computeActivationManifestSha256(manifest), /^[a-f0-9]{64}$/);
  });

  it("rejects activation drift that could silently enable execution or deployment", () => {
    const manifest = buildMainnetActivatedManifest({ shadowManifest });
    manifest.executionMode = "PUBLIC";
    manifest.contract.executorAddress = "0x1111111111111111111111111111111111111111";
    manifest.x402.enabled = true;

    const result = validateMainnetActivationManifest(manifest, { artifactDigests });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /executionMode/);
    assert.match(result.errors.join("; "), /executorAddress/);
    assert.match(result.errors.join("; "), /x402.enabled/);
  });

  it("preserves the artifact pins from the canonical shadow manifest", () => {
    const source = structuredClone(shadowManifest);
    const manifest = buildMainnetActivatedManifest({ shadowManifest: source });
    assert.equal(manifest.release.packageLockSha256, source.release.packageLockSha256);
    assert.equal(manifest.release.creationBytecodeKeccak256, source.release.creationBytecodeKeccak256);
    assert.equal(manifest.contract.creationBytecodeHash, source.contract.creationBytecodeHash);
  });

  it("promotes the OFF activation surface after a verified immutable account deployment", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    const result = validateMainnetActivationManifest(deployed, { artifactDigests });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(deployed.activation.accountDeployment, "DEPLOYED");
    assert.equal(deployed.executionMode, "OFF");
    assert.equal(deployed.x402.enabled, false);
    assert.equal(deployed.contract.domain.verifyingContract, deployed.contract.address);
    assert.equal(deployed.release.runtimeBytecodeKeccak256, deployed.contract.runtimeBytecodeHash);
    assert.match(computeActivationManifestSha256(deployed), /^[a-f0-9]{64}$/);
  });

  it("rejects a deployed manifest with incomplete account identity", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    activationManifest.activation.accountDeployment = "DEPLOYED";

    const result = validateMainnetActivationManifest(activationManifest, { artifactDigests });

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /contract.address/);
    assert.match(result.errors.join("; "), /release.runtimeBytecodeKeccak256/);
  });

  it("binds one tenant, payer, and self-recipient without enabling execution", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    const bound = bindMainnetCanaryPolicy({
      deployedManifest: deployed,
      tenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });

    assert.equal(bound.executionMode, "OFF");
    assert.equal(bound.x402.enabled, false);
    assert.deepEqual(bound.canaryPolicy, {
      ...deployed.canaryPolicy,
      allowlistedTenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      allowlistedOwnerAddress: "0x4444444444444444444444444444444444444444",
      allowlistedAccountAddress: "0x1111111111111111111111111111111111111111",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });
  });

  it("rejects malformed canary binding input", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    assert.throws(
      () => bindMainnetCanaryPolicy({
        deployedManifest: deployed,
        tenantId: "not-a-uuid",
        payerAddress: "0x4444444444444444444444444444444444444444",
        recipientAddress: "0x4444444444444444444444444444444444444444",
      }),
      /tenantId/i,
    );
  });

  it("promotes only a fully bound deployed manifest to READY/CANARY", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = bindMainnetCanaryPolicy({
      deployedManifest: buildMainnetDeployedManifest({
        activationManifest,
        deployment: {
          accountAddress: "0x1111111111111111111111111111111111111111",
          deploymentTxHash: `0x${"2".repeat(64)}`,
          runtimeBytecodeHash: `0x${"3".repeat(64)}`,
          abiSha256: "4".repeat(64),
          ownerAddress: "0x4444444444444444444444444444444444444444",
          executorAddress: "0x5555555555555555555555555555555555555555",
          deployerAddress: "0x6666666666666666666666666666666666666666",
        },
      }),
      tenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });

    const canary = buildMainnetCanaryManifest({
      deployedManifest: deployed,
      projectRef: "zcwsmivbgcrfyrvfptxk",
      releaseCommit: "a".repeat(40),
      publicOrigin: "https://mcp.agentpay.site",
    });

    assert.equal(canary.status, "READY");
    assert.equal(canary.executionMode, "CANARY");
    assert.equal(canary.x402.enabled, true);
    assert.equal(canary.activation.executionEnabled, true);
    assert.equal(canary.onboarding.setupMode, "CANARY");
    assert.equal(canary.canaryPolicy.maxAcceptedLifecycles, 2);
    assert.equal(canary.canaryPolicy.invoiceMaxUsdc, "0.05");
    assert.equal(canary.canaryPolicy.accountFundingUsdc, "0.05");
    assert.equal(canary.canaryPolicy.payerFeeWalletFundingMaxUsdc, "0.05");
    assert.equal(canary.canaryPolicy.aspFeeUsdc, "0.01");
    assert.equal(canary.canaryPolicy.executorGasMaxCelo, "0.05");
    assert.equal(
      canary.secretRefs.setupDeployerPrivateKeyEnvRef,
      "AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY",
    );
    assert.equal(canary.database.projectRef, "zcwsmivbgcrfyrvfptxk");
    assert.equal(canary.release.commit, "a".repeat(40));
    assert.equal(canary.domains.publicOrigin, "https://mcp.agentpay.site");
    assert.equal(canary.canaryPolicy.allowlistedTenantId, "55def02c-c219-4d98-aa56-445795c9d0ff");
  });

  it("refuses READY/CANARY promotion without immutable release metadata or policy", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    assert.throws(
      () => buildMainnetCanaryManifest({
        deployedManifest: deployed,
        projectRef: "zcwsmivbgcrfyrvfptxk",
        releaseCommit: "not-a-commit",
        publicOrigin: "https://mcp.agentpay.site",
      }),
      /releaseCommit/i,
    );
  });

  it("generates a reproducible production READY/CANARY artifact without overwriting DEPLOYED/OFF", async (testContext) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentpay-mainnet-canary-"));
    testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
    const outputPath = join(temporaryDirectory, "celo-mainnet.canary.json");
    const sourceBefore = await readFile(MAINNET_ACTIVATED_MANIFEST_PATH, "utf8");

    const first = await generateMainnetCanaryManifest({
      outputPath,
      artifactDigests: frozenArtifactDigests,
    });
    const firstOutput = await readFile(outputPath, "utf8");
    const second = await generateMainnetCanaryManifest({
      outputPath,
      artifactDigests: frozenArtifactDigests,
    });
    const secondOutput = await readFile(outputPath, "utf8");
    const sourceAfter = await readFile(MAINNET_ACTIVATED_MANIFEST_PATH, "utf8");
    const validation = validateMainnetCanaryManifest(first.manifest, {
      artifactDigests: frozenArtifactDigests,
    });

    assert.equal(validation.valid, true, validation.errors.join("; "));
    assert.equal(sourceAfter, sourceBefore);
    assert.equal(secondOutput, firstOutput);
    assert.deepEqual(second.manifest, first.manifest);
    assert.notEqual(first.outputPath, MAINNET_ACTIVATED_MANIFEST_PATH);
    assert.deepEqual(first.manifest.canaryPolicy, {
      ...deployedMainnetManifest.canaryPolicy,
      maxAcceptedLifecycles: 2,
      invoiceMaxUsdc: "0.05",
      accountFundingUsdc: "0.05",
      payerFeeWalletFundingMaxUsdc: "0.05",
      aspFeeUsdc: "0.01",
      executorGasMaxCelo: "0.05",
      allowlistedTenantId: "3cf8d1e5-3b17-4069-b2ec-7db81752e415",
      allowlistedOwnerAddress: deployedMainnetManifest.contract.ownerAddress,
      allowlistedAccountAddress: deployedMainnetManifest.contract.address,
      payerAddress: "0x98802C2d45284F2bcA06BF3d6bdb41221a7Cc5cD",
      recipientAddress: "0x9CEef6d89915628331C25F48360FfE97CD71B3EE",
    });
    assert.equal(first.manifest.database.projectRef, "hxnrqujmyltkumfipkuk");
    assert.equal(first.manifest.release.commit, "725bab9a446364dbf4086263c9f679d1869ea416");
    assert.equal(first.manifest.domains.publicOrigin, "https://mcp.agentpay.site");
    assert.equal(deployedMainnetManifest.canaryPolicy.maxAcceptedLifecycles, 1);
  });

  it("fails closed if the second-attempt canary lifecycle cap drifts", () => {
    const canary = makeProductionCanaryManifest();
    const staleLimit = {
      ...canary,
      canaryPolicy: {
        ...canary.canaryPolicy,
        maxAcceptedLifecycles: 1,
      },
    };
    const expandedLimit = {
      ...canary,
      canaryPolicy: {
        ...canary.canaryPolicy,
        maxAcceptedLifecycles: 3,
      },
    };

    const staleResult = validateMainnetCanaryManifest(staleLimit, { artifactDigests });
    const expandedResult = validateMainnetCanaryManifest(expandedLimit, { artifactDigests });

    assert.equal(staleResult.valid, false);
    assert.match(staleResult.errors.join("; "), /canaryPolicy\.maxAcceptedLifecycles/);
    assert.equal(expandedResult.valid, false);
    assert.match(expandedResult.errors.join("; "), /canaryPolicy\.maxAcceptedLifecycles/);
  });

  it("refuses to use the DEPLOYED/OFF source path as canary output", async () => {
    const sourceBefore = await readFile(MAINNET_ACTIVATED_MANIFEST_PATH, "utf8");

    await assert.rejects(
      generateMainnetCanaryManifest({ outputPath: MAINNET_ACTIVATED_MANIFEST_PATH }),
      /source and output paths must differ/i,
    );

    assert.equal(await readFile(MAINNET_ACTIVATED_MANIFEST_PATH, "utf8"), sourceBefore);
  });

  it("fails READY/CANARY validation closed for unbound policy and activation drift", () => {
    const canary = makeProductionCanaryManifest();
    const unboundPolicy = {
      ...canary,
      canaryPolicy: {
        ...canary.canaryPolicy,
        payerAddress: null,
      },
    };
    const activationDrift = {
      ...canary,
      activation: {
        ...canary.activation,
        accountDeployment: "PENDING",
        executionEnabled: false,
      },
    };

    const unboundResult = validateMainnetCanaryManifest(unboundPolicy, { artifactDigests });
    const activationResult = validateMainnetCanaryManifest(activationDrift, { artifactDigests });

    assert.equal(unboundResult.valid, false);
    assert.match(unboundResult.errors.join("; "), /canaryPolicy\.payerAddress/);
    assert.equal(activationResult.valid, false);
    assert.match(activationResult.errors.join("; "), /activation\.accountDeployment/);
    assert.match(activationResult.errors.join("; "), /activation\.executionEnabled/);
  });

  it("fails READY/CANARY validation closed for network, token, release, origin, and artifact drift", () => {
    const canary = makeProductionCanaryManifest();
    const driftCases = [
      {
        manifest: { ...canary, x402: { ...canary.x402, network: "eip155:11142220" } },
        expectedPath: /x402\.network/,
      },
      {
        manifest: {
          ...canary,
          token: { ...canary.token, address: "0x1111111111111111111111111111111111111111" },
        },
        expectedPath: /token\.address/,
      },
      {
        manifest: { ...canary, database: { ...canary.database, projectRef: "zcwsmivbgcrfyrvfptxk" } },
        expectedPath: /database\.projectRef/,
      },
      {
        manifest: { ...canary, release: { ...canary.release, commit: "a".repeat(40) } },
        expectedPath: /release\.commit/,
      },
      {
        manifest: { ...canary, domains: { ...canary.domains, publicOrigin: "https://wallet.agentpay.site" } },
        expectedPath: /domains\.publicOrigin/,
      },
      {
        manifest: { ...canary, release: { ...canary.release, packageLockSha256: "0".repeat(64) } },
        expectedPath: /release\.packageLockSha256/,
      },
      {
        manifest: {
          ...canary,
          release: { ...canary.release, creationBytecodeKeccak256: `0x${"0".repeat(64)}` },
        },
        expectedPath: /release\.creationBytecodeKeccak256/,
      },
    ];

    for (const { manifest, expectedPath } of driftCases) {
      const result = validateMainnetCanaryManifest(manifest, { artifactDigests });
      assert.equal(result.valid, false);
      assert.match(result.errors.join("; "), expectedPath);
    }

    const missingArtifactPins = validateMainnetCanaryManifest(canary);
    assert.equal(missingArtifactPins.valid, false);
    assert.match(missingArtifactPins.errors.join("; "), /artifactDigests/);
  });

  it("rejects coordinated deployment identity drift even when policy and domain remain internally consistent", () => {
    const canary = makeProductionCanaryManifest();
    const driftedAccountAddress = "0x1111111111111111111111111111111111111111";
    const identityDrift = {
      ...canary,
      contract: {
        ...canary.contract,
        address: driftedAccountAddress,
        deploymentTxHash: `0x${"2".repeat(64)}`,
        executorAddress: "0x3333333333333333333333333333333333333333",
        deployerAddress: "0x4444444444444444444444444444444444444444",
        domain: {
          ...canary.contract.domain,
          verifyingContract: driftedAccountAddress,
        },
      },
      canaryPolicy: {
        ...canary.canaryPolicy,
        allowlistedAccountAddress: driftedAccountAddress,
      },
    };

    const result = validateMainnetCanaryManifest(identityDrift, { artifactDigests });

    assert.equal(result.valid, false);
    for (const path of [
      "contract.address",
      "contract.deploymentTxHash",
      "contract.executorAddress",
      "contract.deployerAddress",
      "contract.domain.verifyingContract",
    ]) {
      assert.match(result.errors.join("; "), new RegExp(path.replaceAll(".", "\\.")));
    }
  });

  it("rejects x402 env-ref and consumer/SIWE origin drift", () => {
    const canary = makeProductionCanaryManifest();
    const bindingDrift = {
      ...canary,
      x402: {
        ...canary.x402,
        payToEnvRef: "ATTACKER_PAY_TO",
        facilitatorEnvRef: "ATTACKER_FACILITATOR_URL",
      },
      domains: {
        ...canary.domains,
        consumerOrigin: "https://attacker.example/celo/mcp",
        siweAudience: "https://attacker.example/celo/mcp",
      },
    };

    const result = validateMainnetCanaryManifest(bindingDrift, { artifactDigests });

    assert.equal(result.valid, false);
    for (const path of [
      "x402.payToEnvRef",
      "x402.facilitatorEnvRef",
      "domains.consumerOrigin",
      "domains.siweAudience",
    ]) {
      assert.match(result.errors.join("; "), new RegExp(path.replaceAll(".", "\\.")));
    }
  });

  it("rejects onboarding mode drift after READY/CANARY promotion", () => {
    const canary = makeProductionCanaryManifest();
    const onboardingDrift = {
      ...canary,
      onboarding: {
        ...canary.onboarding,
        setupMode: "OFF",
      },
    };

    assert.equal(canary.onboarding.setupMode, "CANARY");
    const result = validateMainnetCanaryManifest(onboardingDrift, { artifactDigests });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /onboarding\.setupMode/);
  });

  it("pins the approved canary funding limits and rejects stale policy drift", () => {
    const canary = makeProductionCanaryManifest();
    const expectedPolicy = {
      invoiceMaxUsdc: "0.05",
      accountFundingUsdc: "0.05",
      payerFeeWalletFundingMaxUsdc: "0.05",
      aspFeeUsdc: "0.01",
      executorGasMaxCelo: "0.05",
    };

    for (const [key, value] of Object.entries(expectedPolicy)) {
      assert.equal(canary.canaryPolicy[key], value);
    }

    const stalePolicy = {
      ...canary,
      canaryPolicy: {
        ...canary.canaryPolicy,
        invoiceMaxUsdc: "0.10",
        accountFundingUsdc: "0.10",
        payerFeeWalletFundingMaxUsdc: "0.02",
        executorGasMaxCelo: "0.005",
      },
    };
    const result = validateMainnetCanaryManifest(stalePolicy, { artifactDigests });

    assert.equal(result.valid, false);
    for (const path of [
      "invoiceMaxUsdc",
      "accountFundingUsdc",
      "payerFeeWalletFundingMaxUsdc",
      "executorGasMaxCelo",
    ]) {
      assert.match(result.errors.join("; "), new RegExp(`canaryPolicy\\.${path}`));
    }
  });

  it("pins isolated production secret env refs and rejects the stale setup deployer name", () => {
    const canary = makeProductionCanaryManifest();
    assert.deepEqual(canary.secretRefs, {
      namespace: "agentpay-celo/production",
      executorPrivateKeyEnvRef: "EXECUTOR_PRIVATE_KEY",
      setupDeployerPrivateKeyEnvRef: "AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY",
      sessionHashKeyEnvRef: "AGENTPAY_SESSION_HASH_KEY",
      reviewTokenSecretEnvRef: "AGENTPAY_REVIEW_TOKEN_SECRET",
      rawTransactionEncryptionKeyEnvRef: "AGENTPAY_RAW_TX_ENCRYPTION_KEY",
    });

    const staleSecretRef = {
      ...canary,
      secretRefs: {
        ...canary.secretRefs,
        setupDeployerPrivateKeyEnvRef: "SETUP_DEPLOYER_PRIVATE_KEY",
      },
    };
    const result = validateMainnetCanaryManifest(staleSecretRef, { artifactDigests });

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /secretRefs\.setupDeployerPrivateKeyEnvRef/);
  });

  it("rejects secret-bearing keys and unexpected canary policy fields", () => {
    const canary = makeProductionCanaryManifest();
    const secretBearing = {
      ...canary,
      executorPrivateKey: "must-never-be-copied",
    };
    const expandedPolicy = {
      ...canary,
      canaryPolicy: {
        ...canary.canaryPolicy,
        allowlistedTenantIds: [canary.canaryPolicy.allowlistedTenantId],
      },
    };

    const secretResult = validateMainnetCanaryManifest(secretBearing, { artifactDigests });
    const policyResult = validateMainnetCanaryManifest(expandedPolicy, { artifactDigests });

    assert.equal(secretResult.valid, false);
    assert.match(secretResult.errors.join("; "), /executorPrivateKey.*secret-bearing/i);
    assert.equal(policyResult.valid, false);
    assert.match(policyResult.errors.join("; "), /canaryPolicy\.allowlistedTenantIds.*unexpected/i);
  });

  it("rejects a symlink output without changing its target", async (testContext) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentpay-mainnet-canary-symlink-"));
    testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
    const protectedPath = join(temporaryDirectory, "protected.txt");
    const outputPath = join(temporaryDirectory, "celo-mainnet.canary.json");
    await writeFile(protectedPath, "protected\n", "utf8");
    await symlink(protectedPath, outputPath);

    await assert.rejects(
      generateMainnetCanaryManifest({
        outputPath,
        artifactDigests: frozenArtifactDigests,
      }),
      /symbolic link/i,
    );

    assert.equal(await readFile(protectedPath, "utf8"), "protected\n");
  });
});
