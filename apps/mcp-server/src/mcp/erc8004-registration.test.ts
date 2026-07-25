import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CELO_MAINNET_AGENT_REGISTRY } from "@agentpay-ai/shared-arc";

import {
  parseAgentPayErc8004Env,
  verifyConfiguredAgentPayErc8004Identity,
} from "./erc8004-registration.ts";

const wallet = "0x1234567890abcdef1234567890abcdef12345678";

describe("parseAgentPayErc8004Env", () => {
  it("keeps ERC-8004 publication disabled by default", () => {
    assert.equal(parseAgentPayErc8004Env({}), undefined);
    assert.equal(parseAgentPayErc8004Env({ AGENTPAY_ERC8004_ENABLED: "false" }), undefined);
  });

  it("creates bootstrap and registered metadata only from Celo production inputs", () => {
    const baseEnv = {
      AGENTPAY_ERC8004_ENABLED: "true",
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ERC8004_AGENT_WALLET: wallet,
    };
    const bootstrap = parseAgentPayErc8004Env(baseEnv);
    const registered = parseAgentPayErc8004Env({ ...baseEnv, AGENTPAY_ERC8004_AGENT_ID: "42" });

    assert.ok(bootstrap);
    assert.deepEqual(bootstrap.registrations, []);
    assert.ok(registered);
    assert.deepEqual(registered.registrations, [{ agentId: 42, agentRegistry: CELO_MAINNET_AGENT_REGISTRY }]);
  });

  it("fails closed on missing, fake, testnet, or malformed publication inputs", () => {
    const baseEnv = {
      AGENTPAY_ERC8004_ENABLED: "true",
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ERC8004_AGENT_WALLET: wallet,
    };
    const variants = [
      { ...baseEnv, AGENTPAY_ERC8004_AGENT_WALLET: undefined },
      { ...baseEnv, AGENTPAY_ERC8004_AGENT_WALLET: "0x0000000000000000000000000000000000000000" },
      { ...baseEnv, AGENTPAY_ENVIRONMENT: "staging" },
      { ...baseEnv, AGENTPAY_HOME_CHAIN_ID: "11142220" },
      { ...baseEnv, AGENTPAY_ERC8004_AGENT_ID: "1.5" },
      { ...baseEnv, AGENTPAY_ERC8004_AGENT_ID: "01" },
      { ...baseEnv, AGENTPAY_ERC8004_ENABLED: "treu" },
    ];

    for (const env of variants) {
      assert.throws(() => parseAgentPayErc8004Env(env), /ERC-8004/i);
    }
  });

  it("verifies a configured agent id against Celo before publishing it", async () => {
    const metadata = parseAgentPayErc8004Env({
      AGENTPAY_ERC8004_ENABLED: "true",
      AGENTPAY_ENVIRONMENT: "production",
      AGENTPAY_HOME_CHAIN_ID: "42220",
      AGENTPAY_ERC8004_AGENT_WALLET: wallet,
      AGENTPAY_ERC8004_AGENT_ID: "42",
    });
    assert.ok(metadata);
    const env = {
      AGENTPAY_OWNER_ADDRESS: "0x9999999999999999999999999999999999999999",
      CELO_MAINNET_RPC_URL: "https://forno.celo.org",
    };
    await assert.doesNotReject(() => verifyConfiguredAgentPayErc8004Identity(metadata, env, {
      async getChainId() { return 42220; },
      async ownerOf() { return env.AGENTPAY_OWNER_ADDRESS; },
      async tokenUri() { return "https://wallet.agentpay.site/.well-known/agent-registration.json"; },
      async getAgentWallet() { return wallet; },
    }));

    await assert.rejects(
      () => verifyConfiguredAgentPayErc8004Identity(metadata, env, {
        async getChainId() { return 42220; },
        async ownerOf() { return env.AGENTPAY_OWNER_ADDRESS; },
        async tokenUri() { return "https://wallet.agentpay.site/.well-known/agent-registration.json"; },
        async getAgentWallet() { return "0x8888888888888888888888888888888888888888"; },
      }),
      /ERC-8004.*wallet/i,
    );
  });
});
