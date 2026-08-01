import { SupabaseClient } from "@supabase/supabase-js";
import {
  ARC_AUTONOMY_CONSENT_VERSION,
  ArcHostedAccount,
  ArcHostedAccountSchema,
  ArcHostedAccountStatus,
  ArcHostedAuthority,
  ArcHostedAuthoritySchema,
  ArcHostedCapabilitySchema,
  ArcWalletProvisioningState,
  type ArcHostedCapability,
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

  getPrivateWalletBinding(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    circleWalletSetId: string | null;
    circleWalletId: string | null;
    walletAddress: string | null;
    provisioningState: ArcWalletProvisioningState;
  } | null>;
}

import { z } from "zod";

const UuidSchema = z.string().uuid("Invalid authUserId format: must be a valid UUID");
const WalletAddressSchema = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid walletAddress format: must be 0x-prefixed 40-character hex string");
const BoundedIdentifierSchema = z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/, "Invalid Circle ID format");
const BoundedErrorCodeSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, "Invalid errorCode format");

/**
 * Validated rather than trusted: an unrecognised capability string reaching the
 * enforcement layer would be compared against a known set and silently treated
 * as "not granted", which reads as a working check while hiding a broken one.
 * Failing the parse makes that state loud.
 */
const ArcHostedClientGrantRowSchema = z.object({
  capabilities: z.array(ArcHostedCapabilitySchema),
  auth_epoch: z.number().int().min(0),
  revoked_at: z.string().nullable().optional(),
  consent_version: z.string().trim().min(1),
});

const TenantJoinSchema = z.object({
  id: UuidSchema,
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
      .select("*, tenants!inner(id, status, auth_epoch)")
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
    if (tenantInfo.id !== validatedAccount.tenant_id) {
      throw new Error("Returned tenantId mismatch in resolveHostedAuthority");
    }
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
      capabilities: await this.resolveClientCapabilities(
        validUserId,
        validOAuthClientId,
        authEpoch,
        validatedAccount.consent_version,
      ),
    });
  }

  /**
   * What this client may do, resolved on every authority refresh so a
   * revocation takes effect on the next call rather than the next session.
   *
   * `payment:send` is returned only for an explicit, live, current-epoch grant
   * made under the consent wording in force. Every other path degrades to
   * `wallet:read`, so a client that lost its payment grant can still show the
   * user their own balance rather than appearing broken. A request carrying no
   * client id cannot be attributed to any grant, so it gets nothing.
   */
  private async resolveClientCapabilities(
    authUserId: string,
    oauthClientId: string | undefined,
    authEpoch: number,
    accountConsentVersion: string,
  ): Promise<ArcHostedCapability[]> {
    // No client id means the call cannot be attributed to a grant, so it
    // carries none -- not even read.
    if (!oauthClientId) {
      return [];
    }

    const { data, error } = await this.supabaseClient
      .from("arc_hosted_client_grants")
      .select("capabilities, auth_epoch, revoked_at, consent_version")
      .eq("auth_user_id", authUserId)
      .eq("oauth_client_id", oauthClientId)
      .is("revoked_at", null)
      .maybeSingle();

    if (error) {
      // Never fall through to a permissive default: a database that cannot be
      // read is not a database that granted anything.
      throw formatRepositoryError("Failed to resolve hosted client grant", error);
    }

    // An authenticated client with no grant may read the account it was
    // authorised for, and nothing more. Reading is not the threat this guards
    // against; spending is, and that needs an explicit row.
    if (!data) {
      return ["wallet:read"];
    }

    const grant = ArcHostedClientGrantRowSchema.parse(data);

    // A grant given under older consent wording is not evidence of agreement to
    // the wording in force now. Drop to read rather than to nothing, so stale
    // consent degrades the client instead of locking the user out of their own
    // balance.
    if (grant.consent_version !== accountConsentVersion) {
      return ["wallet:read"];
    }

    // Credential rotation bumps the tenant epoch, retiring grants issued
    // against the old one without having to find and delete each row.
    if (grant.auth_epoch !== authEpoch) {
      return ["wallet:read"];
    }

    return grant.capabilities;
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

  async getPrivateWalletBinding(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    circleWalletSetId: string | null;
    circleWalletId: string | null;
    walletAddress: string | null;
    provisioningState: ArcWalletProvisioningState;
  } | null> {
    const validUserId = UuidSchema.parse(authUserId);
    const { data, error } = await this.supabaseClient
      .from("arc_circle_wallet_bindings")
      .select("auth_user_id, tenant_id, circle_wallet_set_id, circle_wallet_id, wallet_address, provisioning_state")
      .eq("auth_user_id", validUserId)
      .maybeSingle();

    if (error) {
      throw formatRepositoryError("Failed to read private wallet binding", error);
    }

    if (!data) {
      return null;
    }

    return {
      authUserId: data.auth_user_id,
      tenantId: data.tenant_id,
      circleWalletSetId: data.circle_wallet_set_id ?? null,
      circleWalletId: data.circle_wallet_id ?? null,
      walletAddress: data.wallet_address ?? null,
      provisioningState: data.provisioning_state as ArcWalletProvisioningState,
    };
  }
}
