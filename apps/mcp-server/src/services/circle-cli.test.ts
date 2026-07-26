import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CircleCliCommandError,
  createCircleCli,
  createCircleCommandRunner,
  type CircleCommandRunner,
  type CircleExecFile,
} from "./circle-cli.ts";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TRANSACTION_RESULT = {
  id: "tx_123",
  state: "COMPLETE",
  blockchain: "ARC-TESTNET",
  txHash: `0x${"a".repeat(64)}`,
};
const STATUS_RESULT = {
  type: "agent",
  mainnet: { tokenStatus: "NOT_LOGGED_IN" },
  testnet: { email: "builder@example.com", tokenStatus: "VALID", expiresIn: "6d 23h" },
};
const GATEWAY_BALANCE_RESULT = {
  message: "Gateway balance: 1 USDC",
  address: ADDRESS,
  backingEOA: RECIPIENT,
  total: "1",
  token: "USDC",
  balances: [{ network: "Arc Testnet", domain: 26, balance: "1" }],
};
const SERVICE_PAYMENT_RESULT = {
  response: { result: "ok" },
  payment: {
    amount: "$0.01 USDC",
    chain: "Arc Testnet",
    scheme: "exact",
    seller: RECIPIENT,
    receipt: "receipt_123",
  },
};

describe("Circle CLI command runner", () => {
  it("uses fixed execFile semantics with no shell and one JSON output flag", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { shell?: boolean; timeout?: number; maxBuffer?: number };
    }> = [];
    const execFile: CircleExecFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, JSON.stringify({ authenticated: true, termsAccepted: true }), "");
    };
    const runner = createCircleCommandRunner({
      execFile,
      timeoutMs: 321,
      maxOutputBytes: 1_024,
    });

    await runner.run(["status"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, "circle");
    assert.deepEqual(calls[0]?.args, ["status", "--output", "json"]);
    assert.equal(calls[0]?.options.shell, false);
    assert.equal(calls[0]?.options.timeout, 321);
    assert.equal(calls[0]?.options.maxBuffer, 1_024);
  });

  it("does not duplicate an existing JSON output flag", async () => {
    let capturedArgs: readonly string[] = [];
    const execFile: CircleExecFile = (_file, args, _options, callback) => {
      capturedArgs = args;
      callback(null, "{}", "");
    };
    const runner = createCircleCommandRunner({ execFile });

    await runner.run(["status", "--output", "json"]);

    assert.deepEqual(capturedArgs, ["status", "--output", "json"]);
  });

  it("bounds stdout before parsing JSON", async () => {
    const execFile: CircleExecFile = (_file, _args, _options, callback) => {
      callback(null, `{"oversized":"${"x".repeat(100)}"}`, "");
    };
    const runner = createCircleCommandRunner({
      execFile,
      maxOutputBytes: 32,
    });

    await assert.rejects(
      () => runner.run(["status"]),
      (error) => error instanceof CircleCliCommandError && error.code === "OUTPUT_TOO_LARGE",
    );
  });

  it("sanitizes stderr, command paths, and debug output", async () => {
    const execFile: CircleExecFile = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("spawn /Users/alice/.circle/session-token failed"), {
        code: "EACCES",
        path: "/Users/alice/.circle/session-token",
      });
      callback(error, "", "debug secret-token at /Users/alice/.circle/config.json");
    };
    const runner = createCircleCommandRunner({ execFile });

    await assert.rejects(
      () => runner.run(["status"]),
      (error) => {
        assert.ok(error instanceof CircleCliCommandError);
        assert.equal(error.code, "COMMAND_FAILED");
        assert.doesNotMatch(error.message, /alice|secret-token|session-token|config\.json/i);
        return true;
      },
    );
  });

  it("maps safe Circle auth and Terms errors without exposing CLI details", async () => {
    let call = 0;
    const execFile: CircleExecFile = (_file, _args, _options, callback) => {
      call += 1;
      const error = Object.assign(new Error("Circle CLI exited with status 1"), { code: 1 });
      const stderr = call === 1
        ? JSON.stringify({
            error: {
              code: "AUTH_REQUIRED",
              message: "Session expired at /Users/alice/.circle/session.json",
            },
          })
        : JSON.stringify({
            error: {
              code: "PERMISSION_DENIED",
              message: "Circle CLI Terms acceptance is required before use.",
            },
          });
      callback(error, "", stderr);
    };
    const runner = createCircleCommandRunner({ execFile });

    await assert.rejects(
      () => runner.run(["wallet", "status", "--type", "agent"]),
      (error) => {
        assert.ok(error instanceof CircleCliCommandError);
        assert.equal(error.code, "AUTH_REQUIRED");
        assert.doesNotMatch(error.message, /alice|session\.json/i);
        return true;
      },
    );
    await assert.rejects(
      () => runner.run(["wallet", "status", "--type", "agent"]),
      (error) => error instanceof CircleCliCommandError && error.code === "TERMS_REQUIRED",
    );
  });

  it("rejects invalid output flags, secret argv, and malformed JSON", async () => {
    let attempts = 0;
    const execFile: CircleExecFile = (_file, _args, _options, callback) => {
      attempts += 1;
      callback(null, "not-json", "");
    };
    const runner = createCircleCommandRunner({ execFile });

    await assert.rejects(
      () => runner.run(["status", "--output", "yaml"]),
      (error) => error instanceof CircleCliCommandError && error.code === "INVALID_ARGUMENTS",
    );
    await assert.rejects(
      () => runner.run(["status", "--output=json"]),
      (error) => error instanceof CircleCliCommandError && error.code === "INVALID_ARGUMENTS",
    );
    await assert.rejects(
      () => runner.run(["status", "private_key=0xdeadbeef"]),
      (error) => error instanceof CircleCliCommandError && error.code === "INVALID_ARGUMENTS",
    );
    await assert.rejects(
      () => runner.run(["status"]),
      (error) => error instanceof CircleCliCommandError && error.code === "INVALID_JSON",
    );
    assert.equal(attempts, 1);
  });
});

describe("Circle CLI adapter", () => {
  it("keeps URL, headers, body, addresses, amounts, chain, and contract data in separate argv entries", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CircleCommandRunner = {
      async run(args) {
        mutableCalls.push([...args]);
        return args[0] === "services" ? SERVICE_PAYMENT_RESULT : TRANSACTION_RESULT;
      },
    };
    const cli = createCircleCli({ runner });

    await cli.payService({
      url: "https://merchant.example/paid",
      address: ADDRESS,
      maxAmount: "1.25",
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Agent-Request": "quote-123",
      },
      body: "{\"item\":\"report\"}",
    });
    await cli.executeContract({
      address: ADDRESS,
      contract: RECIPIENT,
      functionSignature: "approve(address,uint256)",
      parameters: [ADDRESS, "1000000"],
      value: "0",
    });

    assert.deepEqual(mutableCalls[0], [
      "services",
      "pay",
      "https://merchant.example/paid",
      "--address",
      ADDRESS,
      "--chain",
      "ARC-TESTNET",
      "--max-amount",
      "1.25",
      "--method",
      "POST",
      "--header",
      "Accept: application/json",
      "--header",
      "X-Agent-Request: quote-123",
      "--data",
      "{\"item\":\"report\"}",
    ]);
    assert.deepEqual(mutableCalls[1], [
      "wallet",
      "execute",
      "approve(address,uint256)",
      ADDRESS,
      "1000000",
      "--contract",
      RECIPIENT,
      "--address",
      ADDRESS,
      "--chain",
      "ARC-TESTNET",
      "--amount",
      "0",
    ]);
  });

  it("uses the documented Agent Wallet status and Arc Gateway balance commands", async () => {
    const calls: string[][] = [];
    const runner: CircleCommandRunner = {
      async run(args) {
        calls.push([...args]);
        return args[0] === "wallet"
          ? STATUS_RESULT
          : GATEWAY_BALANCE_RESULT;
      },
    };
    const cli = createCircleCli({ runner });

    await cli.status();
    await cli.getGatewayBalance(ADDRESS);

    assert.deepEqual(calls, [
      ["wallet", "status", "--type", "agent"],
      ["gateway", "balance", "--address", ADDRESS, "--chain", "ARC-TESTNET"],
    ]);
  });

  it("uses documented Arc wallet transfer arguments", async () => {
    const calls: string[][] = [];
    const runner: CircleCommandRunner = {
      async run(args) {
        calls.push([...args]);
        return TRANSACTION_RESULT;
      },
    };
    const cli = createCircleCli({ runner });

    await cli.transfer({
      recipient: RECIPIENT,
      amount: "9.5",
      address: ADDRESS,
    });

    assert.deepEqual(calls, [[
      "wallet",
      "transfer",
      RECIPIENT,
      "--amount",
      "9.5",
      "--address",
      ADDRESS,
      "--chain",
      "ARC-TESTNET",
    ]]);
  });

  it("builds every remaining documented command without shell concatenation", async () => {
    const calls: string[][] = [];
    const runner: CircleCommandRunner = {
      async run(args) {
        calls.push([...args]);
        const command = args.slice(0, 2).join(" ");
        if (command === "wallet list") {
          return { wallets: [{ address: ADDRESS, type: "agent", blockchain: "ARC-TESTNET" }] };
        }
        if (command === "wallet fund") {
          return {
            message: "Faucet drip requested.",
            address: ADDRESS,
            blockchain: "ARC-TESTNET",
            token: "usdc",
          };
        }
        if (command === "wallet swap") {
          return {
            message: "Swap complete.",
            sellToken: "EURC",
            sellAmount: "2",
            buyToken: "USDC",
            buyMin: "1.9",
            chain: "ARC-TESTNET",
            transactions: [TRANSACTION_RESULT],
          };
        }
        if (command === "services search") {
          return {
            items: [{
              resource: "https://merchant.example/paid",
              metadata: {
                description: "Paid report",
                method: "POST",
                provider: { name: "Merchant" },
              },
            }],
          };
        }
        if (command === "services inspect") {
          return {
            status: "payable",
            httpStatus: 402,
            url: "https://merchant.example/paid",
            price: { amount: "10000", formatted: "$0.01 USDC" },
            chains: ["eip155:5042002"],
            scheme: "exact",
            seller: RECIPIENT,
          };
        }
        if (command === "gateway balance") {
          return GATEWAY_BALANCE_RESULT;
        }
        if (command === "gateway deposit") {
          return {
            message: "Deposited 0.5 USDC to Gateway.",
            method: "direct",
            amount: "0.5",
            sourceAddress: ADDRESS,
            sourceBlockchain: "ARC-TESTNET",
            backingEOA: RECIPIENT,
            approveTxHash: `0x${"b".repeat(64)}`,
            depositTxHash: `0x${"c".repeat(64)}`,
          };
        }
        if (command === "gateway withdraw") {
          return {
            message: "Withdrew 0.1 USDC from Gateway.",
            amount: "0.1",
            sourceAddress: ADDRESS,
            backingEOA: RECIPIENT,
            sourceBlockchain: "ARC-TESTNET",
            destinationBlockchain: "ARC-TESTNET",
            recipient: RECIPIENT,
            transferId: "transfer_123",
            mintTxHash: `0x${"d".repeat(64)}`,
          };
        }
        if (command === "bridge transfer") {
          return {
            message: "Bridge complete.",
            burnTxHash: `0x${"e".repeat(64)}`,
            forwardTxHash: `0x${"f".repeat(64)}`,
            fromChain: "ARC-TESTNET",
            toChain: "ARB-SEPOLIA",
            amount: "1",
            status: "complete",
            transactions: [TRANSACTION_RESULT],
          };
        }
        return TRANSACTION_RESULT;
      },
    };
    const cli = createCircleCli({ runner });
    const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";

    await cli.listAgentWallets();
    await cli.fundFromFaucet(ADDRESS);
    await cli.swap({
      sellToken: "EURC",
      sellAmount: "2",
      buyToken: "USDC",
      minimumBuy: "1.9",
      address: ADDRESS,
      idempotencyKey,
    });
    await cli.searchServices({ query: "weather", limit: 5 });
    await cli.inspectService({
      url: "https://merchant.example/paid",
      method: "POST",
      headers: { Accept: "application/json" },
      body: "{\"city\":\"Jakarta\"}",
    });
    await cli.depositGateway({ amount: "0.5", address: ADDRESS });
    await cli.withdrawGateway({ amount: "0.1", address: ADDRESS, recipient: RECIPIENT });
    await cli.bridge({
      destination: "ARB-SEPOLIA",
      recipient: RECIPIENT,
      amount: "1",
      address: ADDRESS,
      idempotencyKey,
    });

    assert.deepEqual(calls, [
      ["wallet", "list", "--chain", "ARC-TESTNET", "--type", "agent"],
      ["wallet", "fund", "--address", ADDRESS, "--chain", "ARC-TESTNET"],
      [
        "wallet", "swap", "EURC", "2", "USDC", "1.9",
        "--address", ADDRESS, "--chain", "ARC-TESTNET", "--idempotency-key", idempotencyKey,
      ],
      ["services", "search", "weather", "--limit", "5"],
      [
        "services", "inspect", "https://merchant.example/paid",
        "--method", "POST",
        "--header", "Accept: application/json",
        "--data", "{\"city\":\"Jakarta\"}",
      ],
      [
        "gateway", "deposit", "--amount", "0.5", "--address", ADDRESS,
        "--chain", "ARC-TESTNET", "--method", "direct",
      ],
      [
        "gateway", "withdraw", "--amount", "0.1", "--address", ADDRESS,
        "--chain", "ARC-TESTNET", "--recipient", RECIPIENT,
      ],
      [
        "bridge", "transfer", "ARB-SEPOLIA", RECIPIENT, "--amount", "1",
        "--address", ADDRESS, "--chain", "ARC-TESTNET", "--idempotency-key", idempotencyKey,
      ],
    ]);
  });

  it("retries transient read-only failures only", async () => {
    let attempts = 0;
    const runner: CircleCommandRunner = {
      async run() {
        attempts += 1;
        if (attempts === 1) {
          throw new CircleCliCommandError("TRANSIENT");
        }
        return {
          balances: [{
            amount: "3",
            token: {
              name: "USD Coin",
              symbol: "USDC",
              blockchain: "ARC-TESTNET",
              decimals: 6,
              isNative: false,
              tokenAddress: "0x3600000000000000000000000000000000000000",
            },
          }],
        };
      },
    };
    const cli = createCircleCli({ runner, readOnlyMaxAttempts: 2 });

    const balance = await cli.getBalance(ADDRESS);

    assert.equal(attempts, 2);
    assert.equal(balance.balances[0]?.amount, "3");
  });

  it("retries a read-only timeout but never retries a timed-out mutation", async () => {
    let readAttempts = 0;
    const readRunner: CircleCommandRunner = {
      async run() {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw new CircleCliCommandError("TIMEOUT");
        }
        return STATUS_RESULT;
      },
    };
    const readCli = createCircleCli({ runner: readRunner, readOnlyMaxAttempts: 2 });

    assert.equal((await readCli.status()).testnet.tokenStatus, "VALID");
    assert.equal(readAttempts, 2);

    let mutationAttempts = 0;
    const mutationRunner: CircleCommandRunner = {
      async run() {
        mutationAttempts += 1;
        throw new CircleCliCommandError("TIMEOUT");
      },
    };
    const mutationCli = createCircleCli({ runner: mutationRunner, readOnlyMaxAttempts: 3 });

    await assert.rejects(() =>
      mutationCli.transfer({
        recipient: RECIPIENT,
        amount: "1",
        address: ADDRESS,
      }),
    );
    assert.equal(mutationAttempts, 1);
  });

  it("executes a mutating command exactly once even after a transient failure", async () => {
    let attempts = 0;
    const runner: CircleCommandRunner = {
      async run() {
        attempts += 1;
        throw new CircleCliCommandError("TRANSIENT");
      },
    };
    const cli = createCircleCli({ runner, readOnlyMaxAttempts: 3 });

    await assert.rejects(() =>
      cli.transfer({
        recipient: RECIPIENT,
        amount: "1",
        address: ADDRESS,
      }),
    );
    assert.equal(attempts, 1);
  });

  it("validates every command response before returning it", async () => {
    const runner: CircleCommandRunner = {
      async run() {
        return {
          wallets: [{
            address: "not-an-address",
            type: "agent",
            blockchain: "ARC-TESTNET",
          }],
        };
      },
    };
    const cli = createCircleCli({ runner });

    await assert.rejects(() => cli.listAgentWallets());
  });

  it("rejects a paid-service response from a chain other than Arc Testnet", async () => {
    const runner: CircleCommandRunner = {
      async run() {
        return {
          ...SERVICE_PAYMENT_RESULT,
          payment: {
            ...SERVICE_PAYMENT_RESULT.payment,
            chain: "Base",
          },
        };
      },
    };
    const cli = createCircleCli({ runner });

    await assert.rejects(() =>
      cli.payService({
        url: "https://merchant.example/paid",
        address: ADDRESS,
        maxAmount: "1",
      }),
    );
  });

  it("strips unknown stdout JSON fields before returning data to callers", async () => {
    const runner: CircleCommandRunner = {
      async run() {
        return {
          ...STATUS_RESULT,
          debugPath: "/Users/alice/.circle-cli/payments/debug.json",
          sessionToken: "secret-session-token",
        };
      },
    };
    const cli = createCircleCli({ runner });

    const status = await cli.status();

    assert.deepEqual(status, {
      ...STATUS_RESULT,
    });
    assert.equal("debugPath" in status, false);
    assert.equal("sessionToken" in status, false);
  });

  it("rejects secret material before invoking the runner", async () => {
    let attempts = 0;
    const runner: CircleCommandRunner = {
      async run() {
        attempts += 1;
        return TRANSACTION_RESULT;
      },
    };
    const cli = createCircleCli({ runner });

    await assert.rejects(() =>
      cli.payService({
        url: "https://merchant.example/paid",
        address: ADDRESS,
        maxAmount: "1",
        body: "private_key=0xdeadbeef",
      }),
    );
    await assert.rejects(() =>
      cli.executeContract({
        address: ADDRESS,
        contract: RECIPIENT,
        functionSignature: "approve(address,uint256)",
        parameters: ["seed phrase=correct horse battery staple", "1000000"],
      }),
    );
    assert.equal(attempts, 0);
  });
});
