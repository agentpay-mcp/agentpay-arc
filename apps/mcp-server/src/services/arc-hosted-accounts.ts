import { SupabaseClient } from "@supabase/supabase-js";
import {
  ARC_AUTONOMY_CONSENT_VERSION,
  ArcHostedAccount,
  ArcHostedAccountSchema,
  ArcHostedAccountStatus,
  ArcHostedAuthority,
  ArcHostedAuthoritySchema,
  ArcWalletProvisioningState,
} from "@agentpay-ai/shared-arc";

export interface ArcHostedAccountRepository {
  claimHostedAccount(input: {
    authUserId: string;
    consentVersion?: typeof ARC_AUTONOMY_CONSENT_VERSION;
  }): Promise<ArcHostedAccount>;

  getHostedAccount(authUserId: string): Promise<ArcHostedAccount | null>;

  resolveHostedAuthority(input: {
    authUserId: string;
    oauthClientId?: string;
  }): Promise<ArcHostedAuthority | null>;

  claimProvisioningJob(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    provisioningIdempotencyKey: string;
    fencingToken: string;
    provisioningState: ArcWalletProvisioningState;
  } | null>;

  completeProvisioning(input: {
    authUserId: string;
    fencingToken: string;
    circleWalletSetId: string;
    circleWalletId: string;
    walletAddress: string;
  }): Promise<void>;

  failProvisioning(input: {
    authUserId: string;
    fencingToken: string;
    errorCode: string;
  }): Promise<void>;

  setAccountStatus(input: {
    authUserId: string;
    status: ArcHostedAccountStatus;
  }): Promise<void>;
}

import { z } from "zod";

const UuidSchema = z.string().uuid("Invalid authUserId format: must be a valid UUID");
const WalletAddressSchema = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid walletAddress format: must be 0x-prefixed 40-character hex string");
const BoundedIdentifierSchema = z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/, "Invalid Circle ID format");
const BoundedErrorCodeSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, "Invalid errorCode format");

const TenantJoinSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
  auth_epoch: z.number().int().nonnegative(),
});

const ClaimHostedAccountRpcRowSchema = z.object({
  auth_user_id: UuidSchema,
  tenant_id: UuidSchema,
  account_status: z.enum(["ACTIVE", "PAUSED", "CLOSED"]),
  consent_version: z.literal(ARC_AUTONOMY_CONSENT_VERSION),
  consent_timestamp: z.string().or(z.date()),
  wallet_address: WalletAddressSchema.optional().nullable(),
  wallet_status: z.enum(["PENDING", "PROVISIONING", "LIVE", "FAILED", "CLOSED"]),
  created_at: z.string().or(z.date()),
  updated_at: z.string().or(z.date()),
});

const ClaimProvisioningJobRpcRowSchema = z.object({
  auth_user_id: UuidSchema,
  tenant_id: UuidSchema,
  provisioning_idempotency_key: UuidSchema,
  fencing_token: UuidSchema,
  provisioning_state: z.literal("PROVISIONING"),
});

function safeIsoDate(val: string | Date, context: string): string {
  const d = typeof val === "string" ? new Date(val) : val;
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    throw new Error(`Invalid ISO timestamp format in ${context}`);
  }
  return d.toISOString();
}

function formatRepositoryError(context: string, error: { message: string }): Error {
  const msg = error.message;
  // Map expected PL/pgSQL exceptions to clean application errors
  if (msg.includes("Stale or invalid fencing token")) {
    return new Error(`${context}: Stale or invalid fencing token`);
  }
  if (msg.includes("Cannot fail provisioning")) {
    return new Error(`${context}: Cannot fail provisioning from current state`);
  }
  if (msg.includes("Cannot complete provisioning")) {
    return new Error(`${context}: Cannot complete provisioning from current state`);
  }
  if (msg.includes("Cannot re-complete LIVE provisioning")) {
    return new Error(`${context}: Cannot re-complete LIVE provisioning with conflicting parameters`);
  }
  if (msg.includes("Hosted account not found")) {
    return new Error(`${context}: Hosted account not found`);
  }
  if (msg.includes("Cannot transition closed account")) {
    return new Error(`${context}: Cannot transition closed account`);
  }
  if (msg.includes("Invalid account status")) {
    return new Error(`${context}: Invalid account status`);
  }
  if (msg.includes("Invalid consent version")) {
    return new Error(`${context}: Invalid consent version`);
  }
  if (msg.includes("Binding record not found")) {
    return new Error(`${context}: Binding record not found`);
  }
  return new Error(`${context}: Database request failed`);
}

export class ArcHostedAccountRepositoryImpl implements ArcHostedAccountRepository {
  private readonly supabaseClient: SupabaseClient;

  constructor(supabaseClient: SupabaseClient) {
    this.supabaseClient = supabaseClient;
  }

  async claimHostedAccount(input: {
    authUserId: string;
    consentVersion?: typeof ARC_AUTONOMY_CONSENT_VERSION;
  }): Promise<ArcHostedAccount> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const consentVersion = z
      .literal(ARC_AUTONOMY_CONSENT_VERSION)
      .parse(input.consentVersion ?? ARC_AUTONOMY_CONSENT_VERSION);

    const { data, error } = await this.supabaseClient.rpc("arc_claim_hosted_account", {
      p_auth_user_id: validUserId,
      p_consent_version: consentVersion,
    });

    if (error) {
      throw formatRepositoryError("Failed to claim hosted account", error);
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error("Failed to claim hosted account: Empty RPC result");
    }

    const validatedRow = ClaimHostedAccountRpcRowSchema.parse(data[0]);

    if (validatedRow.auth_user_id !== validUserId) {
      throw new Error("Returned authUserId mismatch in claimHostedAccount");
    }

    return ArcHostedAccountSchema.parse({
      authUserId: validatedRow.auth_user_id,
      tenantId: validatedRow.tenant_id,
      accountStatus: validatedRow.account_status,
      consentVersion: validatedRow.consent_version,
      consentTimestamp: safeIsoDate(validatedRow.consent_timestamp, "consentTimestamp"),
      walletAddress: validatedRow.wallet_address ?? undefined,
      walletStatus: validatedRow.wallet_status,
      createdAt: safeIsoDate(validatedRow.created_at, "createdAt"),
      updatedAt: safeIsoDate(validatedRow.updated_at, "updatedAt"),
    });
  }

  async getHostedAccount(authUserId: string): Promise<ArcHostedAccount | null> {
    const validUserId = UuidSchema.parse(authUserId);
    const { data, error } = await this.supabaseClient
      .from("arc_hosted_accounts")
      .select("*")
      .eq("auth_user_id", validUserId)
      .maybeSingle();

    if (error) {
      throw formatRepositoryError("Failed to read hosted account", error);
    }

    if (!data) {
      return null;
    }

    const validatedRow = ClaimHostedAccountRpcRowSchema.parse(data);

    if (validatedRow.auth_user_id !== validUserId) {
      throw new Error("Returned authUserId mismatch in getHostedAccount");
    }

    return ArcHostedAccountSchema.parse({
      authUserId: validatedRow.auth_user_id,
      tenantId: validatedRow.tenant_id,
      accountStatus: validatedRow.account_status,
      consentVersion: validatedRow.consent_version,
      consentTimestamp: safeIsoDate(validatedRow.consent_timestamp, "consentTimestamp"),
      walletAddress: validatedRow.wallet_address ?? undefined,
      walletStatus: validatedRow.wallet_status,
      createdAt: safeIsoDate(validatedRow.created_at, "createdAt"),
      updatedAt: safeIsoDate(validatedRow.updated_at, "updatedAt"),
    });
  }

  async resolveHostedAuthority(input: {
    authUserId: string;
    oauthClientId?: string;
  }): Promise<ArcHostedAuthority | null> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validOAuthClientId = input.oauthClientId
      ? BoundedIdentifierSchema.parse(input.oauthClientId)
      : undefined;

    // Join arc_hosted_accounts with tenants to ensure both account and tenant are ACTIVE and retrieve tenant auth_epoch
    const { data, error } = await this.supabaseClient
      .from("arc_hosted_accounts")
      .select("*, tenants!inner(status, auth_epoch)")
      .eq("auth_user_id", validUserId)
      .maybeSingle();

    if (error) {
      throw formatRepositoryError("Failed to resolve hosted authority", error);
    }

    if (!data) {
      return null;
    }

    const validatedAccount = ClaimHostedAccountRpcRowSchema.parse(data);

    if (validatedAccount.auth_user_id !== validUserId) {
      throw new Error("Returned authUserId mismatch in resolveHostedAuthority");
    }

    const tenantInfo = TenantJoinSchema.parse((data as any).tenants);
    const tenantStatus = tenantInfo.status;
    const authEpoch = tenantInfo.auth_epoch;

    if (
      validatedAccount.account_status !== "ACTIVE" ||
      tenantStatus !== "ACTIVE" ||
      validatedAccount.wallet_status !== "LIVE" ||
      !validatedAccount.wallet_address
    ) {
      return null;
    }

    return ArcHostedAuthoritySchema.parse({
      authUserId: validatedAccount.auth_user_id,
      tenantId: validatedAccount.tenant_id,
      walletAddress: validatedAccount.wallet_address,
      accountStatus: validatedAccount.account_status,
      authEpoch,
      oauthClientId: validOAuthClientId,
    });
  }

  async claimProvisioningJob(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    provisioningIdempotencyKey: string;
    fencingToken: string;
    provisioningState: ArcWalletProvisioningState;
  } | null> {
    const validUserId = UuidSchema.parse(authUserId);

    const { data, error } = await this.supabaseClient.rpc("arc_claim_provisioning_job", {
      p_auth_user_id: validUserId,
    });

    if (error) {
      throw formatRepositoryError("Failed to claim provisioning job", error);
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      return null;
    }

    const validatedRow = ClaimProvisioningJobRpcRowSchema.parse(data[0]);

    if (validatedRow.auth_user_id !== validUserId) {
      throw new Error("Returned authUserId mismatch in claimProvisioningJob");
    }

    return {
      authUserId: validatedRow.auth_user_id,
      tenantId: validatedRow.tenant_id,
      provisioningIdempotencyKey: validatedRow.provisioning_idempotency_key,
      fencingToken: validatedRow.fencing_token,
      provisioningState: validatedRow.provisioning_state,
    };
  }

  async completeProvisioning(input: {
    authUserId: string;
    fencingToken: string;
    circleWalletSetId: string;
    circleWalletId: string;
    walletAddress: string;
  }): Promise<void> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validFencingToken = UuidSchema.parse(input.fencingToken);
    const validWalletSetId = BoundedIdentifierSchema.parse(input.circleWalletSetId);
    const validWalletId = BoundedIdentifierSchema.parse(input.circleWalletId);
    const validAddress = WalletAddressSchema.parse(input.walletAddress);

    const { error } = await this.supabaseClient.rpc("arc_complete_provisioning", {
      p_auth_user_id: validUserId,
      p_fencing_token: validFencingToken,
      p_circle_wallet_set_id: validWalletSetId,
      p_circle_wallet_id: validWalletId,
      p_wallet_address: validAddress,
    });

    if (error) {
      throw formatRepositoryError("Failed to complete provisioning", error);
    }
  }

  async failProvisioning(input: {
    authUserId: string;
    fencingToken: string;
    errorCode: string;
  }): Promise<void> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validFencingToken = UuidSchema.parse(input.fencingToken);
    const validErrorCode = BoundedErrorCodeSchema.parse(input.errorCode);

    const { error } = await this.supabaseClient.rpc("arc_fail_provisioning", {
      p_auth_user_id: validUserId,
      p_fencing_token: validFencingToken,
      p_error_code: validErrorCode,
    });

    if (error) {
      throw formatRepositoryError("Failed to record provisioning failure", error);
    }
  }

  async setAccountStatus(input: {
    authUserId: string;
    status: ArcHostedAccountStatus;
  }): Promise<void> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validStatus = z.enum(["ACTIVE", "PAUSED", "CLOSED"]).parse(input.status);

    const { error } = await this.supabaseClient.rpc("arc_set_account_status", {
      p_auth_user_id: validUserId,
      p_status: validStatus,
    });

    if (error) {
      throw formatRepositoryError("Failed to set account status", error);
    }
  }
}
