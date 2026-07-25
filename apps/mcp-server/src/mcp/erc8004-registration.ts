import {
  AGENTPAY_ERC8004_METADATA_URL,
  CELO_MAINNET_IDENTITY_REGISTRY,
  createAgentPayErc8004Registration,
  type AgentPayErc8004Registration,
} from "@agentpay-ai/shared-arc";
import { Contract, JsonRpcProvider } from "ethers";

const enabledValues = new Set(["1", "true", "yes", "on"]);
const disabledValues = new Set(["0", "false", "no", "off"]);
const canonicalIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";

export interface AgentPayErc8004IdentityReader {
  getChainId(): Promise<number>;
  ownerOf(agentId: number): Promise<string>;
  tokenUri(agentId: number): Promise<string>;
  getAgentWallet(agentId: number): Promise<string>;
}

export function parseAgentPayErc8004Env(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AgentPayErc8004Registration | undefined {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() || undefined]),
  ) as Record<string, string | undefined>;
  const enabled = normalized.AGENTPAY_ERC8004_ENABLED?.toLowerCase();
  if (!enabled || disabledValues.has(enabled)) return undefined;
  if (!enabledValues.has(enabled)) {
    throw new Error("AgentPay ERC-8004 configuration is invalid (AGENTPAY_ERC8004_ENABLED).");
  }
  if (normalized.AGENTPAY_ENVIRONMENT !== "production" || normalized.AGENTPAY_HOME_CHAIN_ID !== "42220") {
    throw new Error("AgentPay ERC-8004 publication requires the Celo mainnet production boundary.");
  }
  if (!normalized.AGENTPAY_ERC8004_AGENT_WALLET) {
    throw new Error("AgentPay ERC-8004 configuration is missing AGENTPAY_ERC8004_AGENT_WALLET.");
  }

  const rawAgentId = normalized.AGENTPAY_ERC8004_AGENT_ID;
  let agentId: number | undefined;
  if (rawAgentId !== undefined) {
    if (!canonicalIntegerPattern.test(rawAgentId)) {
      throw new Error("AgentPay ERC-8004 agent id is invalid.");
    }
    agentId = Number(rawAgentId);
    if (!Number.isSafeInteger(agentId)) {
      throw new Error("AgentPay ERC-8004 agent id is invalid.");
    }
  }

  try {
    return createAgentPayErc8004Registration({
      agentWalletAddress: normalized.AGENTPAY_ERC8004_AGENT_WALLET,
      ...(agentId === undefined ? {} : { agentId }),
    });
  } catch {
    throw new Error("AgentPay ERC-8004 configuration contains invalid public identity values.");
  }
}

export async function verifyConfiguredAgentPayErc8004Identity(
  metadata: AgentPayErc8004Registration,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  reader?: AgentPayErc8004IdentityReader,
): Promise<void> {
  const registration = metadata.registrations[0];
  if (!registration) return;

  const owner = env.AGENTPAY_OWNER_ADDRESS?.trim();
  const rpcUrl = env.CELO_MAINNET_RPC_URL?.trim();
  if (!isNonZeroAddress(owner)) throw new Error("AgentPay ERC-8004 owner configuration is invalid.");
  if (!rpcUrl || !isProductionHttpsUrl(rpcUrl)) {
    throw new Error("AgentPay ERC-8004 Celo mainnet RPC configuration is invalid.");
  }
  const wallet = metadata.services[2].endpoint.slice("eip155:42220:".length);
  const identityReader = reader ?? createIdentityReader(rpcUrl);

  let chainId: number;
  let onchainOwner: string;
  let agentUri: string;
  let onchainWallet: string;
  try {
    [chainId, onchainOwner, agentUri, onchainWallet] = await Promise.all([
      identityReader.getChainId(),
      identityReader.ownerOf(registration.agentId),
      identityReader.tokenUri(registration.agentId),
      identityReader.getAgentWallet(registration.agentId),
    ]);
  } catch {
    throw new Error("AgentPay ERC-8004 on-chain identity is unavailable.");
  }
  if (chainId !== 42220) throw new Error("AgentPay ERC-8004 chain mismatch.");
  if (!sameAddress(onchainOwner, owner)) throw new Error("AgentPay ERC-8004 owner mismatch.");
  if (agentUri !== AGENTPAY_ERC8004_METADATA_URL) throw new Error("AgentPay ERC-8004 agent URI mismatch.");
  if (!sameAddress(onchainWallet, wallet)) throw new Error("AgentPay ERC-8004 agent wallet mismatch.");
}

function createIdentityReader(rpcUrl: string): AgentPayErc8004IdentityReader {
  const provider = new JsonRpcProvider(rpcUrl);
  const registry = new Contract(CELO_MAINNET_IDENTITY_REGISTRY, [
    "function ownerOf(uint256 agentId) view returns (address)",
    "function tokenURI(uint256 agentId) view returns (string)",
    "function getAgentWallet(uint256 agentId) view returns (address)",
  ], provider);
  return {
    async getChainId() { return Number((await provider.getNetwork()).chainId); },
    async ownerOf(agentId) { return String(await registry.ownerOf(agentId)); },
    async tokenUri(agentId) { return String(await registry.tokenURI(agentId)); },
    async getAgentWallet(agentId) { return String(await registry.getAgentWallet(agentId)); },
  };
}

function isProductionHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
      !/test|dev|staging/i.test(url.hostname);
  } catch {
    return false;
  }
}

function isNonZeroAddress(value: string | undefined): value is string {
  return Boolean(value && addressPattern.test(value) && value.toLowerCase() !== zeroAddress);
}

function sameAddress(left: string, right: string): boolean {
  return addressPattern.test(left) && addressPattern.test(right) && left.toLowerCase() === right.toLowerCase();
}
