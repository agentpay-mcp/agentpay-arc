import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CircleAgentWallet,
  CircleTransactionResult,
} from "@agentpay-ai/shared-arc";

import type { CircleCli } from "../services/circle-cli.ts";
import {
  createArcAgentIdentityHandlers,
  getAgentIdentityTool,
  getAgentTrustTool,
  giveAgentFeedbackTool,
  registerAgentIdentityTool,
  requestAgentValidationTool,
  respondAgentValidationTool,
  type ArcErc8004Dependencies,
  type ArcErc8004EvidenceRepository,
  type ArcErc8004MutationRecord,
} from "./arc-agent-identity.ts";

const WALLET = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const AGENT_WALLET = "0x3333333333333333333333333333333333333333";
const VALIDATOR = "0x4444444444444444444444444444444444444444";
const CLIENT = "0x5555555555555555555555555555555555555555";
const OPERATOR = "0x6666666666666666666666666666666666666666";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const TX_HASH = `0x${"c".repeat(64)}`;
const IDEMPOTENCY_KEY = "436dd5c3-d784-4980-b708-3f1ddc84010e";

describe("Arc ERC-8004 identity tools", () => {
  it("publishes exactly the six isolated MCP tool definitions", () => {
    assert.deepEqual([
      registerAgentIdentityTool.name,
      getAgentIdentityTool.name,
      giveAgentFeedbackTool.name,
      requestAgentValidationTool.name,
      respondAgentValidationTool.name,
      getAgentTrustTool.name,
    ], [
      "register_agent_identity",
      "get_agent_identity",
      "give_agent_feedback",
      "request_agent_validation",
      "respond_agent_validation",
      "get_agent_trust",
    ]);
  });

  it("registers through the identity proxy exactly once and proves the agent id", async () => {
    const calls: unknown[] = [];
    const expectations: unknown[] = [];
    const handlers = createArcAgentIdentityHandlers(dependencies({
      circleCli: fakeCircleCli({
        executeContract: async (input) => {
          calls.push(input);
          return completeTransaction();
        },
      }),
      proofReader: {
        async proveMutation(_transaction, expectation) {
          expectations.push(expectation);
          return { transactionHash: TX_HASH, blockNumber: "81", agentId: "42" };
        },
      },
    }));

    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      walletAddress: WALLET,
      agentURI: "https://agent.example.com/.well-known/agent.json",
    };
    const first = await handlers.registerAgentIdentity(input);
    const replay = await handlers.registerAgentIdentity(input);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      address: WALLET,
      contract: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      functionSignature: "register(string)",
      parameters: [input.agentURI],
    });
    assert.equal(first.status, "CONFIRMED");
    assert.equal(first.agentId, "42");
    assert.equal(first.transactionHash, TX_HASH);
    assert.equal(first.arcscanUrl, `https://testnet.arcscan.app/tx/${TX_HASH}`);
    assert.deepEqual(expectations, [{
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      event: "Registered",
      expectedArgs: {
        owner: WALLET,
        agentURI: input.agentURI,
      },
    }]);
    assert.deepEqual(replay, first);
  });

  it("returns reconciliation state instead of retrying an ambiguous mutation", async () => {
    let calls = 0;
    const handlers = createArcAgentIdentityHandlers(dependencies({
      circleCli: fakeCircleCli({
        executeContract: async () => {
          calls += 1;
          return {
            id: "circle-tx-pending",
            state: "PENDING",
            blockchain: "ARC-TESTNET",
          };
        },
      }),
      proofReader: {
        async proveMutation() {
          throw new Error("receipt unavailable");
        },
      },
    }));
    const input = {
      idempotencyKey: IDEMPOTENCY_KEY,
      walletAddress: WALLET,
      agentURI: "ipfs://bafyagent",
    };

    const first = await handlers.registerAgentIdentity(input);
    const replay = await handlers.registerAgentIdentity(input);
    assert.equal(calls, 1);
    assert.equal(first.status, "RECONCILIATION_REQUIRED");
    assert.equal(first.transactionId, "circle-tx-pending");
    assert.equal(first.transactionHash, undefined);
    assert.deepEqual(replay, first);
  });

  it("reads an existing identity through the proxies", async () => {
    const handlers = createArcAgentIdentityHandlers(dependencies());
    assert.deepEqual(await handlers.getAgentIdentity({ agentId: "42" }), {
      chain: "ARC-TESTNET",
      agentRegistry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentId: "42",
      owner: OWNER,
      agentWallet: AGENT_WALLET,
      agentURI: "https://agent.example.com/.well-known/agent.json",
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });
  });

  it("blocks owner, operator, and agent-wallet self-feedback before Circle write", async () => {
    for (const walletAddress of [OWNER, OPERATOR, AGENT_WALLET]) {
      let writes = 0;
      const handlers = createArcAgentIdentityHandlers(dependencies({
        wallets: [walletAddress],
        reader: fakeReader({
          async isApprovedForAll(owner, operator) {
            return owner === OWNER && operator === OPERATOR;
          },
        }),
        circleCli: fakeCircleCli({
          listAgentWallets: async () => [circleWallet(walletAddress)],
          executeContract: async () => {
            writes += 1;
            return completeTransaction();
          },
        }),
      }));
      await assert.rejects(
        () => handlers.giveAgentFeedback(feedbackInput(walletAddress)),
        /self-feedback/i,
      );
      assert.equal(writes, 0);
    }
  });

  it("atomically prevents duplicate payment feedback under concurrency", async () => {
    let writes = 0;
    const handlers = createArcAgentIdentityHandlers(dependencies({
      wallets: [CLIENT],
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [circleWallet(CLIENT)],
        executeContract: async () => {
          writes += 1;
          return completeTransaction();
        },
      }),
    }));
    const [a, b] = await Promise.allSettled([
      handlers.giveAgentFeedback(feedbackInput(CLIENT)),
      handlers.giveAgentFeedback(feedbackInput(CLIENT)),
    ]);

    assert.equal(writes, 1);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "fulfilled");
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      assert.deepEqual(a.value, b.value);
    }
  });

  it("writes exact feedback parameters and rejects conflicting replay evidence", async () => {
    const calls: unknown[] = [];
    const handlers = createArcAgentIdentityHandlers(dependencies({
      wallets: [CLIENT],
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [circleWallet(CLIENT)],
        executeContract: async (input) => {
          calls.push(input);
          return completeTransaction();
        },
      }),
    }));
    await handlers.giveAgentFeedback(feedbackInput(CLIENT));
    await assert.rejects(
      () => handlers.giveAgentFeedback({ ...feedbackInput(CLIENT), value: "1" }),
      /different.*evidence|conflict/i,
    );
    assert.deepEqual(calls[0], {
      address: CLIENT,
      contract: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      functionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      parameters: [
        "42", "9977", "2", "payment", "settled",
        "https://merchant.example.com/x402", "ipfs://bafyfeedback", HASH_A,
      ],
    });
  });

  it("requires owner/operator role and unique request hashes for validation requests", async () => {
    let writes = 0;
    const foreign = createArcAgentIdentityHandlers(dependencies({
      circleCli: fakeCircleCli({
        executeContract: async () => {
          writes += 1;
          return completeTransaction();
        },
      }),
    }));
    await assert.rejects(
      () => foreign.requestAgentValidation(validationRequestInput(WALLET)),
      /owner or approved operator/i,
    );
    assert.equal(writes, 0);

    const owner = createArcAgentIdentityHandlers(dependencies({
      wallets: [OWNER],
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [circleWallet(OWNER)],
        executeContract: async () => {
          writes += 1;
          return completeTransaction();
        },
      }),
    }));
    const output = await owner.requestAgentValidation(validationRequestInput(OWNER));
    assert.equal(output.status, "CONFIRMED");
    const replay = await owner.requestAgentValidation(validationRequestInput(OWNER));
    assert.deepEqual(replay, output);
    await assert.rejects(
      () => owner.requestAgentValidation({
        ...validationRequestInput(OWNER),
        validatorAddress: CLIENT,
      }),
      /different.*evidence|conflict/i,
    );
    assert.equal(writes, 1);
  });

  it("allows only the requested validator and blocks duplicate validation responses", async () => {
    const requestReader = fakeReader({
      async getValidationStatus() {
        return {
          exists: true,
          validatorAddress: VALIDATOR,
          agentId: "42",
          response: 0,
          responseHash: `0x${"0".repeat(64)}`,
          tag: "",
          lastUpdate: "1",
          hasResponse: false,
        };
      },
    });
    const foreign = createArcAgentIdentityHandlers(dependencies({ reader: requestReader }));
    await assert.rejects(
      () => foreign.respondAgentValidation(validationResponseInput(WALLET)),
      /requested validator/i,
    );

    let writes = 0;
    const validator = createArcAgentIdentityHandlers(dependencies({
      wallets: [VALIDATOR],
      reader: requestReader,
      circleCli: fakeCircleCli({
        listAgentWallets: async () => [circleWallet(VALIDATOR)],
        executeContract: async () => {
          writes += 1;
          return completeTransaction();
        },
      }),
    }));
    const first = await validator.respondAgentValidation(validationResponseInput(VALIDATOR));
    const replay = await validator.respondAgentValidation(validationResponseInput(VALIDATOR));
    assert.deepEqual(replay, first);
    assert.equal(writes, 1);

    const alreadyResponded = createArcAgentIdentityHandlers(dependencies({
      wallets: [VALIDATOR],
      reader: fakeReader({
        async getValidationStatus() {
          return {
            exists: true,
            validatorAddress: VALIDATOR,
            agentId: "42",
            response: 80,
            responseHash: HASH_B,
            tag: "payment-proof",
            lastUpdate: "2",
            hasResponse: true,
          };
        },
      }),
    }));
    await assert.rejects(
      () => alreadyResponded.respondAgentValidation(validationResponseInput(VALIDATOR)),
      /already.*response/i,
    );
  });

  it("computes transparent trust components only from caller-trusted sets", async () => {
    const handlers = createArcAgentIdentityHandlers(dependencies({
      reader: fakeReader({
        async getReputationSummary(agentId, clients, tag1, tag2) {
          assert.deepEqual([agentId, clients, tag1, tag2], ["42", [CLIENT], "payment", "settled"]);
          return { count: "3", summaryValue: "9750", summaryValueDecimals: 2 };
        },
        async getValidationSummary(agentId, validators, tag) {
          assert.deepEqual([agentId, validators, tag], ["42", [VALIDATOR], "payment-proof"]);
          return { count: "2", averageResponse: 90 };
        },
      }),
    }));

    assert.deepEqual(await handlers.getAgentTrust({
      agentId: "42",
      trustedClientAddresses: [CLIENT],
      trustedValidatorAddresses: [VALIDATOR],
      reputationTag1: "payment",
      reputationTag2: "settled",
      validationTag: "payment-proof",
    }), {
      agentId: "42",
      trustedSources: {
        clientAddresses: [CLIENT],
        validatorAddresses: [VALIDATOR],
      },
      reputation: {
        count: "3",
        summaryValue: "9750",
        summaryValueDecimals: 2,
        formattedValue: "97.5",
        tag1: "payment",
        tag2: "settled",
      },
      validation: {
        count: "2",
        averageResponse: 90,
        tag: "payment-proof",
      },
      methodology:
        "Registry summaries are reported separately and filtered only by the caller-supplied trusted addresses and tags; AgentPay does not invent a global score.",
      globalScore: null,
    });
  });
});

function feedbackInput(walletAddress: string) {
  return {
    walletAddress,
    agentId: "42",
    value: "9977",
    valueDecimals: 2,
    tag1: "payment",
    tag2: "settled",
    endpoint: "https://merchant.example.com/x402",
    feedbackURI: "ipfs://bafyfeedback",
    feedbackHash: HASH_A,
    evidenceId: `payment:${IDEMPOTENCY_KEY}`,
  };
}

function validationRequestInput(walletAddress: string) {
  return {
    walletAddress,
    agentId: "42",
    validatorAddress: VALIDATOR,
    requestURI: "ipfs://bafyrequest",
    requestHash: HASH_A,
  };
}

function validationResponseInput(walletAddress: string) {
  return {
    walletAddress,
    requestHash: HASH_A,
    response: 90,
    responseURI: "ipfs://bafyresponse",
    responseHash: HASH_B,
    tag: "payment-proof",
  };
}

function dependencies(
  overrides: Partial<ArcErc8004Dependencies> & { wallets?: readonly string[] } = {},
): ArcErc8004Dependencies {
  const repository = overrides.evidence ?? memoryEvidenceRepository();
  return {
    circleCli: overrides.circleCli ?? fakeCircleCli({
      listAgentWallets: async () => (overrides.wallets ?? [WALLET]).map(circleWallet),
      executeContract: async () => completeTransaction(),
    }),
    reader: overrides.reader ?? fakeReader(),
    proofReader: overrides.proofReader ?? {
      async proveMutation(transaction) {
        return {
          transactionHash: transaction.txHash ?? TX_HASH,
          blockNumber: "80",
        };
      },
    },
    evidence: repository,
  };
}

function fakeReader(overrides: Partial<ArcErc8004Dependencies["reader"]> = {}) {
  return {
    async ownerOf() { return OWNER; },
    async tokenURI() { return "https://agent.example.com/.well-known/agent.json"; },
    async getAgentWallet() { return AGENT_WALLET; },
    async getApproved() { return OPERATOR; },
    async isApprovedForAll() { return false; },
    async getValidationStatus() {
      return {
        exists: false,
        validatorAddress: "0x0000000000000000000000000000000000000000",
        agentId: "0",
        response: 0,
        responseHash: `0x${"0".repeat(64)}`,
        tag: "",
        lastUpdate: "0",
        hasResponse: false,
      };
    },
    async getReputationSummary() {
      return { count: "0", summaryValue: "0", summaryValueDecimals: 0 };
    },
    async getValidationSummary() {
      return { count: "0", averageResponse: 0 };
    },
    ...overrides,
  };
}

function fakeCircleCli(overrides: Partial<CircleCli> = {}): CircleCli {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected Circle CLI call");
  };
  return {
    status: unexpected,
    listAgentWallets: async () => [circleWallet(WALLET)],
    getBalance: unexpected,
    fundFromFaucet: unexpected,
    transfer: unexpected,
    swap: unexpected,
    executeContract: unexpected,
    searchServices: unexpected,
    inspectService: unexpected,
    payService: unexpected,
    getGatewayBalance: unexpected,
    depositGateway: unexpected,
    withdrawGateway: unexpected,
    bridge: unexpected,
    ...overrides,
  };
}

function circleWallet(address: string): CircleAgentWallet {
  return { address, type: "agent", blockchain: "ARC-TESTNET" };
}

function completeTransaction(): CircleTransactionResult {
  return {
    id: "circle-tx-1",
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash: TX_HASH,
  };
}

function memoryEvidenceRepository(): ArcErc8004EvidenceRepository {
  const records = new Map<string, ArcErc8004MutationRecord>();
  return {
    async claim(record) {
      const existing = records.get(record.key);
      if (existing) {
        return { claimed: false, record: structuredClone(existing) };
      }
      records.set(record.key, structuredClone(record));
      return { claimed: true, record: structuredClone(record) };
    },
    async complete(key, fingerprint, output) {
      const existing = records.get(key);
      assert.ok(existing);
      assert.equal(existing.fingerprint, fingerprint);
      const completed = { ...existing, status: "COMPLETED" as const, output: structuredClone(output) };
      records.set(key, completed);
      return structuredClone(completed);
    },
  };
}
