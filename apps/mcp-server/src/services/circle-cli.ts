import { execFile as nodeExecFile } from "node:child_process";

import {
  CIRCLE_ARC_CHAIN,
  circleAddressSchema,
  circleAgentWalletSchema,
  circleBridgeInputSchema,
  circleBridgeResultSchema,
  circleContractExecutionInputSchema,
  circleFaucetResultSchema,
  circleGatewayBalanceSchema,
  circleGatewayDepositInputSchema,
  circleGatewayDepositResultSchema,
  circleGatewayWithdrawalInputSchema,
  circleGatewayWithdrawalResultSchema,
  circleSafeCliTextSchema,
  circleServicePaymentInputSchema,
  circleServicePaymentResultSchema,
  circleServiceQuoteSchema,
  circleServiceRequestSchema,
  circleServiceSearchResponseSchema,
  circleServiceSearchInputSchema,
  circleSessionStatusSchema,
  circleSwapInputSchema,
  circleSwapResultSchema,
  circleTransactionResultSchema,
  circleTransferInputSchema,
  circleWalletBalanceSchema,
  type CircleAgentWallet,
  type CircleBridgeInput,
  type CircleBridgeResult,
  type CircleContractExecutionInput,
  type CircleFaucetResult,
  type CircleGatewayBalance,
  type CircleGatewayDepositInput,
  type CircleGatewayDepositResult,
  type CircleGatewayWithdrawalInput,
  type CircleGatewayWithdrawalResult,
  type CircleService,
  type CircleServicePaymentInput,
  type CircleServicePaymentResult,
  type CircleServiceQuote,
  type CircleServiceRequest,
  type CircleServiceSearchInput,
  type CircleSessionStatus,
  type CircleSwapInput,
  type CircleSwapResult,
  type CircleTransactionResult,
  type CircleTransferInput,
  type CircleWalletBalance,
} from "@agentpay-ai/shared-arc";
import { z } from "zod";

const CIRCLE_BINARY = "circle";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_READ_ONLY_MAX_ATTEMPTS = 2;

export type CircleCliErrorCode =
  | "AUTH_REQUIRED"
  | "COMMAND_FAILED"
  | "INVALID_ARGUMENTS"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "OUTPUT_TOO_LARGE"
  | "TERMS_REQUIRED"
  | "TIMEOUT"
  | "TRANSIENT";

const safeErrorMessages: Readonly<Record<CircleCliErrorCode, string>> = Object.freeze({
  AUTH_REQUIRED: "Circle Agent Wallet login is required.",
  COMMAND_FAILED: "Circle CLI command failed.",
  INVALID_ARGUMENTS: "Circle CLI command arguments were rejected.",
  INVALID_JSON: "Circle CLI returned invalid JSON.",
  INVALID_RESPONSE: "Circle CLI returned an unexpected response.",
  OUTPUT_TOO_LARGE: "Circle CLI output exceeded the allowed size.",
  TERMS_REQUIRED: "Circle CLI Terms acceptance is required.",
  TIMEOUT: "Circle CLI command timed out.",
  TRANSIENT: "Circle CLI is temporarily unavailable.",
});

export class CircleCliCommandError extends Error {
  readonly code: CircleCliErrorCode;

  constructor(code: CircleCliErrorCode) {
    super(safeErrorMessages[code]);
    this.name = "CircleCliCommandError";
    this.code = code;
  }
}

export interface CircleCommandRunner {
  run(args: readonly string[]): Promise<unknown>;
}

export interface CircleExecFileOptions {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type CircleExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
export type CircleExecFile = (
  file: string,
  args: readonly string[],
  options: CircleExecFileOptions,
  callback: CircleExecFileCallback,
) => void;

export interface CircleCommandRunnerOptions {
  readonly execFile?: CircleExecFile;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface CircleCliOptions {
  readonly runner?: CircleCommandRunner;
  readonly readOnlyMaxAttempts?: number;
}

export interface CircleCli {
  status(): Promise<CircleSessionStatus>;
  listAgentWallets(): Promise<readonly CircleAgentWallet[]>;
  getBalance(address: string): Promise<CircleWalletBalance>;
  fundFromFaucet(address: string): Promise<CircleFaucetResult>;
  transfer(input: CircleTransferInput): Promise<CircleTransactionResult>;
  swap(input: CircleSwapInput): Promise<CircleSwapResult>;
  executeContract(input: CircleContractExecutionInput): Promise<CircleTransactionResult>;
  searchServices(input: CircleServiceSearchInput): Promise<readonly CircleService[]>;
  inspectService(input: CircleServiceRequest): Promise<CircleServiceQuote>;
  payService(input: CircleServicePaymentInput): Promise<CircleServicePaymentResult>;
  getGatewayBalance(address: string): Promise<CircleGatewayBalance>;
  depositGateway(input: CircleGatewayDepositInput): Promise<CircleGatewayDepositResult>;
  withdrawGateway(input: CircleGatewayWithdrawalInput): Promise<CircleGatewayWithdrawalResult>;
  bridge(input: CircleBridgeInput): Promise<CircleBridgeResult>;
}

export function createCircleCommandRunner(options: CircleCommandRunnerOptions = {}): CircleCommandRunner {
  const execFile = options.execFile ?? defaultExecFile;
  const maxOutputBytes = requirePositiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");

  return {
    async run(rawArgs) {
      const args = normalizeJsonOutputArgs(rawArgs);
      validateRunnerArguments(args);

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          CIRCLE_BINARY,
          args,
          {
            encoding: "utf8",
            maxBuffer: maxOutputBytes,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error, output, stderr) => {
            if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
              reject(new CircleCliCommandError("OUTPUT_TOO_LARGE"));
              return;
            }
            if (error) {
              reject(toSafeCommandError(error, output, stderr));
              return;
            }
            resolve(output);
          },
        );
      });

      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        throw new CircleCliCommandError("OUTPUT_TOO_LARGE");
      }

      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        throw new CircleCliCommandError("INVALID_JSON");
      }
    },
  };
}

export function createCircleCli(options: CircleCliOptions = {}): CircleCli {
  const runner = options.runner ?? createCircleCommandRunner();
  const readOnlyMaxAttempts = requirePositiveInteger(
    options.readOnlyMaxAttempts ?? DEFAULT_READ_ONLY_MAX_ATTEMPTS,
    "readOnlyMaxAttempts",
  );
  const read = async <T>(args: readonly string[], schema: z.ZodType<T>, responseKeys: readonly string[] = []) =>
    parseCommandResponse(
      schema,
      await runReadOnly(runner, args, readOnlyMaxAttempts),
      responseKeys,
    );
  const mutate = async <T>(args: readonly string[], schema: z.ZodType<T>, responseKeys: readonly string[] = []) =>
    parseCommandResponse(schema, await runMutation(runner, args), responseKeys);

  return {
    status: () =>
      read(["wallet", "status", "--type", "agent"], circleSessionStatusSchema, ["status"]),

    listAgentWallets: () =>
      read(
        ["wallet", "list", "--chain", CIRCLE_ARC_CHAIN, "--type", "agent"],
        z.array(circleAgentWalletSchema).readonly(),
        ["wallets"],
      ),

    async getBalance(address) {
      const parsedAddress = parseInput(circleAddressSchema, address);
      return await read(
        ["wallet", "balance", "--address", parsedAddress, "--chain", CIRCLE_ARC_CHAIN],
        circleWalletBalanceSchema,
        ["balance"],
      );
    },

    async fundFromFaucet(address) {
      const parsedAddress = parseInput(circleAddressSchema, address);
      return await mutate(
        ["wallet", "fund", "--address", parsedAddress, "--chain", CIRCLE_ARC_CHAIN],
        circleFaucetResultSchema,
      );
    },

    async transfer(input) {
      const parsed = parseInput(circleTransferInputSchema, input);
      return await mutate(
        [
          "wallet",
          "transfer",
          parsed.recipient,
          "--amount",
          parsed.amount,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
        ],
        circleTransactionResultSchema,
        ["transaction"],
      );
    },

    async swap(input) {
      const parsed = parseInput(circleSwapInputSchema, input);
      return await mutate(
        [
          "wallet",
          "swap",
          parsed.sellToken,
          parsed.sellAmount,
          parsed.buyToken,
          parsed.minimumBuy,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          "--idempotency-key",
          parsed.idempotencyKey,
        ],
        circleSwapResultSchema,
        ["swap", "transaction"],
      );
    },

    async executeContract(input) {
      const parsed = parseInput(circleContractExecutionInputSchema, input);
      return await mutate(
        [
          "wallet",
          "execute",
          parsed.functionSignature,
          ...parsed.parameters,
          "--contract",
          parsed.contract,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          ...(parsed.value === undefined ? [] : ["--amount", parsed.value]),
        ],
        circleTransactionResultSchema,
        ["transaction"],
      );
    },

    async searchServices(input) {
      const parsed = parseInput(circleServiceSearchInputSchema, input);
      return await read(
        [
          "services",
          "search",
          parsed.query,
          ...(parsed.limit === undefined ? [] : ["--limit", parsed.limit.toString()]),
        ],
        circleServiceSearchResponseSchema,
      );
    },

    async inspectService(input) {
      const parsed = parseInput(circleServiceRequestSchema, input);
      return await read(
        ["services", "inspect", parsed.url, ...buildHttpArgs(parsed)],
        circleServiceQuoteSchema,
        ["quote", "service"],
      );
    },

    async payService(input) {
      const parsed = parseInput(circleServicePaymentInputSchema, input);
      return await mutate(
        [
          "services",
          "pay",
          parsed.url,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          "--max-amount",
          parsed.maxAmount,
          ...buildHttpArgs(parsed),
        ],
        circleServicePaymentResultSchema,
      );
    },

    async getGatewayBalance(address) {
      const parsedAddress = parseInput(circleAddressSchema, address);
      return await read(
        ["gateway", "balance", "--address", parsedAddress, "--chain", CIRCLE_ARC_CHAIN],
        circleGatewayBalanceSchema,
        ["balance"],
      );
    },

    async depositGateway(input) {
      const parsed = parseInput(circleGatewayDepositInputSchema, input);
      return await mutate(
        [
          "gateway",
          "deposit",
          "--amount",
          parsed.amount,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          "--method",
          "direct",
        ],
        circleGatewayDepositResultSchema,
      );
    },

    async withdrawGateway(input) {
      const parsed = parseInput(circleGatewayWithdrawalInputSchema, input);
      return await mutate(
        [
          "gateway",
          "withdraw",
          "--amount",
          parsed.amount,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          "--recipient",
          parsed.recipient,
        ],
        circleGatewayWithdrawalResultSchema,
        ["withdrawal", "transaction"],
      );
    },

    async bridge(input) {
      const parsed = parseInput(circleBridgeInputSchema, input);
      return await mutate(
        [
          "bridge",
          "transfer",
          parsed.destination,
          parsed.recipient,
          "--amount",
          parsed.amount,
          "--address",
          parsed.address,
          "--chain",
          CIRCLE_ARC_CHAIN,
          "--idempotency-key",
          parsed.idempotencyKey,
        ],
        circleBridgeResultSchema,
        ["bridge", "transfer", "transaction"],
      );
    },
  };
}

const defaultExecFile: CircleExecFile = (file, args, options, callback) => {
  nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
    callback(error, String(stdout), String(stderr));
  });
};

function normalizeJsonOutputArgs(rawArgs: readonly string[]): readonly string[] {
  const args = [...rawArgs];
  const outputIndexes = args.flatMap((argument, index) => argument === "--output" ? [index] : []);

  if (args.some((argument) => argument.startsWith("--output="))) {
    throw new CircleCliCommandError("INVALID_ARGUMENTS");
  }
  if (outputIndexes.length > 1) {
    throw new CircleCliCommandError("INVALID_ARGUMENTS");
  }
  if (outputIndexes.length === 1) {
    const index = outputIndexes[0]!;
    if (args[index + 1] !== "json") {
      throw new CircleCliCommandError("INVALID_ARGUMENTS");
    }
    return args;
  }

  return [...args, "--output", "json"];
}

function validateRunnerArguments(args: readonly string[]): void {
  if (args.length === 0 || args.some((argument) => !circleSafeCliTextSchema.safeParse(argument).success)) {
    throw new CircleCliCommandError("INVALID_ARGUMENTS");
  }
}

function toSafeCommandError(error: Error, stdout: string, stderr: string): CircleCliCommandError {
  const reportedError = parseReportedCliError(stdout) ?? parseReportedCliError(stderr);
  if (reportedError) {
    return reportedError;
  }
  const commandError = error as Error & {
    code?: string | number;
    killed?: boolean;
    signal?: string | null;
  };

  if (
    commandError.code === "ETIMEDOUT" ||
    commandError.killed === true ||
    commandError.signal === "SIGTERM"
  ) {
    return new CircleCliCommandError("TIMEOUT");
  }
  if (
    commandError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxbuffer/i.test(error.message)
  ) {
    return new CircleCliCommandError("OUTPUT_TOO_LARGE");
  }
  if (["EAGAIN", "EBUSY", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT"].includes(String(commandError.code))) {
    return new CircleCliCommandError("TRANSIENT");
  }
  return new CircleCliCommandError("COMMAND_FAILED");
}

function parseReportedCliError(stdout: string): CircleCliCommandError | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const error = (parsed as Readonly<Record<string, unknown>>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      return undefined;
    }
    const record = error as Readonly<Record<string, unknown>>;
    if (record.code === "AUTH_REQUIRED") {
      return new CircleCliCommandError("AUTH_REQUIRED");
    }
    if (
      record.code === "PERMISSION_DENIED" &&
      typeof record.message === "string" &&
      /\bterms\b/i.test(record.message)
    ) {
      return new CircleCliCommandError("TERMS_REQUIRED");
    }
    if (record.code === "TIMEOUT") {
      return new CircleCliCommandError("TIMEOUT");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function runReadOnly(
  runner: CircleCommandRunner,
  args: readonly string[],
  maxAttempts: number,
): Promise<unknown> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runner.run(args);
    } catch (error) {
      const retryable =
        error instanceof CircleCliCommandError &&
        (error.code === "TRANSIENT" || error.code === "TIMEOUT");
      if (!retryable || attempt === maxAttempts) {
        throw sanitizeAdapterError(error);
      }
    }
  }
  throw new CircleCliCommandError("TRANSIENT");
}

async function runMutation(runner: CircleCommandRunner, args: readonly string[]): Promise<unknown> {
  try {
    return await runner.run(args);
  } catch (error) {
    throw sanitizeAdapterError(error);
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CircleCliCommandError("INVALID_ARGUMENTS");
  }
  return parsed.data;
}

function parseCommandResponse<T>(
  schema: z.ZodType<T>,
  response: unknown,
  responseKeys: readonly string[],
): T {
  const parsed = schema.safeParse(unwrapResponse(response, responseKeys));
  if (!parsed.success) {
    throw new CircleCliCommandError("INVALID_RESPONSE");
  }
  return parsed.data;
}

function unwrapResponse(response: unknown, responseKeys: readonly string[]): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  const record = response as Readonly<Record<string, unknown>>;
  for (const key of [...responseKeys, "data", "result"]) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return response;
}

function buildHttpArgs(input: {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): readonly string[] {
  return [
    ...(input.method ? ["--method", input.method] : []),
    ...Object.entries(input.headers ?? {}).flatMap(([name, value]) => ["--header", `${name}: ${value}`]),
    ...(input.body ? ["--data", input.body] : []),
  ];
}

function sanitizeAdapterError(error: unknown): CircleCliCommandError {
  return error instanceof CircleCliCommandError
    ? error
    : new CircleCliCommandError("COMMAND_FAILED");
}

function requirePositiveInteger(value: number, _name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CircleCliCommandError("INVALID_ARGUMENTS");
  }
  return value;
}
