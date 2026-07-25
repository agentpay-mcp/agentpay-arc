import {
  checkWalletCreationInputSchema,
  getAgentWalletInputSchema,
  getChainName,
  MAINNET_ONBOARDING_URL,
  prepareWalletCreationInputSchema,
  resolveCeloHomeChainId,
  type CeloHomeChainId,
  type CheckWalletCreationInput,
  type GetAgentWalletInput,
  type PrepareWalletCreationInput,
  type SetupIntentRecord,
} from "@agentpay-ai/shared-arc";

import type { AgentWalletRepository } from "./prepare-payment.ts";

export interface SetupIntentRepository {
  createSetupIntent(intent: SetupIntentRecord): Promise<void>;
  getSetupIntent(setupIntentId: string): Promise<SetupIntentRecord | null>;
}

export interface PrepareWalletCreationDependencies {
  setupIntents: SetupIntentRepository;
  executorAddress: string;
  setupWebUrl: string;
  productionOnboardingUrl?: string;
  clock: () => Date;
  createSetupIntentId: () => string;
  homeChainId?: CeloHomeChainId;
  setupTtlSeconds?: number;
}

export interface CheckWalletCreationDependencies {
  setupIntents: Pick<SetupIntentRepository, "getSetupIntent">;
  clock: () => Date;
}

export interface GetAgentWalletDependencies {
  wallets: AgentWalletRepository;
  homeChainId?: CeloHomeChainId;
}

export interface LegacyPrepareWalletCreationOutput {
  setupIntentId: string;
  status: "PENDING";
  setupUrl: string;
  messageToSign: string;
  expiresAt: string;
  homeChainId: number;
  homeChain: string;
}

export interface ProductionPrepareWalletCreationOutput {
  status: "SETUP_REQUIRED";
  setupUrl: typeof MAINNET_ONBOARDING_URL;
  homeChainId: 42220;
  homeChain: "Celo";
  instructionToAgent: string;
}

export type PrepareWalletCreationOutput =
  | LegacyPrepareWalletCreationOutput
  | ProductionPrepareWalletCreationOutput;

export interface CheckWalletCreationOutput {
  setupIntentId: string;
  status: SetupIntentRecord["status"];
  ownerAddress?: string;
  accountAddress?: string;
  completedAt?: string;
  expiresAt: string;
  homeChainId?: number;
  homeChain?: string;
}

export interface GetAgentWalletOutput {
  status: "ACTIVE" | "NOT_CREATED";
  wallet: {
    ownerAddress: string;
    accountAddress: string;
    homeChainId: number;
    homeChain: string;
    executorAddress: string;
  } | null;
}

export async function prepareWalletCreation(
  rawInput: PrepareWalletCreationInput,
  dependencies: PrepareWalletCreationDependencies,
): Promise<PrepareWalletCreationOutput> {
  const input = prepareWalletCreationInputSchema.parse(rawInput);
  if (dependencies.productionOnboardingUrl !== undefined) {
    const homeChainId = resolveCeloHomeChainId(input, 42220);
    if (homeChainId !== 42220) {
      throw new Error("Production wallet onboarding is available only on Celo mainnet.");
    }
    if (dependencies.productionOnboardingUrl !== MAINNET_ONBOARDING_URL) {
      throw new Error("Production onboarding URL must match the canonical AgentPay Celo setup URL.");
    }
    return {
      status: "SETUP_REQUIRED",
      setupUrl: MAINNET_ONBOARDING_URL,
      homeChainId,
      homeChain: "Celo",
      instructionToAgent:
        "Open the secure AgentPay setup link, connect the owner wallet, and approve the setup signature. Never share a seed phrase or private key.",
    };
  }
  const setupIntentId = dependencies.createSetupIntentId();
  const setupTtlSeconds = dependencies.setupTtlSeconds ?? 900;
  const expiresAt = new Date(dependencies.clock().getTime() + setupTtlSeconds * 1000).toISOString();
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const messageToSign = createSetupMessage({
    setupIntentId,
    ownerAddress: input.ownerAddress,
    executorAddress: dependencies.executorAddress,
    homeChainId,
    expiresAt,
  });

  await dependencies.setupIntents.createSetupIntent({
    id: setupIntentId,
    ownerAddress: input.ownerAddress,
    executorAddress: dependencies.executorAddress,
    messageToSign,
    status: "PENDING",
    expiresAt,
    homeChainId,
  });

  return {
    setupIntentId,
    status: "PENDING",
    setupUrl: createSetupUrl(dependencies.setupWebUrl, setupIntentId),
    messageToSign,
    expiresAt,
    homeChainId,
    homeChain: getChainName(homeChainId),
  };
}

export async function checkWalletCreation(
  rawInput: CheckWalletCreationInput,
  dependencies: CheckWalletCreationDependencies,
): Promise<CheckWalletCreationOutput> {
  const input = checkWalletCreationInputSchema.parse(rawInput);
  const intent = await dependencies.setupIntents.getSetupIntent(input.setupIntentId);

  if (!intent) {
    throw new Error(`Setup intent ${input.setupIntentId} was not found.`);
  }

  return {
    setupIntentId: intent.id,
    status: isExpiredPendingIntent(intent, dependencies.clock()) ? "EXPIRED" : intent.status,
    ownerAddress: intent.ownerAddress,
    accountAddress: intent.accountAddress,
    completedAt: intent.completedAt,
    expiresAt: intent.expiresAt,
    homeChainId: intent.homeChainId,
    homeChain: intent.homeChainId ? getChainName(intent.homeChainId) : undefined,
  };
}

export async function getAgentWallet(
  rawInput: GetAgentWalletInput,
  dependencies: GetAgentWalletDependencies,
): Promise<GetAgentWalletOutput> {
  const input = getAgentWalletInputSchema.parse(rawInput);
  const homeChainId = resolveCeloHomeChainId(input, dependencies.homeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet) {
    return {
      status: "NOT_CREATED",
      wallet: null,
    };
  }

  return {
    status: "ACTIVE",
    wallet: {
      ownerAddress: wallet.ownerAddress,
      accountAddress: wallet.accountAddress,
      homeChainId: wallet.homeChainId,
      homeChain: getChainName(wallet.homeChainId),
      executorAddress: wallet.executorAddress,
    },
  };
}

export const prepareWalletCreationTool = {
  name: "prepare_wallet_creation",
  description: "Start AgentPay wallet setup and return the secure owner-signing handoff.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ownerAddress: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export const checkWalletCreationTool = {
  name: "check_wallet_creation",
  description: "Check whether an AgentPay wallet setup intent has completed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["setupIntentId"],
    properties: {
      setupIntentId: { type: "string" },
    },
  },
} as const;

export const getAgentWalletTool = {
  name: "get_agent_wallet",
  description: "Return the active AgentPay smart account wallet if one exists.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [42220, 11142220] },
    },
  },
} as const;

export function createPrepareWalletCreationHandler(dependencies: PrepareWalletCreationDependencies) {
  return (input: PrepareWalletCreationInput) => prepareWalletCreation(input, dependencies);
}

export function createCheckWalletCreationHandler(dependencies: CheckWalletCreationDependencies) {
  return (input: CheckWalletCreationInput) => checkWalletCreation(input, dependencies);
}

export function createGetAgentWalletHandler(dependencies: GetAgentWalletDependencies) {
  return (input: GetAgentWalletInput) => getAgentWallet(input, dependencies);
}

function createSetupMessage(input: {
  setupIntentId: string;
  ownerAddress?: string;
  executorAddress: string;
  homeChainId: number;
  expiresAt: string;
}): string {
  return [
    "Create AgentPay wallet",
    `Setup ID: ${input.setupIntentId}`,
    `Owner: ${input.ownerAddress ?? "connected signing wallet"}`,
    `Executor: ${input.executorAddress}`,
    `Chain: ${getChainName(input.homeChainId)}`,
    `Expires: ${input.expiresAt}`,
    "This signature proves wallet ownership only. It does not approve a payment or token transfer.",
  ].join("\n");
}

function createSetupUrl(setupWebUrl: string, setupIntentId: string): string {
  const url = new URL(setupWebUrl);
  url.searchParams.set("setup_intent_id", setupIntentId);
  return url.toString();
}

function isExpiredPendingIntent(intent: SetupIntentRecord, now: Date): boolean {
  return ["PENDING", "SIGNED", "DEPLOYING"].includes(intent.status) && new Date(intent.expiresAt).getTime() <= now.getTime();
}
