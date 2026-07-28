import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArcHostedAccountRepositoryImpl } from "./arc-hosted-accounts.js";

describe("ArcHostedAccountRepository", () => {
  const fakeAccountRow = {
    auth_user_id: "a0000000-0000-4000-8000-000000000001",
    tenant_id: "b0000000-0000-4000-8000-000000000002",
    account_status: "ACTIVE",
    consent_version: "arc-hosted-autonomy-v1",
    consent_timestamp: "2026-07-29T00:00:00.000Z",
    wallet_address: "0x1234567890123456789012345678901234567890",
    wallet_status: "LIVE",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
  };

  it("claims a hosted account via atomic service-role RPC", async () => {
    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_claim_hosted_account") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_consent_version, "arc-hosted-autonomy-v1");
          return { data: [fakeAccountRow], error: null };
        }
        return { data: null, error: new Error("Unknown RPC") };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    const account = await repo.claimHostedAccount({
      authUserId: "a0000000-0000-4000-8000-000000000001",
    });

    assert.equal(account.authUserId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(account.tenantId, "b0000000-0000-4000-8000-000000000002");
    assert.equal(account.accountStatus, "ACTIVE");
    assert.equal(account.walletStatus, "LIVE");
  });

  it("resolves active tenant authority for a live account", async () => {
    const fakeClient = {
      from(table: string) {
        assert.equal(table, "arc_hosted_accounts");
        return {
          select() {
            return {
              eq(col: string, val: string) {
                assert.equal(col, "auth_user_id");
                assert.equal(val, "a0000000-0000-4000-8000-000000000001");
                return {
                  async maybeSingle() {
                    return { data: fakeAccountRow, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    const authority = await repo.resolveHostedAuthority({
      authUserId: "a0000000-0000-4000-8000-000000000001",
      oauthClientId: "mcp-client-123",
    });

    assert.ok(authority !== null);
    assert.equal(authority.authUserId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(authority.tenantId, "b0000000-0000-4000-8000-000000000002");
    assert.equal(authority.walletAddress, "0x1234567890123456789012345678901234567890");
    assert.equal(authority.accountStatus, "ACTIVE");
    assert.equal(authority.oauthClientId, "mcp-client-123");
  });

  it("fails to resolve authority when account is PAUSED or CLOSED", async () => {
    const fakeClient = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        ...fakeAccountRow,
                        account_status: "PAUSED",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    const authority = await repo.resolveHostedAuthority({
      authUserId: "a0000000-0000-4000-8000-000000000001",
    });

    assert.equal(authority, null);
  });

  it("fails to resolve authority when wallet status is not LIVE or wallet address is missing", async () => {
    const fakeClient = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        ...fakeAccountRow,
                        wallet_status: "PENDING",
                        wallet_address: null,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    const authority = await repo.resolveHostedAuthority({
      authUserId: "a0000000-0000-4000-8000-000000000001",
    });

    assert.equal(authority, null);
  });

  it("claims provisioning job via RPC", async () => {
    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_claim_provisioning_job") {
          return {
            data: [
              {
                auth_user_id: args.p_auth_user_id,
                tenant_id: "b0000000-0000-4000-8000-000000000002",
                provisioning_idempotency_key: "c0000000-0000-4000-8000-000000000003",
                provisioning_state: "PROVISIONING",
              },
            ],
            error: null,
          };
        }
        return { data: null, error: new Error("Unknown RPC") };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    const job = await repo.claimProvisioningJob("a0000000-0000-4000-8000-000000000001");

    assert.ok(job !== null);
    assert.equal(job.authUserId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(job.provisioningState, "PROVISIONING");
  });

  it("completes and fails provisioning via RPCs", async () => {
    let completed = false;
    let failed = false;

    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_complete_provisioning") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_circle_wallet_set_id, "ws-123");
          assert.equal(args.p_circle_wallet_id, "w-456");
          assert.equal(args.p_wallet_address, "0x1234567890123456789012345678901234567890");
          completed = true;
          return { data: null, error: null };
        }
        if (funcName === "arc_fail_provisioning") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_error_code, "UPSTREAM_TIMEOUT");
          failed = true;
          return { data: null, error: null };
        }
        return { data: null, error: new Error("Unknown RPC") };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);

    await repo.completeProvisioning({
      authUserId: "a0000000-0000-4000-8000-000000000001",
      circleWalletSetId: "ws-123",
      circleWalletId: "w-456",
      walletAddress: "0x1234567890123456789012345678901234567890",
    });
    assert.ok(completed);

    await repo.failProvisioning({
      authUserId: "a0000000-0000-4000-8000-000000000001",
      errorCode: "UPSTREAM_TIMEOUT",
    });
    assert.ok(failed);
  });
});
