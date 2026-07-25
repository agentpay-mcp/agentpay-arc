import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, Interface, TypedDataEncoder, Wallet } from "ethers";

import {
  AGENTPAY_ERC8004_METADATA_URL,
  CELO_MAINNET_IDENTITY_REGISTRY,
  createAgentPayErc8004Registration,
} from "@agentpay-ai/shared-arc";

import {
  buildErc8004RegisterTransaction,
  buildErc8004SetAgentWalletTransaction,
  createErc8004AgentWalletProofTypedData,
  runErc8004Cli,
  verifyErc8004OnchainIdentity,
  verifyLiveAgentRegistration,
} from "./erc8004-registration.ts";

const registryInterface = new Interface([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)",
]);
const owner = new Wallet(`0x${"11".repeat(32)}`);
const agentWallet = "0x1234567890abcdef1234567890abcdef12345678";

describe("ERC-8004 operator transaction preparation", () => {
  it("encodes registration only for the pinned live AgentPay metadata URL", () => {
    const transaction = buildErc8004RegisterTransaction(AGENTPAY_ERC8004_METADATA_URL);
    const decoded = registryInterface.decodeFunctionData("register", transaction.data);

    assert.deepEqual(transaction, {
      chainId: 42220,
      to: CELO_MAINNET_IDENTITY_REGISTRY,
      data: transaction.data,
      value: "0",
    });
    assert.equal(decoded.agentURI, AGENTPAY_ERC8004_METADATA_URL);
    assert.throws(() => buildErc8004RegisterTransaction("https://example.com/agent.json"), /metadata URL/i);
  });

  it("builds the exact registry EIP-712 proof and verifies it before encoding setAgentWallet", async () => {
    const deadline = 1_784_633_240;
    const typedData = createErc8004AgentWalletProofTypedData({
      agentId: 42,
      newWallet: agentWallet,
      owner: owner.address,
      deadline,
    });
    const signature = await owner.signTypedData(typedData.domain, typedData.types, typedData.message);
    const transaction = buildErc8004SetAgentWalletTransaction({
      agentId: 42,
      newWallet: agentWallet,
      owner: owner.address,
      deadline,
      signature,
    });
    const decoded = registryInterface.decodeFunctionData("setAgentWallet", transaction.data);

    assert.deepEqual(typedData.domain, {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: 42220,
      verifyingContract: CELO_MAINNET_IDENTITY_REGISTRY,
    });
    assert.equal(TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message).startsWith("0x"), true);
    assert.equal(decoded.agentId, 42n);
    assert.equal(decoded.newWallet.toLowerCase(), agentWallet.toLowerCase());
    assert.equal(decoded.deadline, BigInt(deadline));
    assert.equal(decoded.signature, signature);
  });

  it("rejects a wallet-proof signature from anyone except the immutable AgentPay owner", async () => {
    const attacker = new Wallet(`0x${"22".repeat(32)}`);
    const input = { agentId: 42, newWallet: agentWallet, owner: owner.address, deadline: 1_784_633_240 };
    const typedData = createErc8004AgentWalletProofTypedData(input);
    const signature = await attacker.signTypedData(typedData.domain, typedData.types, typedData.message);

    assert.throws(
      () => buildErc8004SetAgentWalletTransaction({ ...input, signature }),
      /owner signature/i,
    );
  });

  it("verifies the public metadata before preparing an irreversible registry pointer", async () => {
    const metadata = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet });
    const verified = await verifyLiveAgentRegistration({
      agentWalletAddress: getAddress(agentWallet),
      fetch: async () => new Response(JSON.stringify(metadata), { status: 200 }),
    });

    assert.deepEqual(verified, metadata);
    await assert.rejects(
      () => verifyLiveAgentRegistration({
        agentWalletAddress: agentWallet,
        fetch: async () => new Response("not found", { status: 404 }),
      }),
      /not reachable/i,
    );
    await assert.rejects(
      () => verifyLiveAgentRegistration({
        agentWalletAddress: agentWallet,
        fetch: async () => new Response(JSON.stringify({ ...metadata, services: metadata.services.slice(0, 2) })),
      }),
      /invalid/i,
    );
  });

  it("verifies chain, owner, URI, agent wallet, and domain registration as one identity", async () => {
    const metadata = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet, agentId: 42 });
    const evidence = await verifyErc8004OnchainIdentity({
      agentId: 42,
      ownerAddress: owner.address,
      agentWalletAddress: agentWallet,
      reader: {
        async getChainId() { return 42220; },
        async ownerOf() { return owner.address; },
        async tokenUri() { return AGENTPAY_ERC8004_METADATA_URL; },
        async getAgentWallet() { return agentWallet; },
      },
      fetch: async () => new Response(JSON.stringify(metadata)),
    });

    assert.deepEqual(evidence, {
      chainId: 42220,
      identityRegistry: CELO_MAINNET_IDENTITY_REGISTRY,
      agentId: 42,
      ownerAddress: owner.address,
      agentWalletAddress: getAddress(agentWallet),
      agentUri: AGENTPAY_ERC8004_METADATA_URL,
      domainRegistrationVerified: true,
    });

    await assert.rejects(
      () => verifyErc8004OnchainIdentity({
        agentId: 42,
        ownerAddress: owner.address,
        agentWalletAddress: agentWallet,
        reader: {
          async getChainId() { return 42220; },
          async ownerOf() { return owner.address; },
          async tokenUri() { return AGENTPAY_ERC8004_METADATA_URL; },
          async getAgentWallet() { return "0x9999999999999999999999999999999999999999"; },
        },
        fetch: async () => new Response(JSON.stringify(metadata)),
      }),
      /wallet mismatch/i,
    );
  });

  it("runs every operator command through explicit read-only dependencies", async () => {
    const agentId = 42;
    const deadline = 1_784_633_240;
    const registeredMetadata = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet, agentId });
    const bootstrapMetadata = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet });
    const typedData = createErc8004AgentWalletProofTypedData({
      agentId,
      newWallet: agentWallet,
      owner: owner.address,
      deadline,
    });
    const signature = await owner.signTypedData(typedData.domain, typedData.types, typedData.message);
    const outputs: unknown[] = [];
    const baseEnv = {
      AGENTPAY_ERC8004_AGENT_ID: String(agentId),
      AGENTPAY_ERC8004_AGENT_WALLET: agentWallet,
      AGENTPAY_OWNER_ADDRESS: owner.address,
      CELO_MAINNET_RPC_URL: "https://forno.celo.org",
    };
    const dependencies = {
      now: () => (deadline - 240) * 1_000,
      fetch: async () => new Response(JSON.stringify(registeredMetadata)),
      identityReader: {
        async getChainId() { return 42220; },
        async ownerOf() { return owner.address; },
        async tokenUri() { return AGENTPAY_ERC8004_METADATA_URL; },
        async getAgentWallet() { return agentWallet; },
      },
      write: (payload: unknown) => { outputs.push(payload); },
    };

    await runErc8004Cli(["register"], baseEnv, {
      ...dependencies,
      fetch: async () => new Response(JSON.stringify(bootstrapMetadata)),
    });
    await runErc8004Cli(["wallet-proof"], baseEnv, dependencies);
    await runErc8004Cli(["set-wallet"], {
      ...baseEnv,
      AGENTPAY_ERC8004_WALLET_PROOF_DEADLINE: String(deadline),
      AGENTPAY_ERC8004_WALLET_PROOF_SIGNATURE: signature,
    }, dependencies);
    await runErc8004Cli(["verify"], baseEnv, dependencies);

    assert.deepEqual(
      outputs.map((output) => (output as { action: string }).action),
      ["REGISTER_AGENT", "SIGN_AGENT_WALLET_PROOF", "SET_AGENT_WALLET", "VERIFY_AGENT_IDENTITY"],
    );
    assert.equal(
      ((outputs[1] as { typedData: { message: { deadline: number } } }).typedData.message.deadline),
      deadline,
    );

    for (const [invalidDeadline, expectedError] of [
      [deadline - 241, /expired/i],
      [deadline + 61, /five minutes/i],
    ] as const) {
      const invalidTypedData = createErc8004AgentWalletProofTypedData({
        agentId,
        newWallet: agentWallet,
        owner: owner.address,
        deadline: invalidDeadline,
      });
      const invalidSignature = await owner.signTypedData(
        invalidTypedData.domain,
        invalidTypedData.types,
        invalidTypedData.message,
      );
      await assert.rejects(() => runErc8004Cli(["set-wallet"], {
        ...baseEnv,
        AGENTPAY_ERC8004_WALLET_PROOF_DEADLINE: String(invalidDeadline),
        AGENTPAY_ERC8004_WALLET_PROOF_SIGNATURE: invalidSignature,
      }, dependencies), expectedError);
    }
    await assert.rejects(() => runErc8004Cli(["unknown"], baseEnv, dependencies), /Usage:/);
  });
});
