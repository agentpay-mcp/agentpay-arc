const addressSchema = { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } as const;
const amountSchema = {
  type: "string",
  pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$",
} as const;

export const getUnifiedBalanceTool = {
  name: "get_unified_balance",
  description: "Read canonical Arc USDC and separate confirmed/pending Circle Gateway balances.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { walletAddress: addressSchema },
  },
} as const;

export const fundFromAnyChainTool = {
  name: "fund_from_any_chain",
  description: "Quote USDC funding into Arc from an App Kit-supported source chain without taking custody.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceChain", "sourceAddress", "walletAddress", "amount"],
    properties: {
      sourceChain: { type: "string" },
      sourceAddress: addressSchema,
      walletAddress: addressSchema,
      amount: amountSchema,
    },
  },
} as const;

export const bridgeUsdcTool = {
  name: "bridge_usdc",
  description: "Quote then bridge USDC from the Arc Agent Wallet using Circle CLI.",
  inputSchema: liquidityMutationJsonSchema(
    ["destinationChain", "recipient", "amount", "minimumReceive"],
  ),
} as const;

export const swapTokensTool = {
  name: "swap_tokens",
  description: "Quote then swap Arc USDC and EURC using Circle CLI with protected minimum receive.",
  inputSchema: liquidityMutationJsonSchema(
    ["sellToken", "buyToken", "sellAmount", "minimumReceive"],
  ),
} as const;

export const swapAndPayTool = {
  name: "swap_and_pay",
  description: "Swap into USDC and pay only after authoritative mined settlement proof meets the minimum.",
  inputSchema: liquidityMutationJsonSchema([
    "sellToken",
    "buyToken",
    "sellAmount",
    "minimumReceive",
    "payment",
  ]),
} as const;

function liquidityMutationJsonSchema(required: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["idempotencyKey", "slippageBps", ...required],
    properties: {
      idempotencyKey: { type: "string", format: "uuid" },
      walletAddress: addressSchema,
      destinationChain: { type: "string" },
      recipient: addressSchema,
      amount: amountSchema,
      token: { type: "string", const: "USDC", default: "USDC" },
      sellToken: { type: "string", enum: ["USDC", "EURC"] },
      buyToken: { type: "string", enum: ["USDC", "EURC"] },
      sellAmount: amountSchema,
      minimumReceive: amountSchema,
      slippageBps: { type: "integer", minimum: 0, maximum: 1_000 },
      payment: {
        type: "object",
        additionalProperties: false,
        required: ["recipient", "minimumAmount", "purpose"],
        properties: {
          recipient: addressSchema,
          minimumAmount: amountSchema,
          purpose: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
  } as const;
}
