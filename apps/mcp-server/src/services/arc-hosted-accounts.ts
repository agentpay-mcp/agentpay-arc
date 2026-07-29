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
    provisioningState: ArcWalletProvisioningState;
  } | null>;

  completeProvisioning(input: {
    authUserId: string;
    circleWalletSetId: string;
    circleWalletId: string;
    walletAddress: string;
  }): Promise<void>;

  failProvisioning(input: {
    authUserId: string;
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

function formatRepositoryError(context: string, error: { message: string }): Error {
  const msg = error.message;
  // Preserve expected business exceptions thrown by PL/pgSQL functions
  if (
    msg.includes("Cannot fail provisioning") ||
    msg.includes("Cannot complete provisioning") ||
    msg.includes("Cannot re-complete LIVE provisioning") ||
    msg.includes("Hosted account not found") ||
    msg.includes("Invalid account status") ||
    msg.includes("Invalid consent version") ||
    msg.includes("Binding record not found")
  ) {
    // Extract PL/pgSQL error message without internal Postgres context
    const cleanMsg = msg.split("\n")[0].replace(/^ERROR:\s*/i, "");
    return new Error(`${context}: ${cleanMsg}`);
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
    const consentVersion = input.consentVersion ?? ARC_AUTONOMY_CONSENT_VERSION;

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

    const row = data[0];
    return ArcHostedAccountSchema.parse({
      authUserId: row.auth_user_id,
      tenantId: row.tenant_id,
      accountStatus: row.account_status,
      consentVersion: row.consent_version,
      consentTimestamp: new Date(row.consent_timestamp).toISOString(),
      walletAddress: row.wallet_address ?? undefined,
      walletStatus: row.wallet_status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
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

    return ArcHostedAccountSchema.parse({
      authUserId: data.auth_user_id,
      tenantId: data.tenant_id,
      accountStatus: data.account_status,
      consentVersion: data.consent_version,
      consentTimestamp: new Date(data.consent_timestamp).toISOString(),
      walletAddress: data.wallet_address ?? undefined,
      walletStatus: data.wallet_status,
      createdAt: new Date(data.created_at).toISOString(),
      updatedAt: new Date(data.updated_at).toISOString(),
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

    const tenantInfo = (data as any).tenants;
    const tenantStatus = tenantInfo?.status;
    const authEpoch = Number(tenantInfo?.auth_epoch ?? 0);

    if (
      data.account_status !== "ACTIVE" ||
      tenantStatus !== "ACTIVE" ||
      data.wallet_status !== "LIVE" ||
      !data.wallet_address
    ) {
      return null;
    }

    return ArcHostedAuthoritySchema.parse({
      authUserId: data.auth_user_id,
      tenantId: data.tenant_id,
      walletAddress: data.wallet_address,
      accountStatus: data.account_status,
      authEpoch,
      oauthClientId: validOAuthClientId,
    });
  }

  async claimProvisioningJob(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    provisioningIdempotencyKey: string;
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

    const row = data[0];
    return {
      authUserId: row.auth_user_id,
      tenantId: row.tenant_id,
      provisioningIdempotencyKey: row.provisioning_idempotency_key,
      provisioningState: row.provisioning_state,
    };
  }

  async completeProvisioning(input: {
    authUserId: string;
    circleWalletSetId: string;
    circleWalletId: string;
    walletAddress: string;
  }): Promise<void> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validWalletSetId = BoundedIdentifierSchema.parse(input.circleWalletSetId);
    const validWalletId = BoundedIdentifierSchema.parse(input.circleWalletId);
    const validAddress = WalletAddressSchema.parse(input.walletAddress);

    const { error } = await this.supabaseClient.rpc("arc_complete_provisioning", {
      p_auth_user_id: validUserId,
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
    errorCode: string;
  }): Promise<void> {
    const validUserId = UuidSchema.parse(input.authUserId);
    const validErrorCode = BoundedErrorCodeSchema.parse(input.errorCode);

    const { error } = await this.supabaseClient.rpc("arc_fail_provisioning", {
      p_auth_user_id: validUserId,
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

    const { error } = await this.supabaseClient.rpc("arc_set_account_status", {
      p_auth_user_id: validUserId,
      p_status: input.status,
    });

    if (error) {
      throw formatRepositoryError("Failed to set account status", error);
    }
  }
}
