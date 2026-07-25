import { pathToFileURL } from "node:url";

import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import {
  AGENTPAY_ERC8004_METADATA_URL,
  CELO_MAINNET_IDENTITY_REGISTRY,
  agentPayErc8004RegistrationSchema,
  type AgentPayErc8004Registration,
} from "@agentpay-ai/shared-arc";

const registryInterface = new Interface([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)",
]);
const signaturePattern = /^0x[a-fA-F0-9]{130}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";

export interface Erc8004TransactionRequest {
  chainId: 42220;
  to: typeof CELO_MAINNET_IDENTITY_REGISTRY;
  data: string;
  value: "0";
}

export interface Erc8004AgentWalletProofInput {
  agentId: number;
  newWallet: string;
  owner: string;
  deadline: number;
}

export interface Erc8004IdentityReader {
  getChainId(): Promise<number>;
  ownerOf(agentId: number): Promise<string>;
  tokenUri(agentId: number): Promise<string>;
  getAgentWallet(agentId: number): Promise<string>;
}

export interface Erc8004CliDependencies {
  now?: () => number;
  fetch?: typeof fetch;
  identityReader?: Erc8004IdentityReader;
  write?: (payload: unknown) => void;
}

export interface Erc8004AgentWalletProofTypedData {
  domain: TypedDataDomain & {
    name: "ERC8004IdentityRegistry";
    version: "1";
    chainId: 42220;
    verifyingContract: typeof CELO_MAINNET_IDENTITY_REGISTRY;
  };
  types: Record<"AgentWalletSet", TypedDataField[]>;
  primaryType: "AgentWalletSet";
  message: {
    agentId: number;
    newWallet: string;
    owner: string;
    deadline: number;
  };
}

export function buildErc8004RegisterTransaction(agentUri: string): Erc8004TransactionRequest {
  if (agentUri !== AGENTPAY_ERC8004_METADATA_URL) {
    throw new Error("ERC-8004 registration requires the pinned AgentPay metadata URL.");
  }
  return transaction(registryInterface.encodeFunctionData("register", [agentUri]));
}

export function createErc8004AgentWalletProofTypedData(
  input: Erc8004AgentWalletProofInput,
): Erc8004AgentWalletProofTypedData {
  const normalized = normalizeWalletProofInput(input);
  return {
    domain: {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: 42220,
      verifyingContract: CELO_MAINNET_IDENTITY_REGISTRY,
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: normalized,
  };
}

export function buildErc8004SetAgentWalletTransaction(
  input: Erc8004AgentWalletProofInput & { signature: string },
): Erc8004TransactionRequest {
  if (!signaturePattern.test(input.signature)) {
    throw new Error("ERC-8004 agent-wallet proof requires a 65-byte owner signature.");
  }
  const typedData = createErc8004AgentWalletProofTypedData(input);
  let recovered: string;
  try {
    recovered = verifyTypedData(typedData.domain, typedData.types, typedData.message, input.signature);
  } catch {
    throw new Error("ERC-8004 agent-wallet proof has an invalid owner signature.");
  }
  if (recovered.toLowerCase() !== typedData.message.owner.toLowerCase()) {
    throw new Error("ERC-8004 agent-wallet proof has an invalid owner signature.");
  }
  return transaction(registryInterface.encodeFunctionData("setAgentWallet", [
    typedData.message.agentId,
    typedData.message.newWallet,
    typedData.message.deadline,
    input.signature,
  ]));
}

export async function verifyLiveAgentRegistration(options: {
  agentWalletAddress: string;
  fetch?: typeof fetch;
}): Promise<AgentPayErc8004Registration> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(AGENTPAY_ERC8004_METADATA_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("AgentPay ERC-8004 metadata is not reachable over HTTPS.");
  }
  if (!response.ok) {
    throw new Error("AgentPay ERC-8004 metadata is not reachable over HTTPS.");
  }

  let metadata: AgentPayErc8004Registration;
  try {
    metadata = agentPayErc8004RegistrationSchema.parse(await response.json());
  } catch {
    throw new Error("AgentPay ERC-8004 live metadata is invalid.");
  }
  const expectedWallet = `eip155:42220:${normalizeAddress(options.agentWalletAddress, "agent wallet").toLowerCase()}`;
  if (metadata.services[2].endpoint.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error("AgentPay ERC-8004 live metadata does not match the deployed agent wallet.");
  }
  return metadata;
}

export async function verifyErc8004OnchainIdentity(options: {
  agentId: number;
  ownerAddress: string;
  agentWalletAddress: string;
  reader: Erc8004IdentityReader;
  fetch?: typeof fetch;
}) {
  const ownerAddress = normalizeAddress(options.ownerAddress, "owner");
  const agentWalletAddress = normalizeAddress(options.agentWalletAddress, "agent wallet");
  const typedData = createErc8004AgentWalletProofTypedData({
    agentId: options.agentId,
    newWallet: agentWalletAddress,
    owner: ownerAddress,
    deadline: 1,
  });
  const metadata = await verifyLiveAgentRegistration({
    agentWalletAddress,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const registration = metadata.registrations.find((candidate) => candidate.agentId === options.agentId);
  if (!registration) throw new Error("ERC-8004 domain registration does not include the on-chain agent id.");

  const [chainId, onchainOwner, agentUri, onchainWallet] = await Promise.all([
    options.reader.getChainId(),
    options.reader.ownerOf(options.agentId),
    options.reader.tokenUri(options.agentId),
    options.reader.getAgentWallet(options.agentId),
  ]);
  if (chainId !== 42220) throw new Error("ERC-8004 chain mismatch; expected Celo mainnet.");
  if (normalizeAddress(onchainOwner, "on-chain owner").toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error("ERC-8004 owner mismatch.");
  }
  if (agentUri !== AGENTPAY_ERC8004_METADATA_URL) throw new Error("ERC-8004 agent URI mismatch.");
  if (normalizeAddress(onchainWallet, "on-chain agent wallet").toLowerCase() !== agentWalletAddress.toLowerCase()) {
    throw new Error("ERC-8004 agent wallet mismatch.");
  }

  return {
    chainId: typedData.domain.chainId,
    identityRegistry: CELO_MAINNET_IDENTITY_REGISTRY,
    agentId: options.agentId,
    ownerAddress,
    agentWalletAddress,
    agentUri,
    domainRegistrationVerified: true as const,
  };
}

function normalizeWalletProofInput(input: Erc8004AgentWalletProofInput) {
  if (!Number.isSafeInteger(input.agentId) || input.agentId < 0) {
    throw new Error("ERC-8004 agent id must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0) {
    throw new Error("ERC-8004 wallet-proof deadline must be a positive Unix timestamp.");
  }
  return {
    agentId: input.agentId,
    newWallet: normalizeAddress(input.newWallet, "agent wallet"),
    owner: normalizeAddress(input.owner, "owner"),
    deadline: input.deadline,
  };
}

function normalizeAddress(value: string, field: string): string {
  let address: string;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`ERC-8004 ${field} must be a valid EVM address.`);
  }
  if (address.toLowerCase() === zeroAddress) {
    throw new Error(`ERC-8004 ${field} must not be the zero address.`);
  }
  return address;
}

function transaction(data: string): Erc8004TransactionRequest {
  return {
    chainId: 42220,
    to: CELO_MAINNET_IDENTITY_REGISTRY,
    data,
    value: "0",
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function parseAgentId(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid AGENTPAY_ERC8004_AGENT_ID.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid AGENTPAY_ERC8004_AGENT_ID.");
  return parsed;
}

function parseWalletProofDeadline(value: string, nowMilliseconds: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid AGENTPAY_ERC8004_WALLET_PROOF_DEADLINE.");
  }
  const deadline = Number(value);
  const now = Math.floor(nowMilliseconds / 1_000);
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("Invalid AGENTPAY_ERC8004_WALLET_PROOF_DEADLINE.");
  }
  if (deadline < now) throw new Error("ERC-8004 wallet proof has expired.");
  if (deadline > now + 300) throw new Error("ERC-8004 wallet proof cannot exceed five minutes.");
  return deadline;
}

export async function runErc8004Cli(
  args: string[],
  env: NodeJS.ProcessEnv,
  dependencies: Erc8004CliDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? ((payload: unknown) => console.log(JSON.stringify(payload, null, 2)));
  const command = args[0];
  if (command === "register") {
    const agentWalletAddress = requiredEnv(env, "AGENTPAY_ERC8004_AGENT_WALLET");
    await verifyLiveAgentRegistration({
      agentWalletAddress,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    write({
      action: "REGISTER_AGENT",
      agentUri: AGENTPAY_ERC8004_METADATA_URL,
      transaction: buildErc8004RegisterTransaction(AGENTPAY_ERC8004_METADATA_URL),
      instruction: "Review and submit this transaction from the AgentPay owner wallet. No transaction was broadcast.",
    });
    return;
  }
  if (command === "wallet-proof") {
    const deadline = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000) + 240;
    write({
      action: "SIGN_AGENT_WALLET_PROOF",
      typedData: createErc8004AgentWalletProofTypedData({
        agentId: parseAgentId(requiredEnv(env, "AGENTPAY_ERC8004_AGENT_ID")),
        newWallet: requiredEnv(env, "AGENTPAY_ERC8004_AGENT_WALLET"),
        owner: requiredEnv(env, "AGENTPAY_OWNER_ADDRESS"),
        deadline,
      }),
      instruction: "Sign this EIP-712 payload with the immutable owner EOA within four minutes. No signature was created.",
    });
    return;
  }
  if (command === "set-wallet") {
    const deadline = parseWalletProofDeadline(
      requiredEnv(env, "AGENTPAY_ERC8004_WALLET_PROOF_DEADLINE"),
      dependencies.now?.() ?? Date.now(),
    );
    write({
      action: "SET_AGENT_WALLET",
      transaction: buildErc8004SetAgentWalletTransaction({
        agentId: parseAgentId(requiredEnv(env, "AGENTPAY_ERC8004_AGENT_ID")),
        newWallet: requiredEnv(env, "AGENTPAY_ERC8004_AGENT_WALLET"),
        owner: requiredEnv(env, "AGENTPAY_OWNER_ADDRESS"),
        deadline,
        signature: requiredEnv(env, "AGENTPAY_ERC8004_WALLET_PROOF_SIGNATURE"),
      }),
      instruction: "Review and submit this transaction from the ERC-8004 agent NFT owner. No transaction was broadcast.",
    });
    return;
  }
  if (command === "verify") {
    let reader = dependencies.identityReader;
    if (!reader) {
      const provider = new JsonRpcProvider(requiredEnv(env, "CELO_MAINNET_RPC_URL"));
      const registry = new Contract(CELO_MAINNET_IDENTITY_REGISTRY, [
        "function ownerOf(uint256 agentId) view returns (address)",
        "function tokenURI(uint256 agentId) view returns (string)",
        "function getAgentWallet(uint256 agentId) view returns (address)",
      ], provider);
      reader = {
        async getChainId() { return Number((await provider.getNetwork()).chainId); },
        async ownerOf(agentId) { return String(await registry.ownerOf(agentId)); },
        async tokenUri(agentId) { return String(await registry.tokenURI(agentId)); },
        async getAgentWallet(agentId) { return String(await registry.getAgentWallet(agentId)); },
      };
    }
    const evidence = await verifyErc8004OnchainIdentity({
      agentId: parseAgentId(requiredEnv(env, "AGENTPAY_ERC8004_AGENT_ID")),
      ownerAddress: requiredEnv(env, "AGENTPAY_OWNER_ADDRESS"),
      agentWalletAddress: requiredEnv(env, "AGENTPAY_ERC8004_AGENT_WALLET"),
      reader,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    write({ action: "VERIFY_AGENT_IDENTITY", evidence });
    return;
  }
  throw new Error("Usage: npm run erc8004 -- register|wallet-proof|set-wallet|verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runErc8004Cli(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : "ERC-8004 operation failed.");
    process.exitCode = 1;
  });
}
