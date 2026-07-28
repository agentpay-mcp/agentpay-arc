import { z } from "zod";

export const ARC_HOSTED_CHAIN = "ARC-TESTNET" as const;
export const ARC_HOSTED_ACCOUNT_TYPE = "SCA" as const;
export const ARC_HOSTED_CUSTODY_TYPE = "DEVELOPER" as const;
export const ARC_AUTONOMY_CONSENT_VERSION = "arc-hosted-autonomy-v1" as const;

export const ArcEvmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid 40-character 0x EVM hex address")
  .transform((val) => val.toLowerCase());

export const ArcOptionalEvmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid 40-character 0x EVM hex address")
  .transform((val) => val.toLowerCase())
  .optional();

export const ArcHostedAccountStatusSchema = z.enum(["ACTIVE", "PAUSED", "CLOSED"]);
export type ArcHostedAccountStatus = z.infer<typeof ArcHostedAccountStatusSchema>;

export const ArcWalletProvisioningStateSchema = z.enum([
  "PENDING",
  "PROVISIONING",
  "LIVE",
  "FAILED",
  "CLOSED",
]);
export type ArcWalletProvisioningState = z.infer<typeof ArcWalletProvisioningStateSchema>;

export const ArcHostedAuthoritySchema = z.object({
  authUserId: z.string().uuid(),
  tenantId: z.string().uuid(),
  walletAddress: ArcEvmAddressSchema,
  accountStatus: ArcHostedAccountStatusSchema,
  oauthClientId: z.string().trim().optional(),
});
export type ArcHostedAuthority = z.infer<typeof ArcHostedAuthoritySchema>;

export const ArcHostedAccountSchema = z.object({
  authUserId: z.string().uuid(),
  tenantId: z.string().uuid(),
  accountStatus: ArcHostedAccountStatusSchema,
  consentVersion: z.literal(ARC_AUTONOMY_CONSENT_VERSION),
  consentTimestamp: z.string().datetime(),
  walletAddress: ArcOptionalEvmAddressSchema,
  walletStatus: ArcWalletProvisioningStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ArcHostedAccount = z.infer<typeof ArcHostedAccountSchema>;
