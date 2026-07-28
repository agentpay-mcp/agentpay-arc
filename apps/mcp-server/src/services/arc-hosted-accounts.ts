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

function sanitizeDbError(message: string): string {
  return message.replace(/key \(.*?\)=\(.*?\)/gi, "key [REDACTED_KEY_VALUE]");
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
    const consentVersion = input.consentVersion ?? ARC_AUTONOMY_CONSENT_VERSION;

    const { data, error } = await this.supabaseClient.rpc("arc_claim_hosted_account", {
      p_auth_user_id: input.authUserId,
      p_consent_version: consentVersion,
    });

    if (error) {
      throw new Error(`Failed to claim hosted account: ${sanitizeDbError(error.message)}`);
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
    const { data, error } = await this.supabaseClient
      .from("arc_hosted_accounts")
      .select("*")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read hosted account: ${sanitizeDbError(error.message)}`);
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
    // Join arc_hosted_accounts with tenants to ensure both account and tenant are ACTIVE and retrieve tenant auth_epoch
    const { data, error } = await this.supabaseClient
      .from("arc_hosted_accounts")
      .select("*, tenants!inner(status, auth_epoch)")
      .eq("auth_user_id", input.authUserId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to resolve hosted authority: ${sanitizeDbError(error.message)}`);
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
      oauthClientId: input.oauthClientId,
    });
  }

  async claimProvisioningJob(authUserId: string): Promise<{
    authUserId: string;
    tenantId: string;
    provisioningIdempotencyKey: string;
    provisioningState: ArcWalletProvisioningState;
  } | null> {
    const { data, error } = await this.supabaseClient.rpc("arc_claim_provisioning_job", {
      p_auth_user_id: authUserId,
    });

    if (error) {
      throw new Error(`Database error in claimProvisioningJob: ${sanitizeDbError(error.message)}`);
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
    const { error } = await this.supabaseClient.rpc("arc_complete_provisioning", {
      p_auth_user_id: input.authUserId,
      p_circle_wallet_set_id: input.circleWalletSetId,
      p_circle_wallet_id: input.circleWalletId,
      p_wallet_address: input.walletAddress,
    });

    if (error) {
      throw new Error(`Failed to complete provisioning: ${sanitizeDbError(error.message)}`);
    }
  }

  async failProvisioning(input: {
    authUserId: string;
    errorCode: string;
  }): Promise<void> {
    const { error } = await this.supabaseClient.rpc("arc_fail_provisioning", {
      p_auth_user_id: input.authUserId,
      p_error_code: input.errorCode,
    });

    if (error) {
      throw new Error(`Failed to record provisioning failure: ${sanitizeDbError(error.message)}`);
    }
  }

  async setAccountStatus(input: {
    authUserId: string;
    status: ArcHostedAccountStatus;
  }): Promise<void> {
    const { error } = await this.supabaseClient.rpc("arc_set_account_status", {
      p_auth_user_id: input.authUserId,
      p_status: input.status,
    });

    if (error) {
      throw new Error(`Failed to set account status: ${sanitizeDbError(error.message)}`);
    }
  }
}
