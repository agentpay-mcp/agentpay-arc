import { z } from "zod";

export const CIRCLE_ARC_CHAIN = "ARC-TESTNET" as const;

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/;
const privateKeyPattern = /(?:^|[^a-fA-F0-9])0x[a-fA-F0-9]{64}(?:$|[^a-fA-F0-9])/;
const bareMnemonicPattern =
  /^(?:[a-z]+\s+){11}[a-z]+(?:\s+(?:[a-z]+\s+){11}[a-z]+)?$/i;
const sensitiveLabelPattern =
  /\b(?:api[_ -]?key|authorization|client[_ -]?secret|cookie|mnemonic|one[_ -]?time[_ -]?(?:code|password)|otp|password|private[_ -]?key|seed(?:[_ -]?phrase)?|session[_ -]?token|token)\b["']?\s*[:=]|\bbearer\s+\S+/i;
const forbiddenHeaderPattern =
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-circle-api-key)$/i;

export const circleAddressSchema = z
  .string()
  .trim()
  .regex(evmAddressPattern, "Expected an EVM address, not a private key");
export const circleAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected a non-negative decimal amount");
export const circlePositiveAmountSchema = circleAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  "Expected a positive decimal amount",
);
export const circleChainSchema = z.literal(CIRCLE_ARC_CHAIN);
export const circleIdempotencyKeySchema = z.string().uuid();

const safeCliTextSchema = (label: string, maxLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .superRefine((value, context) => {
      if (value.includes("\0")) {
        context.addIssue({
          code: "custom",
          message: `${label} contains a forbidden null byte`,
        });
      }
      if (privateKeyPattern.test(value)) {
        context.addIssue({
          code: "custom",
          message: `${label} must not contain a private key`,
        });
      }
      if (bareMnemonicPattern.test(value)) {
        context.addIssue({
          code: "custom",
          message: `${label} must not contain a mnemonic or seed phrase`,
        });
      }
      if (sensitiveLabelPattern.test(value)) {
        context.addIssue({
          code: "custom",
          message: `${label} must not contain secrets, OTP, mnemonic, or seed material`,
        });
      }
    });

export const circleSafeCliTextSchema = safeCliTextSchema("Circle CLI value", 16_384);

const safePositionalCliTextSchema = (label: string, maxLength: number) =>
  safeCliTextSchema(label, maxLength).refine(
    (value) => !value.startsWith("-"),
    `${label} must not begin with a hyphen or CLI option`,
  );

const circleHeaderValueSchema = safeCliTextSchema("Circle service header", 4_096).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Circle service header must not contain control characters",
);

const circleHttpsUrlSchema = safeCliTextSchema("Circle service URL", 2_048)
  .pipe(z.string().url())
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Circle service URL must use HTTPS",
      });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Circle service URL must not contain credentials",
      });
    }
  });

const circleHeadersSchema = z
  .record(
    z.string().trim().min(1).max(128).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "Invalid HTTP header name"),
    circleHeaderValueSchema,
  )
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (forbiddenHeaderPattern.test(name)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Circle service header must not contain secret credentials",
        });
      }
    }
  });

export const circleSessionNetworkStatusSchema = z.object({
  email: z.string().email().optional(),
  tokenStatus: z.enum(["VALID", "EXPIRED", "NOT_LOGGED_IN"]),
  expiresIn: z.string().trim().min(1).max(64).optional(),
});

export const circleSessionStatusSchema = z.object({
  type: z.literal("agent"),
  mainnet: circleSessionNetworkStatusSchema,
  testnet: circleSessionNetworkStatusSchema,
});
export type CircleSessionStatus = z.output<typeof circleSessionStatusSchema>;

export const circleAgentWalletSchema = z.object({
  address: circleAddressSchema,
  type: z.literal("agent"),
  blockchain: circleChainSchema,
  createDate: z.string().trim().min(1).max(64).optional(),
});
export type CircleAgentWallet = z.output<typeof circleAgentWalletSchema>;

export const circleTokenBalanceSchema = z.object({
  amount: circleAmountSchema,
  token: z.object({
    name: z.string().trim().min(1).max(128),
    symbol: z.string().trim().min(1).max(32),
    blockchain: circleChainSchema,
    decimals: z.number().int().min(0).max(255),
    isNative: z.boolean(),
    tokenAddress: circleAddressSchema.optional(),
  }),
});

export const circleWalletBalanceSchema = z.object({
  balances: z.array(circleTokenBalanceSchema),
});
export type CircleWalletBalance = z.output<typeof circleWalletBalanceSchema>;

export const circleTransactionResultSchema = z.object({
  id: z.string().trim().min(1).max(256),
  state: z.string().trim().min(1).max(64),
  blockchain: circleChainSchema,
  txHash: z.string().regex(transactionHashPattern).optional(),
  sourceAddress: circleAddressSchema.optional(),
  destinationAddress: circleAddressSchema.optional(),
  operation: z.string().trim().min(1).max(64).optional(),
});
export type CircleTransactionResult = z.output<typeof circleTransactionResultSchema>;

export const circleFaucetResultSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  address: circleAddressSchema,
  blockchain: circleChainSchema,
  token: z.string().trim().min(1).max(32),
});
export type CircleFaucetResult = z.output<typeof circleFaucetResultSchema>;

export const circleSwapResultSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  sellToken: z.string().trim().min(1).max(128),
  sellAmount: circlePositiveAmountSchema,
  buyToken: z.string().trim().min(1).max(128),
  buyMin: circlePositiveAmountSchema,
  chain: circleChainSchema,
  transactions: z.array(circleTransactionResultSchema),
});
export type CircleSwapResult = z.output<typeof circleSwapResultSchema>;

export const circleServiceSchema = z.object({
  url: circleHttpsUrlSchema,
  name: z.string().trim().min(1).max(256),
  description: z.string().max(2_048).optional(),
  method: z.string().trim().min(1).max(16).optional(),
});
export type CircleService = z.output<typeof circleServiceSchema>;

export const circleServiceSearchResponseSchema = z
  .object({
    items: z.array(
      z.object({
        resource: circleHttpsUrlSchema,
        metadata: z.object({
          description: z.string().max(2_048).optional(),
          method: z.string().trim().min(1).max(16).optional(),
          provider: z.object({
            name: z.string().trim().min(1).max(256),
          }),
        }),
      }),
    ),
  })
  .transform(({ items }) =>
    items.map((item) => ({
      url: item.resource,
      name: item.metadata.provider.name,
      ...(item.metadata.description === undefined ? {} : { description: item.metadata.description }),
      ...(item.metadata.method === undefined ? {} : { method: item.metadata.method }),
    })),
  );

export const circleServiceQuoteSchema = z.object({
  status: z.enum(["payable", "free", "unavailable"]),
  httpStatus: z.number().int().min(0).max(599),
  url: circleHttpsUrlSchema,
  description: z.string().max(2_048).optional(),
  method: z.string().trim().min(1).max(16).optional(),
  price: z
    .object({
      amount: z.string().trim().regex(/^\d+$/, "Expected atomic USDC amount"),
      formatted: z.string().trim().min(1).max(128),
    })
    .optional(),
  chains: z.array(z.string().trim().min(1).max(128)).optional(),
  scheme: z.string().trim().min(1).max(128).optional(),
  seller: circleAddressSchema.optional(),
});
export type CircleServiceQuote = z.output<typeof circleServiceQuoteSchema>;

export const circleServicePaymentResultSchema = z.object({
  response: z.unknown(),
  payment: z.object({
    amount: z.string().trim().min(1).max(128),
    chain: z
      .enum([CIRCLE_ARC_CHAIN, "Arc Testnet"])
      .transform(() => CIRCLE_ARC_CHAIN),
    scheme: z.string().trim().min(1).max(128),
    seller: circleAddressSchema,
    receipt: z.string().trim().min(1).max(16_384).optional(),
  }),
});
export type CircleServicePaymentResult = z.output<typeof circleServicePaymentResultSchema>;

export const circleGatewayBalanceSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  address: circleAddressSchema,
  backingEOA: circleAddressSchema,
  total: circleAmountSchema,
  token: z.literal("USDC"),
  balances: z.array(
    z.object({
      network: z.string().trim().min(1).max(128),
      domain: z.number().int().nonnegative(),
      balance: circleAmountSchema,
    }),
  ),
});
export type CircleGatewayBalance = z.output<typeof circleGatewayBalanceSchema>;

export const circleGatewayDepositResultSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  method: z.string().trim().min(1).max(64),
  amount: circlePositiveAmountSchema,
  sourceAddress: circleAddressSchema,
  sourceBlockchain: circleChainSchema,
  backingEOA: circleAddressSchema,
  approveTxHash: z.string().regex(transactionHashPattern),
  depositTxHash: z.string().regex(transactionHashPattern),
});
export type CircleGatewayDepositResult = z.output<typeof circleGatewayDepositResultSchema>;

export const circleGatewayWithdrawalResultSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  amount: circlePositiveAmountSchema,
  sourceAddress: circleAddressSchema,
  backingEOA: circleAddressSchema.optional(),
  sourceBlockchain: circleChainSchema,
  destinationBlockchain: circleChainSchema,
  recipient: circleAddressSchema,
  transferId: z.string().trim().min(1).max(256).optional(),
  estimatedFee: z.unknown().optional(),
  chargedFee: z.unknown().optional(),
  mintTxHash: z.string().regex(transactionHashPattern),
});
export type CircleGatewayWithdrawalResult = z.output<typeof circleGatewayWithdrawalResultSchema>;

export const circleBridgeResultSchema = z.object({
  message: z.string().trim().min(1).max(1_024),
  burnTxHash: z.string().regex(transactionHashPattern),
  forwardTxHash: z.string().regex(transactionHashPattern).optional(),
  fromChain: circleChainSchema,
  toChain: z.string().trim().min(1).max(128),
  amount: circlePositiveAmountSchema.optional(),
  status: z.enum(["pending", "complete"]),
  transactions: z.array(circleTransactionResultSchema),
});
export type CircleBridgeResult = z.output<typeof circleBridgeResultSchema>;

export const circleTransferInputSchema = z
  .object({
    recipient: circleAddressSchema,
    amount: circlePositiveAmountSchema,
    address: circleAddressSchema,
  })
  .strict();
export type CircleTransferInput = z.input<typeof circleTransferInputSchema>;

export const circleSwapInputSchema = z
  .object({
    sellToken: safePositionalCliTextSchema("sell token", 128),
    sellAmount: circlePositiveAmountSchema,
    buyToken: safePositionalCliTextSchema("buy token", 128),
    minimumBuy: circleAmountSchema,
    address: circleAddressSchema,
    idempotencyKey: circleIdempotencyKeySchema,
  })
  .strict();
export type CircleSwapInput = z.input<typeof circleSwapInputSchema>;

export const circleContractExecutionInputSchema = z
  .object({
    address: circleAddressSchema,
    contract: circleAddressSchema,
    functionSignature: safeCliTextSchema("contract function signature", 512).regex(
      /^[A-Za-z_][A-Za-z0-9_]*\(.+\)$|^[A-Za-z_][A-Za-z0-9_]*\(\)$/,
      "Expected an ABI function signature",
    ),
    parameters: z.array(safePositionalCliTextSchema("contract parameter", 16_384)).max(64).default([]),
    value: circleAmountSchema.optional(),
  })
  .strict();
export type CircleContractExecutionInput = z.input<typeof circleContractExecutionInputSchema>;

export const circleServiceSearchInputSchema = z
  .object({
    query: safePositionalCliTextSchema("service search query", 512),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type CircleServiceSearchInput = z.input<typeof circleServiceSearchInputSchema>;

export const circleServiceRequestSchema = z
  .object({
    url: circleHttpsUrlSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    headers: circleHeadersSchema.optional(),
    body: safeCliTextSchema("Circle service body", 65_536).optional(),
  })
  .strict();
export type CircleServiceRequest = z.input<typeof circleServiceRequestSchema>;

export const circleServicePaymentInputSchema = circleServiceRequestSchema.extend({
  address: circleAddressSchema,
  maxAmount: circlePositiveAmountSchema,
});
export type CircleServicePaymentInput = z.input<typeof circleServicePaymentInputSchema>;

export const circleGatewayDepositInputSchema = z
  .object({
    amount: circlePositiveAmountSchema,
    address: circleAddressSchema,
  })
  .strict();
export type CircleGatewayDepositInput = z.input<typeof circleGatewayDepositInputSchema>;

export const circleGatewayWithdrawalInputSchema = z
  .object({
    amount: circlePositiveAmountSchema,
    address: circleAddressSchema,
    recipient: circleAddressSchema,
  })
  .strict();
export type CircleGatewayWithdrawalInput = z.input<typeof circleGatewayWithdrawalInputSchema>;

export const circleBridgeInputSchema = z
  .object({
    destination: safePositionalCliTextSchema("bridge destination", 128),
    recipient: circleAddressSchema,
    amount: circlePositiveAmountSchema,
    address: circleAddressSchema,
    idempotencyKey: circleIdempotencyKeySchema,
  })
  .strict();
export type CircleBridgeInput = z.input<typeof circleBridgeInputSchema>;
