import { isIP } from "node:net";

import { z } from "zod";

export const ARC_TESTNET_ERC8004_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const ARC_TESTNET_ERC8004_REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const ARC_TESTNET_ERC8004_VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
export const ARC_TESTNET_ERC8004_AGENT_REGISTRY =
  `eip155:5042002:${ARC_TESTNET_ERC8004_IDENTITY_REGISTRY}` as const;

export const erc8004IdentityAbi = Object.freeze([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
] as const);

export const erc8004ReputationAbi = Object.freeze([
  "function giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
  "function getSummary(uint256 agentId,address[] clientAddresses,string tag1,string tag2) view returns (uint64 count,int128 summaryValue,uint8 summaryValueDecimals)",
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
] as const);

export const erc8004ValidationAbi = Object.freeze([
  "function validationRequest(address,uint256,string,bytes32)",
  "function validationResponse(bytes32,uint8,string,bytes32,string)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress,uint256 agentId,uint8 response,bytes32 responseHash,string tag,uint256 lastUpdate)",
  "function getSummary(uint256 agentId,address[] validatorAddresses,string tag) view returns (uint64 count,uint8 avgResponse)",
  "event ValidationRequest(address indexed validatorAddress,uint256 indexed agentId,string requestURI,bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress,uint256 indexed agentId,bytes32 indexed requestHash,uint8 response,string responseURI,bytes32 responseHash,string tag)",
] as const);

export const CELO_MAINNET_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const CELO_MAINNET_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const CELO_MAINNET_AGENT_REGISTRY = `eip155:42220:${CELO_MAINNET_IDENTITY_REGISTRY}` as const;
export const AGENTPAY_ERC8004_METADATA_URL =
  "https://wallet.agentpay.site/.well-known/agent-registration.json";

const registrationType = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" as const;
const agentPayDescription =
  "Owner-authorized stablecoin payment agent for direct payments, invoices, remittance routes, and x402 services on Celo, with guarded contract-call preparation.";
const agentPayImage = "https://www.agentpay.site/agentpay-logo/agentpay-icon-192.png" as const;
const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const walletEndpointPattern = /^eip155:42220:0x[a-fA-F0-9]{40}$/;
const uint256Max = (1n << 256n) - 1n;
const reputationMaxAbsValue = 10n ** 38n;
const secretPattern =
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|mnemonic|password|private[_-]?key|seed[_-]?phrase|session[_-]?token)\s*(?:=|:|%3[dD])/i;

export const erc8004AgentIdSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)$/, "Expected a canonical uint256 agent id")
  .refine((value) => BigInt(value) <= uint256Max, "Agent id exceeds uint256");

export const erc8004Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Expected a bytes32 hex value");

export const erc8004SafeUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !value.startsWith("-"), "URI must not begin with a CLI option")
  .refine((value) => !secretPattern.test(value), "URI must not contain secret material")
  .superRefine((value, context) => {
    if (value.startsWith("ipfs://")) {
      if (!/^ipfs:\/\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value)) {
        context.addIssue({ code: "custom", message: "Invalid IPFS URI" });
      }
      return;
    }
    if (value.startsWith("ar://")) {
      if (!/^ar:\/\/[A-Za-z0-9_-]{32,}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value)) {
        context.addIssue({ code: "custom", message: "Invalid Arweave URI" });
      }
      return;
    }
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || isPrivateMetadataHost(url.hostname)
        || url.hostname.endsWith(".localhost")
        || url.hostname.endsWith(".local")
        || url.hostname.endsWith(".invalid")
      ) {
        context.addIssue({ code: "custom", message: "Expected a public HTTPS, IPFS, or Arweave URI" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Invalid metadata URI" });
    }
  });

function isPrivateMetadataHost(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost") return true;
  const family = isIP(hostname);
  if (family === 4) {
    const [first, second] = hostname.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first! >= 224;
  }
  if (family === 6) {
    return hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("::ffff:")
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || /^fe[89ab]/.test(hostname)
      || hostname.startsWith("ff");
  }
  return false;
}

const optionalSafeUriSchema = z.union([z.literal(""), erc8004SafeUriSchema]);
const erc8004TagSchema = z.string().trim().max(128);
const walletSelectionSchema = z.object({
  walletAddress: z.string().trim().regex(evmAddressPattern).optional(),
});

export const arcErc8004RegistrationInputSchema = walletSelectionSchema.extend({
  idempotencyKey: z.string().uuid(),
  agentURI: erc8004SafeUriSchema,
}).strict();

export const arcErc8004IdentityInputSchema = z.object({
  agentId: erc8004AgentIdSchema,
}).strict();

export const arcErc8004FeedbackInputSchema = walletSelectionSchema.extend({
  agentId: erc8004AgentIdSchema,
  value: z
    .string()
    .trim()
    .regex(/^-?(?:0|[1-9]\d*)$/, "Expected a canonical signed integer")
    .refine((value) => {
      const parsed = BigInt(value);
      return parsed >= -reputationMaxAbsValue && parsed <= reputationMaxAbsValue;
    }, "Feedback value exceeds deployed ERC-8004 bounds"),
  valueDecimals: z.number().int().min(0).max(18),
  tag1: erc8004TagSchema,
  tag2: erc8004TagSchema,
  endpoint: optionalSafeUriSchema,
  feedbackURI: optionalSafeUriSchema,
  feedbackHash: erc8004Bytes32Schema,
  evidenceId: z.string().trim().min(1).max(256).refine(
    (value) => !secretPattern.test(value),
    "Evidence id must not contain secrets",
  ),
}).strict();

export const arcErc8004ValidationRequestInputSchema = walletSelectionSchema.extend({
  agentId: erc8004AgentIdSchema,
  validatorAddress: z.string().trim().regex(evmAddressPattern),
  requestURI: erc8004SafeUriSchema,
  requestHash: erc8004Bytes32Schema,
}).strict();

export const arcErc8004ValidationResponseInputSchema = walletSelectionSchema.extend({
  requestHash: erc8004Bytes32Schema,
  response: z.number().int().min(0).max(100),
  responseURI: erc8004SafeUriSchema,
  responseHash: erc8004Bytes32Schema,
  tag: erc8004TagSchema,
}).strict();

export const arcErc8004TrustInputSchema = z.object({
  agentId: erc8004AgentIdSchema,
  trustedClientAddresses: z.array(z.string().trim().regex(evmAddressPattern)).min(1).max(100),
  trustedValidatorAddresses: z.array(z.string().trim().regex(evmAddressPattern)).min(1).max(100),
  reputationTag1: erc8004TagSchema.default(""),
  reputationTag2: erc8004TagSchema.default(""),
  validationTag: erc8004TagSchema.default(""),
}).strict();

export type ArcErc8004RegistrationInput = z.input<typeof arcErc8004RegistrationInputSchema>;
export type ArcErc8004IdentityInput = z.input<typeof arcErc8004IdentityInputSchema>;
export type ArcErc8004FeedbackInput = z.input<typeof arcErc8004FeedbackInputSchema>;
export type ArcErc8004ValidationRequestInput =
  z.input<typeof arcErc8004ValidationRequestInputSchema>;
export type ArcErc8004ValidationResponseInput =
  z.input<typeof arcErc8004ValidationResponseInputSchema>;
export type ArcErc8004TrustInput = z.input<typeof arcErc8004TrustInputSchema>;

const strictHttpsUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
    !url.hostname.endsWith(".example") &&
    !url.hostname.endsWith(".invalid");
}, "must be a public production HTTPS URL");

const webServiceSchema = z.object({
  name: z.literal("web"),
  endpoint: z.literal("https://www.agentpay.site/"),
}).strict();
const mcpServiceSchema = z.object({
  name: z.literal("MCP"),
  endpoint: z.literal("https://mcp.agentpay.site/celo/mcp"),
  version: z.literal("2025-06-18"),
}).strict();
const walletServiceSchema = z.object({
  name: z.literal("wallet"),
  endpoint: z.string().regex(walletEndpointPattern),
}).strict();

export const agentPayErc8004RegistrationSchema = z.object({
  type: z.literal(registrationType),
  name: z.literal("AgentPay"),
  description: z.literal(agentPayDescription),
  image: strictHttpsUrl.pipe(z.literal(agentPayImage)),
  services: z.tuple([webServiceSchema, mcpServiceSchema, walletServiceSchema]),
  x402Support: z.literal(true),
  active: z.literal(true),
  registrations: z.array(z.object({
    agentId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    agentRegistry: z.literal(CELO_MAINNET_AGENT_REGISTRY),
  }).strict()).max(1),
}).strict();

export type AgentPayErc8004Registration = z.infer<typeof agentPayErc8004RegistrationSchema>;

export interface CreateAgentPayErc8004RegistrationInput {
  agentWalletAddress: string;
  agentId?: number;
}

export function createAgentPayErc8004Registration(
  input: CreateAgentPayErc8004RegistrationInput,
): AgentPayErc8004Registration {
  const wallet = input.agentWalletAddress;
  if (!evmAddressPattern.test(wallet) || wallet.toLowerCase() === zeroAddress) {
    throw new Error("AgentPay ERC-8004 agent wallet must be a non-zero EVM address.");
  }
  if (
    input.agentId !== undefined &&
    (!Number.isSafeInteger(input.agentId) || input.agentId < 0)
  ) {
    throw new Error("AgentPay ERC-8004 agent id must be a non-negative safe integer.");
  }

  const metadata = agentPayErc8004RegistrationSchema.parse({
    type: registrationType,
    name: "AgentPay",
    description: agentPayDescription,
    image: agentPayImage,
    services: [
      { name: "web", endpoint: "https://www.agentpay.site/" },
      { name: "MCP", endpoint: "https://mcp.agentpay.site/celo/mcp", version: "2025-06-18" },
      { name: "wallet", endpoint: `eip155:42220:${wallet.toLowerCase()}` },
    ],
    x402Support: true,
    active: true,
    registrations: input.agentId === undefined
      ? []
      : [{ agentId: input.agentId, agentRegistry: CELO_MAINNET_AGENT_REGISTRY }],
  });

  return deepFreeze(metadata);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
