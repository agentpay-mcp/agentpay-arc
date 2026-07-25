import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromDataSuffix } from "@celo/attribution-tags";
import { Interface, Transaction, TypedDataEncoder, keccak256 } from "ethers";

import type { SetupWorkerClaim } from "@agentpay-ai/mcp-server-arc";
import {
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDC,
  MAINNET_WALLET_SETUP_TYPES,
} from "@agentpay-ai/shared-arc";
import {
  buildSetupAuthorizationFromClaim,
  buildSetupDeploymentTransaction,
  decryptSetupRawTransaction,
  encryptSetupRawTransaction,
  signSetupDeploymentTransaction,
} from "./setup-transaction.ts";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const deployer = "0x4444444444444444444444444444444444444444";
const predicted = "0x5555555555555555555555555555555555555555";
const attributionTag = "celo_agentpay";
const hash = (digit: string) => `0x${digit.repeat(64)}`;

function claim(): SetupWorkerClaim {
  const authorization = {
    setupIntentId: "setup-production-worker-0001", deploymentNonce: hash("1"), owner, executor,
    homeChainId: 42220, environment: "production", deadline: "1784265300", factory,
    factoryRuntimeCodeHash: hash("3"), deploymentSalt: hash("4"), predictedAccount: predicted,
    accountCreationCodeHash: hash("5"), accountRuntimeCodeHash: hash("6"), token: MAINNET_SETUP_USDC,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH, manifestSha256: hash("2"),
  } as const;
  return Object.freeze({
    disposition: "CLAIMED",
    jobStatus: "SIGNING",
    jobId: "00000000-0000-4000-8000-000000000001",
    setupIntentId: authorization.setupIntentId,
    tenantId: "00000000-0000-4000-8000-000000000002",
    fencingToken: "00000000-0000-4000-8000-000000000003",
    leaseUntil: "2026-07-17T05:02:00.000Z",
    ownerSetupSignature: `0x${"12".repeat(65)}`,
    ownerAddress: owner,
    executorAddress: executor,
    homeChainId: 42220,
    deploymentNonce: hash("1"),
    manifestSha256: hash("2"),
    factoryAddress: factory,
    factoryRuntimeCodeHash: hash("3"),
    deploymentSalt: hash("4"),
    predictedAccount: predicted,
    accountCreationCodeHash: hash("5"),
    accountRuntimeCodeHash: hash("6"),
    authorizationHash: TypedDataEncoder.hash(
      { name: "AgentPay Setup", version: "1", chainId: 42220, verifyingContract: factory },
      MAINNET_WALLET_SETUP_TYPES as never,
      authorization,
    ),
    expiresAt: "2026-07-17T05:15:00.000Z",
  });
}

describe("setup deployment transaction", () => {
  it("encodes the exact admitted factory authorization with bounded type-2 fees", () => {
    const admitted = claim();
    const transaction = buildSetupDeploymentTransaction({
      claim: admitted,
      deployerAddress: deployer,
      deployerNonce: 7n,
      gasLimit: 1_000_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      attributionTag,
      limits: {
        maxGasLimit: 2_000_000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        maxNativeCostWei: 3_000_000_000_000_000n,
      },
    });
    assert.deepEqual(
      { chainId: transaction.chainId, to: transaction.to, from: transaction.from, value: transaction.value,
        nonce: transaction.nonce, type: transaction.type, gasLimit: transaction.gasLimit },
      { chainId: 42220n, to: factory, from: deployer, value: 0n, nonce: 7, type: 2, gasLimit: 1_000_000n },
    );
    assert.deepEqual(
      fromDataSuffix(transaction.data as `0x${string}`),
      { codes: [attributionTag], schemaId: 0 },
    );

    const factoryInterface = new Interface([
      "function deployAccount((string setupIntentId,bytes32 deploymentNonce,address owner,address executor,uint256 homeChainId,string environment,uint256 deadline,address factory,bytes32 factoryRuntimeCodeHash,bytes32 deploymentSalt,address predictedAccount,bytes32 accountCreationCodeHash,bytes32 accountRuntimeCodeHash,address token,bytes32 tokenAllowlistHash,bytes32 routeAllowlistHash,bytes32 manifestSha256) authorization,bytes ownerSignature)",
    ]);
    const decoded = factoryInterface.decodeFunctionData("deployAccount", transaction.data!);
    assert.equal(decoded.authorization.setupIntentId, admitted.setupIntentId);
    assert.equal(decoded.authorization.owner.toLowerCase(), admitted.ownerAddress);
    assert.equal(decoded.authorization.executor.toLowerCase(), admitted.executorAddress);
    assert.equal(decoded.authorization.deadline, 1_784_265_300n);
    assert.equal(decoded.authorization.predictedAccount.toLowerCase(), admitted.predictedAccount);
    assert.equal(decoded.ownerSignature, admitted.ownerSetupSignature);
  });

  it("rejects actor collisions and every configured fee, gas, and native-cost cap", async () => {
    const base = {
      claim: claim(), deployerAddress: deployer, deployerNonce: 7n, gasLimit: 1_000_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      attributionTag,
      limits: { maxGasLimit: 2_000_000n, maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n, maxNativeCostWei: 3_000_000_000_000_000n },
    } as const;
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, deployerAddress: owner }), /ACTOR_COLLISION/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, gasLimit: 2_000_001n }), /GAS_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, maxFeePerGas: 3_000_000_001n }), /FEE_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, maxPriorityFeePerGas: 2_000_000_001n }), /PRIORITY_FEE_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, gasLimit: 2_000_000n, maxFeePerGas: 2_000_000_000n }), /NATIVE_COST_CAP/);

    await assert.rejects(
      signSetupDeploymentTransaction({
        transaction: buildSetupDeploymentTransaction(base),
        signer: { getAddress: async () => owner, getNonce: async () => 0, signTransaction: async () => "0x" },
      }),
      /SIGNER_MISMATCH/,
    );
  });

  it("round-trips AES-256-GCM and binds both plaintext hashes", () => {
    const rawTransaction = Transaction.from({
      type: 2, chainId: 42220, nonce: 7, to: factory, value: 0,
      gasLimit: 1_000_000, maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000_000,
      data: "0x1234", signature: { r: hash("1"), s: hash("2"), v: 27 },
    }).serialized;
    const encrypted = encryptSetupRawTransaction(rawTransaction, Buffer.alloc(32, 7), Buffer.alloc(12, 9));
    assert.equal(encrypted.hash.length, 64);
    assert.equal(decryptSetupRawTransaction(encrypted, Buffer.alloc(32, 7)), rawTransaction);
    assert.equal(keccak256(decryptSetupRawTransaction(encrypted, Buffer.alloc(32, 7))), keccak256(rawTransaction));
    assert.throws(() => decryptSetupRawTransaction({ ...encrypted, ciphertext: `${encrypted.ciphertext}00` }, Buffer.alloc(32, 7)));
  });

  it("fails closed for malformed authorization, transaction limits, and encrypted outbox envelopes", () => {
    assert.throws(
      () => buildSetupAuthorizationFromClaim(Object.freeze({ ...claim(), expiresAt: "not-a-date" })),
      /SETUP_DEADLINE_INVALID/,
    );
    assert.throws(
      () => buildSetupAuthorizationFromClaim(Object.freeze({ ...claim(), expiresAt: "1970-01-01T00:00:00.000Z" })),
      /SETUP_DEADLINE_INVALID/,
    );
    assert.throws(
      () => buildSetupAuthorizationFromClaim(Object.freeze({ ...claim(), expiresAt: "2026-07-17T05:15:00.001Z" })),
      /SETUP_DEADLINE_INVALID/,
    );
    assert.throws(
      () => buildSetupAuthorizationFromClaim(Object.freeze({ ...claim(), authorizationHash: hash("9") })),
      /SETUP_AUTHORIZATION_HASH_MISMATCH/,
    );
    assert.throws(
      () => buildSetupAuthorizationFromClaim(Object.freeze({ ...claim(), ownerSetupSignature: "0x12" })),
      /SETUP_SIGNATURE_INVALID/,
    );

    const base = {
      claim: claim(), deployerAddress: deployer, deployerNonce: 7n, gasLimit: 1_000_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      attributionTag,
      limits: { maxGasLimit: 2_000_000n, maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n, maxNativeCostWei: 3_000_000_000_000_000n },
    } as const;
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, deployerAddress: "bad" }), /SETUP_DEPLOYER_INVALID/);
    assert.throws(() => buildSetupDeploymentTransaction({
      ...base, claim: Object.freeze({ ...claim(), executorAddress: "bad" }),
    }), /SETUP_ACTOR_INVALID/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, deployerNonce: -1n }), /SETUP_NONCE_INVALID/);
    assert.throws(
      () => buildSetupDeploymentTransaction({ ...base, deployerNonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
      /SETUP_NONCE_INVALID/,
    );
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, gasLimit: 0n }), /SETUP_GAS_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, maxFeePerGas: 0n }), /SETUP_FEE_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, maxPriorityFeePerGas: 0n }), /SETUP_PRIORITY_FEE_CAP/);
    assert.throws(() => buildSetupDeploymentTransaction({ ...base, attributionTag: "agentpay" }), /Celo attribution tag/i);
    assert.throws(() => buildSetupDeploymentTransaction({
      ...base, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n,
    }), /SETUP_FEE_INVALID/);
    for (const limits of [
      { ...base.limits, maxGasLimit: 0n },
      { ...base.limits, maxFeePerGas: 0n },
      { ...base.limits, maxPriorityFeePerGas: 0n },
      { ...base.limits, maxNativeCostWei: 0n },
    ]) {
      assert.throws(() => buildSetupDeploymentTransaction({ ...base, limits }), /SETUP_LIMITS_INVALID/);
    }

    assert.throws(() => encryptSetupRawTransaction("0x12", Buffer.alloc(31), Buffer.alloc(12)), /SETUP_ENCRYPTION_KEY_INVALID/);
    assert.throws(() => encryptSetupRawTransaction("0x12", Buffer.alloc(32), Buffer.alloc(11)), /SETUP_ENCRYPTION_IV_INVALID/);
    assert.throws(() => encryptSetupRawTransaction("not-hex", Buffer.alloc(32), Buffer.alloc(12)), /SETUP_RAW_TRANSACTION_INVALID/);
    const encrypted = encryptSetupRawTransaction("0x12", Buffer.alloc(32, 7), Buffer.alloc(12, 9));
    assert.throws(() => decryptSetupRawTransaction(encrypted, Buffer.alloc(31)), /SETUP_ENCRYPTION_KEY_INVALID/);
    assert.throws(() => decryptSetupRawTransaction({ ...encrypted, hash: "bad" }, Buffer.alloc(32, 7)), /SETUP_OUTBOX_HASH_INVALID/);
    assert.throws(() => decryptSetupRawTransaction({ ...encrypted, iv: "AA" }, Buffer.alloc(32, 7)), /SETUP_OUTBOX_DECRYPT_FAILED/);
    assert.throws(() => decryptSetupRawTransaction({ ...encrypted, tag: "AA" }, Buffer.alloc(32, 7)), /SETUP_OUTBOX_DECRYPT_FAILED/);
  });
});
