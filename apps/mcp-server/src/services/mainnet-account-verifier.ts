import { Interface, JsonRpcProvider, TypedDataEncoder, keccak256, toUtf8Bytes } from "ethers";

import {
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_WALLET_SETUP_TYPES,
  mainnetWalletSetupMessageSchema,
  type MainnetWalletSetupMessage,
} from "@agentpay-ai/shared-arc";

import { MAINNET_CHAIN_ID, MAINNET_USDC_ADDRESS } from "../runtime/production-readiness.ts";
export const MAINNET_ACCOUNT_CREATION_BYTECODE_HASH =
  "0x2ede9e46a03a9b3d8e8dc322905443b0fedfabd324c54c73fe1c748f10d0152a";
export const MAINNET_ACCOUNT_FACTORY_RUNTIME_CODE_HASH =
  "0xacf158d0950bc04fe98bb801a45eced68265b81b22d820e735a69037d2dd2254";

const accountInterface = new Interface([
  "function owner() view returns (address)",
  "function executor() view returns (address)",
  "function paused() view returns (bool)",
  "function domainSeparator() view returns (bytes32)",
  "function allowedTokens(address token) view returns (bool)",
]);
const erc20Interface = new Interface(["function decimals() view returns (uint8)"]);
const factoryInterface = new Interface([
  "function deployAccount((string setupIntentId,bytes32 deploymentNonce,address owner,address executor,uint256 homeChainId,string environment,uint256 deadline,address factory,bytes32 factoryRuntimeCodeHash,bytes32 deploymentSalt,address predictedAccount,bytes32 accountCreationCodeHash,bytes32 accountRuntimeCodeHash,address token,bytes32 tokenAllowlistHash,bytes32 routeAllowlistHash,bytes32 manifestSha256) authorization,bytes ownerSignature)",
  "event AccountDeployed(address indexed owner,address indexed account,bytes32 indexed salt,bytes32 authorizationHash)",
  "event AccountReused(address indexed owner,address indexed account,bytes32 indexed authorizationHash)",
]);
const tokenAllowedTopic = keccak256(toUtf8Bytes("TokenAllowedUpdated(address,bool)"));
const routeTargetAllowedTopic = keccak256(toUtf8Bytes("RouteTargetAllowedUpdated(address,bool)"));

export const MAINNET_LOG_BLOCK_RANGE = 100;

export interface MainnetLogFilter {
  address: string;
  topics?: Array<string | string[] | null>;
  fromBlock: number;
  toBlock: number;
}

export interface MainnetAccountLog {
  topics: readonly string[];
  data: string;
  blockNumber: number;
}

export interface MainnetLogScanOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  interChunkDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Keep this read-only Celo scan conservatively bounded and retry transient
 * provider throttling without ever widening the
 * requested range or treating a partial scan as valid.
 */
export async function fetchLogsInChunks(
  getBlockNumber: () => Promise<number>,
  getLogs: (filter: MainnetLogFilter) => Promise<ReadonlyArray<MainnetAccountLog>>,
  filter: Omit<MainnetLogFilter, "toBlock">,
  options: MainnetLogScanOptions = {},
): Promise<MainnetAccountLog[]> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const interChunkDelayMs = options.interChunkDelayMs ?? 250;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("RPC log scan maxAttempts must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("RPC log scan retryDelayMs must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(interChunkDelayMs) || interChunkDelayMs < 0) {
    throw new Error("RPC log scan interChunkDelayMs must be a non-negative safe integer.");
  }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC operation failed.");
  }

  if (!Number.isSafeInteger(filter.fromBlock) || filter.fromBlock < 0) {
    throw new Error("RPC log scan start block must be a non-negative safe integer.");
  }

  const latestBlock = await withRetry(getBlockNumber);
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
    throw new Error("RPC log scan latest block must be a non-negative safe integer.");
  }
  if (filter.fromBlock > latestBlock) {
    throw new Error("RPC log scan start block is after the latest block.");
  }

  const logs: MainnetAccountLog[] = [];
  for (let fromBlock = filter.fromBlock; fromBlock <= latestBlock; fromBlock += MAINNET_LOG_BLOCK_RANGE) {
    if (fromBlock > filter.fromBlock && interChunkDelayMs > 0) await sleep(interChunkDelayMs);
    const toBlock = Math.min(fromBlock + MAINNET_LOG_BLOCK_RANGE - 1, latestBlock);
    const chunk = await withRetry(() => getLogs({ ...filter, fromBlock, toBlock }));
    logs.push(...chunk);
  }
  return logs;
}

export interface MainnetAccountVerificationReader {
  getChainId(): Promise<number>;
  getCode(address: string): Promise<string>;
  getTransactionReceipt(txHash: string): Promise<{
    status: number | bigint | null;
    blockNumber: number;
    contractAddress: string | null;
    transactionHash?: string;
    logs?: ReadonlyArray<{
      address: string;
      topics: readonly string[];
      data: string;
    }>;
  } | null>;
  getTransactionData(txHash: string): Promise<string | null>;
  getTransaction?(txHash: string): Promise<{
    to: string | null;
    from: string;
    data: string;
  } | null>;
  getCodeHash?(address: string): Promise<string | null>;
  getAccountState(accountAddress: string): Promise<{
    owner: string;
    executor: string;
    paused: boolean;
    domainSeparator: string;
    allowedUsdc: boolean;
  }>;
  getTokenState(tokenAddress: string): Promise<{ code: string; decimals: number }>;
  getAllowlistEvents(accountAddress: string, fromBlock: number): Promise<{
    tokenEvents: Array<{ token: string; allowed: boolean }>;
    routeTargetEvents: Array<{ target: string; allowed: boolean }>;
  }>;
}

export interface MainnetAccountVerificationExpected {
  accountAddress: string;
  deploymentTxHash: string;
  creationBytecodeHash: string;
  runtimeBytecodeHash: string;
  ownerAddress: string;
  executorAddress: string;
  deployerAddress: string;
  tokenAddress?: string;
  tokenCodeHash: string;
  tokenDecimals: number;
  domainSeparator?: string;
}

export interface MainnetAccountVerificationResult {
  valid: boolean;
  checks: Record<string, boolean>;
  errors: string[];
  observed?: {
    chainId?: number;
    runtimeBytecodeHash?: string;
    ownerAddress?: string;
    executorAddress?: string;
    paused?: boolean;
    domainSeparator?: string;
    tokenCodeHash?: string;
    tokenDecimals?: number;
  };
}

interface FactoryDeploymentReceipt {
  readonly transactionHash?: string;
  readonly logs?: ReadonlyArray<{
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }>;
}

type EthersTypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

function addressEquals(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

function decodeFactoryAuthorization(data: string): Readonly<{
  authorization: MainnetWalletSetupMessage;
  ownerSignature: string;
}> {
  const decoded = factoryInterface.decodeFunctionData("deployAccount", data);
  const raw = decoded[0] as Record<string, unknown>;
  const authorization = mainnetWalletSetupMessageSchema.parse({
    setupIntentId: String(raw.setupIntentId),
    deploymentNonce: String(raw.deploymentNonce),
    owner: String(raw.owner),
    executor: String(raw.executor),
    homeChainId: Number(raw.homeChainId),
    environment: String(raw.environment),
    deadline: String(raw.deadline),
    factory: String(raw.factory),
    factoryRuntimeCodeHash: String(raw.factoryRuntimeCodeHash),
    deploymentSalt: String(raw.deploymentSalt),
    predictedAccount: String(raw.predictedAccount),
    accountCreationCodeHash: String(raw.accountCreationCodeHash),
    accountRuntimeCodeHash: String(raw.accountRuntimeCodeHash),
    token: String(raw.token),
    tokenAllowlistHash: String(raw.tokenAllowlistHash),
    routeAllowlistHash: String(raw.routeAllowlistHash),
    manifestSha256: String(raw.manifestSha256),
  });
  const ownerSignature = String(decoded[1]);
  if (!/^0x[0-9a-fA-F]{130}$/.test(ownerSignature)) {
    throw new Error("Factory deployment owner signature is malformed.");
  }
  return Object.freeze({ authorization: Object.freeze({ ...authorization }), ownerSignature });
}

function assertFactoryAuthorization(
  authorization: MainnetWalletSetupMessage,
  transactionFactory: string,
  expected: MainnetAccountVerificationExpected,
): void {
  const bindings: ReadonlyArray<readonly [string, string, string]> = [
    ["owner", authorization.owner, expected.ownerAddress],
    ["executor", authorization.executor, expected.executorAddress],
    ["factory", authorization.factory, transactionFactory],
    ["factory runtime code hash", authorization.factoryRuntimeCodeHash, MAINNET_ACCOUNT_FACTORY_RUNTIME_CODE_HASH],
    ["predicted account", authorization.predictedAccount, expected.accountAddress],
    ["account creation code hash", authorization.accountCreationCodeHash, expected.creationBytecodeHash],
    ["account runtime code hash", authorization.accountRuntimeCodeHash, expected.runtimeBytecodeHash],
    ["token", authorization.token, MAINNET_USDC_ADDRESS],
    ["token allowlist hash", authorization.tokenAllowlistHash, MAINNET_SETUP_TOKEN_ALLOWLIST_HASH],
    ["route allowlist hash", authorization.routeAllowlistHash, MAINNET_SETUP_ROUTE_ALLOWLIST_HASH],
  ];
  for (const [name, actual, wanted] of bindings) {
    if (!addressEquals(actual, wanted)) {
      throw new Error(`Factory deployment authorization ${name} does not match the production manifest policy.`);
    }
  }
  if (authorization.homeChainId !== MAINNET_CHAIN_ID || authorization.environment !== "production") {
    throw new Error("Factory deployment authorization chain or environment does not match production.");
  }
  if ([authorization.owner, authorization.executor, authorization.factory]
    .some((actor) => addressEquals(actor, expected.deployerAddress))) {
    throw new Error("Factory deployment authorization actors must be distinct from the manifest deployer.");
  }
}

function assertFactoryReceiptEvent(
  receipt: FactoryDeploymentReceipt,
  factoryAddress: string,
  authorization: MainnetWalletSetupMessage,
  authorizationHash: string,
): void {
  if (!Array.isArray(receipt.logs)) {
    throw new Error("Factory deployment AccountDeployed event proof is missing from the receipt.");
  }
  const deployedEvents: Array<ReturnType<Interface["parseLog"]>> = [];
  for (const log of receipt.logs) {
    if (!log || typeof log.address !== "string" || !Array.isArray(log.topics) || typeof log.data !== "string") {
      throw new Error("Factory deployment event is malformed.");
    }
    if (!addressEquals(log.address, factoryAddress)) continue;
    let parsed: ReturnType<Interface["parseLog"]>;
    try {
      parsed = factoryInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      const topic = log.topics[0]?.toLowerCase();
      if (topic === factoryInterface.getEvent("AccountDeployed")!.topicHash.toLowerCase()
        || topic === factoryInterface.getEvent("AccountReused")!.topicHash.toLowerCase()) {
        throw new Error("Factory deployment event is malformed.");
      }
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === "AccountReused") {
      throw new Error("Factory deployment receipt contains AccountReused instead of a new AccountDeployed proof.");
    }
    if (parsed.name === "AccountDeployed") deployedEvents.push(parsed);
  }
  if (deployedEvents.length !== 1) {
    throw new Error("Factory deployment receipt must contain exactly one AccountDeployed event.");
  }
  const event = deployedEvents[0]!;
  if (!addressEquals(String(event.args.owner), authorization.owner)
    || !addressEquals(String(event.args.account), authorization.predictedAccount)
    || !addressEquals(String(event.args.salt), authorization.deploymentSalt)
    || !addressEquals(String(event.args.authorizationHash), authorizationHash)) {
    throw new Error("Factory deployment AccountDeployed event does not match the authorization hash and account bindings.");
  }
}

async function verifyFactoryDeploymentProof(
  reader: MainnetAccountVerificationReader,
  receipt: FactoryDeploymentReceipt,
  expected: MainnetAccountVerificationExpected,
): Promise<void> {
  if (!reader.getTransaction || !reader.getCodeHash) {
    throw new Error("Mainnet deployment receipt does not point to the manifest account and factory deployment proof is unavailable.");
  }
  if (!receipt.transactionHash || !addressEquals(receipt.transactionHash, expected.deploymentTxHash)) {
    throw new Error("Factory deployment receipt transaction hash does not match the manifest.");
  }
  const transaction = await reader.getTransaction(expected.deploymentTxHash);
  if (!transaction) throw new Error("Factory deployment transaction is missing.");
  if (!transaction.to) throw new Error("Factory deployment transaction target is missing.");
  if (!addressEquals(transaction.from, expected.deployerAddress)) {
    throw new Error("Factory deployment transaction sender does not match the manifest deployer.");
  }
  const factoryRuntimeCodeHash = await reader.getCodeHash(transaction.to);
  if (!factoryRuntimeCodeHash
    || !addressEquals(factoryRuntimeCodeHash, MAINNET_ACCOUNT_FACTORY_RUNTIME_CODE_HASH)) {
    throw new Error("Factory deployment target does not have the pinned AgentPayCeloAccountFactoryV1 runtime code hash.");
  }

  let decoded: ReturnType<typeof decodeFactoryAuthorization>;
  try {
    decoded = decodeFactoryAuthorization(transaction.data);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Factory deployment owner signature")) throw error;
    throw new Error("Factory deployment authorization/calldata is malformed or does not encode deployAccount.");
  }
  assertFactoryAuthorization(decoded.authorization, transaction.to, expected);
  const authorizationHash = TypedDataEncoder.hash(
    { name: "AgentPay Setup", version: "1", chainId: MAINNET_CHAIN_ID, verifyingContract: decoded.authorization.factory },
    MAINNET_WALLET_SETUP_TYPES as unknown as EthersTypedDataTypes,
    decoded.authorization,
  ).toLowerCase();
  assertFactoryReceiptEvent(receipt, transaction.to, decoded.authorization, authorizationHash);
}

export async function verifyMainnetAccount(
  reader: MainnetAccountVerificationReader,
  expected: MainnetAccountVerificationExpected,
): Promise<MainnetAccountVerificationResult> {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};
  const observed: MainnetAccountVerificationResult["observed"] = {};

  function check(name: string, valid: boolean, message: string): void {
    checks[name] = valid;
    if (!valid) {
      errors.push(message);
    }
  }

  check("creation bytecode pin", expected.creationBytecodeHash.toLowerCase() === MAINNET_ACCOUNT_CREATION_BYTECODE_HASH.toLowerCase(), "Creation bytecode hash does not match the pinned V2 artifact.");

  try {
    const chainId = await reader.getChainId();
    observed.chainId = chainId;
    check("chain id", chainId === MAINNET_CHAIN_ID, `Mainnet account verifier received chain id ${chainId}, expected ${MAINNET_CHAIN_ID}.`);
  } catch {
    check("chain id", false, "Mainnet account chain id could not be read.");
  }

  try {
    const code = await reader.getCode(expected.accountAddress);
    const runtimeBytecodeHash = code === "0x" ? undefined : keccak256(code).toLowerCase();
    observed.runtimeBytecodeHash = runtimeBytecodeHash;
    check("runtime code exists", Boolean(runtimeBytecodeHash), "AgentPay account has no runtime code.");
    check(
      "runtime bytecode hash",
      Boolean(runtimeBytecodeHash) && runtimeBytecodeHash === expected.runtimeBytecodeHash.toLowerCase(),
      "AgentPay account runtime bytecode hash does not match the manifest.",
    );
  } catch {
    check("runtime bytecode hash", false, "AgentPay account runtime code could not be read.");
  }

  let deploymentBlock: number | undefined;
  try {
    const receipt = await reader.getTransactionReceipt(expected.deploymentTxHash);
    check("deployment receipt", Boolean(receipt), "Mainnet account deployment receipt is missing.");
    if (receipt) {
      deploymentBlock = receipt.blockNumber;
      check("deployment receipt status", Number(receipt.status) === 1, "Mainnet account deployment receipt did not succeed.");
      if (typeof receipt.contractAddress === "string") {
        check(
          "deployment account",
          receipt.contractAddress.toLowerCase() === expected.accountAddress.toLowerCase(),
          "Mainnet deployment receipt does not point to the manifest account.",
        );
      } else {
        try {
          await verifyFactoryDeploymentProof(reader, receipt, expected);
          checks["deployment account"] = true;
          checks["factory deployment proof"] = true;
        } catch (error) {
          checks["deployment account"] = false;
          checks["factory deployment proof"] = false;
          errors.push(error instanceof Error ? error.message : "Factory deployment proof could not be verified.");
        }
      }
    }
  } catch {
    check("deployment receipt", false, "Mainnet account deployment receipt could not be read.");
  }

  try {
    const account = await reader.getAccountState(expected.accountAddress);
    observed.ownerAddress = account.owner;
    observed.executorAddress = account.executor;
    observed.paused = account.paused;
    observed.domainSeparator = account.domainSeparator;
    check("owner", account.owner.toLowerCase() === expected.ownerAddress.toLowerCase(), "Account owner does not match the manifest.");
    check("executor", account.executor.toLowerCase() === expected.executorAddress.toLowerCase(), "Account executor does not match the manifest.");
    check("owner and executor distinct", account.owner.toLowerCase() !== account.executor.toLowerCase(), "Account owner and executor must be different.");
    check("paused", account.paused === false, "Mainnet AgentPay account is paused.");
    const expectedDomain = TypedDataEncoder.hashDomain({
      name: "AgentPay",
      version: "1",
      chainId: MAINNET_CHAIN_ID,
      verifyingContract: expected.accountAddress,
    });
    check("domain separator", account.domainSeparator.toLowerCase() === expectedDomain.toLowerCase(), "Account EIP-712 domain separator does not match AgentPay/mainnet.");
    if (expected.domainSeparator) {
      check("manifest domain separator", account.domainSeparator.toLowerCase() === expected.domainSeparator.toLowerCase(), "Account domain separator does not match the manifest.");
    }
    check("USDC allowlist", account.allowedUsdc, "Celo mainnet USDC is not allowlisted on the AgentPay account.");
  } catch {
    check("account state", false, "AgentPay account state could not be read.");
  }

  try {
    const tokenAddress = expected.tokenAddress ?? MAINNET_USDC_ADDRESS;
    const token = await reader.getTokenState(tokenAddress);
    const tokenCodeHash = token.code === "0x" ? undefined : keccak256(token.code).toLowerCase();
    observed.tokenCodeHash = tokenCodeHash;
    observed.tokenDecimals = token.decimals;
    check("token code", Boolean(tokenCodeHash) && tokenCodeHash === expected.tokenCodeHash.toLowerCase(), "Celo mainnet USDC code hash does not match the manifest.");
    check("token decimals", token.decimals === expected.tokenDecimals, "Celo mainnet USDC decimals do not match the manifest.");
  } catch {
    check("token state", false, "Celo mainnet USDC code or decimals could not be read.");
  }

  if (deploymentBlock !== undefined) {
    try {
      const events = await reader.getAllowlistEvents(expected.accountAddress, deploymentBlock);
      for (const event of events.tokenEvents) {
        if (event.allowed && event.token.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()) {
          errors.push(`Token allowlist event enables non-USDC token ${event.token}.`);
        }
      }
      for (const event of events.routeTargetEvents) {
        if (event.allowed) {
          errors.push(`Route target ${event.target} is enabled; mainnet route-target allowlist must remain empty.`);
        }
      }
      checks["allowlist event history"] = !events.tokenEvents.some(
        (event) => event.allowed && event.token.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase(),
      ) && !events.routeTargetEvents.some((event) => event.allowed);
      if (!checks["allowlist event history"]) {
        checks["allowlist event history"] = false;
      }
    } catch {
      checks["allowlist event history"] = false;
      errors.push("Account allowlist event history could not be read.");
    }
  }

  return { valid: errors.length === 0, checks, errors, observed };
}

export function createEthersMainnetAccountVerificationReader(rpcUrl: string): MainnetAccountVerificationReader {
  const provider = new JsonRpcProvider(rpcUrl);

  async function call<T>(accountAddress: string, method: string, args: unknown[], types: string[]): Promise<T> {
    const data = accountInterface.encodeFunctionData(method, args);
    const result = await provider.call({ to: accountAddress, data });
    return accountInterface.decodeFunctionResult(method, result)[0] as T;
  }

  return {
    async getChainId() {
      return Number((await provider.getNetwork()).chainId);
    },
    getCode: (address) => provider.getCode(address),
    async getTransactionReceipt(txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      return receipt
        ? {
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            contractAddress: receipt.contractAddress,
            transactionHash: receipt.hash,
            logs: receipt.logs.map((log) => ({
              address: log.address,
              topics: [...log.topics],
              data: log.data,
            })),
          }
        : null;
    },
    async getTransactionData(txHash) {
      const transaction = await provider.getTransaction(txHash);
      return transaction?.data ?? null;
    },
    async getTransaction(txHash) {
      const transaction = await provider.getTransaction(txHash);
      return transaction
        ? { to: transaction.to, from: transaction.from, data: transaction.data }
        : null;
    },
    async getCodeHash(address) {
      const code = await provider.getCode(address);
      return code === "0x" ? null : keccak256(code).toLowerCase();
    },
    async getAccountState(accountAddress) {
      return {
        owner: await call<string>(accountAddress, "owner", [], []),
        executor: await call<string>(accountAddress, "executor", [], []),
        paused: await call<boolean>(accountAddress, "paused", [], []),
        domainSeparator: await call<string>(accountAddress, "domainSeparator", [], []),
        allowedUsdc: await call<boolean>(accountAddress, "allowedTokens", [MAINNET_USDC_ADDRESS], []),
      };
    },
    async getTokenState(tokenAddress) {
      const code = await provider.getCode(tokenAddress);
      const data = erc20Interface.encodeFunctionData("decimals", []);
      const result = await provider.call({ to: tokenAddress, data });
      const [decimals] = erc20Interface.decodeFunctionResult("decimals", result);
      return { code, decimals: Number(decimals) };
    },
    async getAllowlistEvents(accountAddress, fromBlock) {
      const logs = await fetchLogsInChunks(
        () => provider.getBlockNumber(),
        (filter) => provider.getLogs(filter),
        {
          address: accountAddress,
          topics: [[tokenAllowedTopic, routeTargetAllowedTopic]],
          fromBlock,
        },
      );
      const tokenLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === tokenAllowedTopic.toLowerCase());
      const routeLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === routeTargetAllowedTopic.toLowerCase());
      return {
        tokenEvents: tokenLogs.map((log) => ({
          token: `0x${log.topics[1]?.slice(-40) ?? ""}`,
          allowed: Boolean(Number(BigInt(log.data))),
        })),
        routeTargetEvents: routeLogs.map((log) => ({
          target: `0x${log.topics[1]?.slice(-40) ?? ""}`,
          allowed: Boolean(Number(BigInt(log.data))),
        })),
      };
    },
  };
}
