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
    tenants: {
      status: "ACTIVE",
      auth_epoch: 0,
    },
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

  it("resolves active tenant authority for a live account with tenant auth_epoch", async () => {
    const fakeClient = {
      from(table: string) {
        assert.equal(table, "arc_hosted_accounts");
        return {
          select(projection: string) {
            assert.ok(projection.includes("tenants!inner"));
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
    assert.equal(authority.authEpoch, 0);
    assert.equal(authority.oauthClientId, "mcp-client-123");
  });

  it("fails to resolve authority when tenant status is SUSPENDED or ARCHIVED", async () => {
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
                        tenants: {
                          status: "SUSPENDED",
                          auth_epoch: 1,
                        },
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

  it("claims provisioning job via RPC and throws on DB error or malformed RPC row", async () => {
    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_claim_provisioning_job") {
          return {
            data: [
              {
                auth_user_id: args.p_auth_user_id,
                tenant_id: "b0000000-0000-4000-8000-000000000002",
                provisioning_idempotency_key: "c0000000-0000-4000-8000-000000000003",
                fencing_token: "d0000000-0000-4000-8000-000000000004",
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
    assert.equal(job.fencingToken, "d0000000-0000-4000-8000-000000000004");
    assert.equal(job.provisioningState, "PROVISIONING");

    // Verify malformed RPC output row fails closed via Zod validation
    const malformedClient = {
      async rpc() {
        return {
          data: [
            {
              auth_user_id: "invalid-uuid",
              tenant_id: "b0000000-0000-4000-8000-000000000002",
              provisioning_idempotency_key: "c0000000-0000-4000-8000-000000000003",
              fencing_token: "d0000000-0000-4000-8000-000000000004",
              provisioning_state: "INJECTED",
            },
          ],
          error: null,
        };
      },
    };
    const malformedRepo = new ArcHostedAccountRepositoryImpl(malformedClient as any);
    await assert.rejects(
      () => malformedRepo.claimProvisioningJob("a0000000-0000-4000-8000-000000000001"),
      /Invalid authUserId format|Invalid/i,
    );

    // Verify DB error throws
    const errorClient = {
      async rpc() {
        return { data: null, error: new Error("Connection failed") };
      },
    };
    const errorRepo = new ArcHostedAccountRepositoryImpl(errorClient as any);
    await assert.rejects(
      () => errorRepo.claimProvisioningJob("a0000000-0000-4000-8000-000000000001"),
      /Failed to claim provisioning job|Database/i,
    );
  });

  it("completes and fails provisioning via fenced RPCs", async () => {
    let completed = false;
    let failed = false;

    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_complete_provisioning") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_fencing_token, "d0000000-0000-4000-8000-000000000004");
          assert.equal(args.p_circle_wallet_set_id, "ws-123");
          assert.equal(args.p_circle_wallet_id, "w-456");
          assert.equal(args.p_wallet_address, "0x1234567890123456789012345678901234567890");
          completed = true;
          return { data: null, error: null };
        }
        if (funcName === "arc_fail_provisioning") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_fencing_token, "d0000000-0000-4000-8000-000000000004");
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
      fencingToken: "d0000000-0000-4000-8000-000000000004",
      circleWalletSetId: "ws-123",
      circleWalletId: "w-456",
      walletAddress: "0x1234567890123456789012345678901234567890",
    });
    assert.ok(completed);

    await repo.failProvisioning({
      authUserId: "a0000000-0000-4000-8000-000000000001",
      fencingToken: "d0000000-0000-4000-8000-000000000004",
      errorCode: "UPSTREAM_TIMEOUT",
    });
    assert.ok(failed);
  });

  it("gets hosted account or returns null or throws on error", async () => {
    // Returns account
    const fakeClient1 = {
      from() {
        return {
          select() {
            return {
              eq() {
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
    const repo1 = new ArcHostedAccountRepositoryImpl(fakeClient1 as any);
    const account = await repo1.getHostedAccount("a0000000-0000-4000-8000-000000000001");
    assert.ok(account !== null);
    assert.equal(account.authUserId, "a0000000-0000-4000-8000-000000000001");

    // Returns null
    const fakeClient2 = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    const repo2 = new ArcHostedAccountRepositoryImpl(fakeClient2 as any);
    const nullAccount = await repo2.getHostedAccount("a0000000-0000-4000-8000-000000000001");
    assert.equal(nullAccount, null);

    // Throws formatted DB error
    const fakeClient3 = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: new Error("DB Error") };
                  },
                };
              },
            };
          },
        };
      },
    };
    const repo3 = new ArcHostedAccountRepositoryImpl(fakeClient3 as any);
    await assert.rejects(() => repo3.getHostedAccount("a0000000-0000-4000-8000-000000000001"), /Failed to read hosted account/i);
  });

  it("handles setAccountStatus and maps error formats", async () => {
    let setStatus = false;
    const fakeClient = {
      async rpc(funcName: string, args: any) {
        if (funcName === "arc_set_account_status") {
          assert.equal(args.p_auth_user_id, "a0000000-0000-4000-8000-000000000001");
          assert.equal(args.p_status, "PAUSED");
          setStatus = true;
          return { data: null, error: null };
        }
        return { data: null, error: new Error("Unknown RPC") };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
    await repo.setAccountStatus({
      authUserId: "a0000000-0000-4000-8000-000000000001",
      status: "PAUSED",
    });
    assert.ok(setStatus);
  });

  it("formats repository business exception errors cleanly", async () => {
    const errorCases = [
      { raw: "Stale or invalid fencing token", expected: "Stale or invalid fencing token" },
      { raw: "Cannot fail provisioning", expected: "Cannot fail provisioning from current state" },
      { raw: "Cannot complete provisioning", expected: "Cannot complete provisioning from current state" },
      { raw: "Cannot re-complete LIVE provisioning", expected: "Cannot re-complete LIVE provisioning with conflicting parameters" },
      { raw: "Hosted account not found", expected: "Hosted account not found" },
      { raw: "Invalid account status", expected: "Invalid account status" },
      { raw: "Invalid consent version", expected: "Invalid consent version" },
      { raw: "Binding record not found", expected: "Binding record not found" },
      { raw: "Some unknown PG error", expected: "Database request failed" },
    ];

    for (const ec of errorCases) {
      const fakeClient = {
        async rpc() {
          return { data: null, error: new Error(ec.raw) };
        },
      };
      const repo = new ArcHostedAccountRepositoryImpl(fakeClient as any);
      await assert.rejects(
        () => repo.setAccountStatus({ authUserId: "a0000000-0000-4000-8000-000000000001", status: "CLOSED" }),
        new RegExp(ec.expected),
      );
    }
  });

  it("handles empty RPC results in claimHostedAccount and claimProvisioningJob", async () => {
    const emptyClient = {
      async rpc() {
        return { data: [], error: null };
      },
    };

    const repo = new ArcHostedAccountRepositoryImpl(emptyClient as any);
    await assert.rejects(
      () => repo.claimHostedAccount({ authUserId: "a0000000-0000-4000-8000-000000000001" }),
      /Empty RPC result/i,
    );

    const job = await repo.claimProvisioningJob("a0000000-0000-4000-8000-000000000001");
    assert.equal(job, null);
  });
});
