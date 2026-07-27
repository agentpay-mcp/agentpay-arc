import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENTPAY_ERC8004_METADATA_URL,
  ARC_TESTNET_ERC8004_AGENT_REGISTRY,
  ARC_TESTNET_ERC8004_IDENTITY_REGISTRY,
  ARC_TESTNET_ERC8004_REPUTATION_REGISTRY,
  ARC_TESTNET_ERC8004_VALIDATION_REGISTRY,
  CELO_MAINNET_AGENT_REGISTRY,
  CELO_MAINNET_IDENTITY_REGISTRY,
  CELO_MAINNET_REPUTATION_REGISTRY,
  arcErc8004FeedbackInputSchema,
  arcErc8004RegistrationInputSchema,
  arcErc8004TrustInputSchema,
  arcErc8004ValidationResponseInputSchema,
  agentPayErc8004RegistrationSchema,
  createAgentPayErc8004Registration,
  erc8004IdentityAbi,
  erc8004ReputationAbi,
  erc8004ValidationAbi,
} from "./erc8004.ts";

const agentWallet = "0x1234567890abcdef1234567890abcdef12345678";

describe("AgentPay ERC-8004 registration metadata", () => {
  it("builds honest bootstrap metadata around the live AgentPay endpoints", () => {
    const metadata = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet });

    assert.equal(AGENTPAY_ERC8004_METADATA_URL, "https://wallet.agentpay.site/.well-known/agent-registration.json");
    assert.equal(CELO_MAINNET_IDENTITY_REGISTRY, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    assert.equal(CELO_MAINNET_REPUTATION_REGISTRY, "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    assert.equal(CELO_MAINNET_AGENT_REGISTRY, `eip155:42220:${CELO_MAINNET_IDENTITY_REGISTRY}`);
    assert.deepEqual(metadata, {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "AgentPay",
      description:
        "Owner-authorized stablecoin payment agent for direct payments, invoices, remittance routes, and x402 services on Celo, with guarded contract-call preparation.",
      image: "https://www.agentpay.site/agentpay-logo/agentpay-icon-192.png",
      services: [
        { name: "web", endpoint: "https://www.agentpay.site/" },
        { name: "MCP", endpoint: "https://mcp.agentpay.site/celo/mcp", version: "2025-06-18" },
        { name: "wallet", endpoint: `eip155:42220:${agentWallet}` },
      ],
      x402Support: true,
      active: true,
      registrations: [],
    });
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(Object.isFrozen(metadata.services), true);
  });

  it("adds the exact Celo registration only after a real agent id is supplied", () => {
    const metadata = createAgentPayErc8004Registration({
      agentWalletAddress: agentWallet,
      agentId: 42,
    });

    assert.deepEqual(metadata.registrations, [{ agentId: 42, agentRegistry: CELO_MAINNET_AGENT_REGISTRY }]);
    assert.deepEqual(agentPayErc8004RegistrationSchema.parse(metadata), metadata);
  });

  it("rejects fake wallets, unsafe ids, unverified trust claims, and non-production endpoints", () => {
    for (const invalidWallet of [
      "0x0000000000000000000000000000000000000000",
      "0x1234",
      "0xZZ34567890abcdef1234567890abcdef12345678",
    ]) {
      assert.throws(
        () => createAgentPayErc8004Registration({ agentWalletAddress: invalidWallet }),
        /ERC-8004/i,
      );
    }
    for (const agentId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => createAgentPayErc8004Registration({ agentWalletAddress: agentWallet, agentId }),
        /ERC-8004/i,
      );
    }

    const valid = createAgentPayErc8004Registration({ agentWalletAddress: agentWallet });
    assert.equal(agentPayErc8004RegistrationSchema.safeParse({
      ...valid,
      image: "http://localhost:3000/agent.png",
    }).success, false);
    assert.equal(agentPayErc8004RegistrationSchema.safeParse({
      ...valid,
      supportedTrust: ["reputation"],
    }).success, false);
    assert.equal(agentPayErc8004RegistrationSchema.safeParse({
      ...valid,
      services: valid.services.map((service) => service.name === "MCP"
        ? { ...service, endpoint: "https://wallet.agentpay.site/celo/mcp" }
        : service),
    }).success, false);
  });
});

describe("Arc ERC-8004 v2 boundaries", () => {
  it("pins the three Arc Testnet proxies and deployed v2 signatures", () => {
    assert.equal(ARC_TESTNET_ERC8004_IDENTITY_REGISTRY, "0x8004A818BFB912233c491871b3d84c89A494BD9e");
    assert.equal(ARC_TESTNET_ERC8004_REPUTATION_REGISTRY, "0x8004B663056A597Dffe9eCcC1965A193B7388713");
    assert.equal(ARC_TESTNET_ERC8004_VALIDATION_REGISTRY, "0x8004Cb1BF31DAf7788923b405b754f57acEB4272");
    assert.equal(
      ARC_TESTNET_ERC8004_AGENT_REGISTRY,
      `eip155:5042002:${ARC_TESTNET_ERC8004_IDENTITY_REGISTRY}`,
    );
    assert.ok(erc8004IdentityAbi.includes("function register(string agentURI) returns (uint256 agentId)"));
    assert.ok(erc8004ReputationAbi.some((entry) => entry.includes("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)")));
    assert.ok(erc8004ValidationAbi.some((entry) => entry.includes("validationResponse(bytes32,uint8,string,bytes32,string)")));
  });

  it("accepts safe content-addressed and production metadata URIs", () => {
    for (const agentURI of [
      "https://agent.example.com/.well-known/agent.json",
      "ipfs://bafybeigdyrzt/agent.json",
      "ar://abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
    ]) {
      assert.equal(arcErc8004RegistrationInputSchema.safeParse({
        idempotencyKey: "436dd5c3-d784-4980-b708-3f1ddc84010e",
        walletAddress: agentWallet,
        agentURI,
      }).success, true);
    }
  });

  it("rejects unsafe, secret-bearing, oversized, and option-like metadata", () => {
    for (const agentURI of [
      "http://agent.example.com/agent.json",
      "https://user:password@agent.example.com/agent.json",
      "https://localhost/agent.json",
      "https://10.0.0.1/agent.json",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.2/agent.json",
      "https://[fc00::1]/agent.json",
      "https://[::ffff:127.0.0.1]/agent.json",
      "https://[::ffff:169.254.169.254]/latest/meta-data",
      "https://[::ffff:192.168.1.2]/agent.json",
      "https://agent.local/agent.json",
      "javascript:alert(1)",
      "https://agent.example.com/agent.json?api_key=secret",
      `https://agent.example.com/${"a".repeat(2_100)}`,
      "--rpc-url",
    ]) {
      assert.equal(arcErc8004RegistrationInputSchema.safeParse({
        idempotencyKey: "436dd5c3-d784-4980-b708-3f1ddc84010e",
        walletAddress: agentWallet,
        agentURI,
      }).success, false, agentURI.slice(0, 100));
    }
  });

  it("bounds reputation values and requires a payment/evidence replay key", () => {
    const base = {
      walletAddress: agentWallet,
      agentId: "42",
      value: "9977",
      valueDecimals: 2,
      tag1: "payment",
      tag2: "settled",
      endpoint: "https://merchant.example.com/x402",
      feedbackURI: "ipfs://bafyfeedback",
      feedbackHash: `0x${"a".repeat(64)}`,
      evidenceId: "payment:436dd5c3-d784-4980-b708-3f1ddc84010e",
    };
    assert.equal(arcErc8004FeedbackInputSchema.safeParse(base).success, true);
    assert.equal(arcErc8004FeedbackInputSchema.safeParse({ ...base, valueDecimals: 19 }).success, false);
    assert.equal(arcErc8004FeedbackInputSchema.safeParse({
      ...base,
      value: "100000000000000000000000000000000000001",
    }).success, false);
    assert.equal(arcErc8004FeedbackInputSchema.safeParse({ ...base, evidenceId: "" }).success, false);
  });

  it("bounds validation responses and requires explicit nonempty trust sets", () => {
    const response = {
      walletAddress: agentWallet,
      requestHash: `0x${"b".repeat(64)}`,
      response: 100,
      responseURI: "ar://abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
      responseHash: `0x${"c".repeat(64)}`,
      tag: "payment-proof",
    };
    assert.equal(arcErc8004ValidationResponseInputSchema.safeParse(response).success, true);
    assert.equal(arcErc8004ValidationResponseInputSchema.safeParse({ ...response, response: 101 }).success, false);
    assert.equal(arcErc8004TrustInputSchema.safeParse({
      agentId: "42",
      trustedClientAddresses: [agentWallet],
      trustedValidatorAddresses: ["0x2234567890abcdef1234567890abcdef12345678"],
    }).success, true);
    assert.equal(arcErc8004TrustInputSchema.safeParse({
      agentId: "42",
      trustedClientAddresses: [],
      trustedValidatorAddresses: [],
    }).success, false);
  });
});
