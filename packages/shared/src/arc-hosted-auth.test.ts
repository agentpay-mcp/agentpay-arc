import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARC_AUTONOMY_CONSENT_VERSION,
  ARC_HOSTED_ACCOUNT_TYPE,
  ARC_HOSTED_CHAIN,
  ARC_HOSTED_CUSTODY_TYPE,
  ArcHostedAccountSchema,
  ArcHostedAccountStatusSchema,
  ArcHostedAuthoritySchema,
  ArcWalletProvisioningStateSchema,
} from "./arc-hosted-auth.js";

describe("Arc Hosted Auth & Account Schemas", () => {
  it("defines immutable fixed constants for Arc hosted multi-user setup", () => {
    assert.equal(ARC_HOSTED_CHAIN, "ARC-TESTNET");
    assert.equal(ARC_HOSTED_ACCOUNT_TYPE, "SCA");
    assert.equal(ARC_HOSTED_CUSTODY_TYPE, "DEVELOPER");
    assert.equal(ARC_AUTONOMY_CONSENT_VERSION, "arc-hosted-autonomy-v1");
  });

  it("validates a valid ArcHostedAuthority context", () => {
    const validAuthority = {
      authUserId: "a0000000-0000-4000-8000-000000000001",
      tenantId: "b0000000-0000-4000-8000-000000000002",
      walletAddress: "0x1234567890123456789012345678901234567890",
      accountStatus: "ACTIVE",
      oauthClientId: "client_123",
    };

    const parsed = ArcHostedAuthoritySchema.parse(validAuthority);
    assert.equal(parsed.authUserId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(parsed.tenantId, "b0000000-0000-4000-8000-000000000002");
    assert.equal(parsed.walletAddress, "0x1234567890123456789012345678901234567890");
    assert.equal(parsed.accountStatus, "ACTIVE");
    assert.equal(parsed.oauthClientId, "client_123");
  });

  it("rejects malformed UUIDs and addresses in ArcHostedAuthority", () => {
    assert.throws(
      () =>
        ArcHostedAuthoritySchema.parse({
          authUserId: "not-a-uuid",
          tenantId: "b0000000-0000-4000-8000-000000000002",
          walletAddress: "0x1234567890123456789012345678901234567890",
          accountStatus: "ACTIVE",
        }),
      /authUserId/i,
    );

    assert.throws(
      () =>
        ArcHostedAuthoritySchema.parse({
          authUserId: "a0000000-0000-4000-8000-000000000001",
          tenantId: "not-a-uuid",
          walletAddress: "0x1234567890123456789012345678901234567890",
          accountStatus: "ACTIVE",
        }),
      /tenantId/i,
    );

    assert.throws(
      () =>
        ArcHostedAuthoritySchema.parse({
          authUserId: "a0000000-0000-4000-8000-000000000001",
          tenantId: "b0000000-0000-4000-8000-000000000002",
          walletAddress: "0xinvalid-address",
          accountStatus: "ACTIVE",
        }),
      /walletAddress/i,
    );

    assert.throws(
      () =>
        ArcHostedAuthoritySchema.parse({
          authUserId: "a0000000-0000-4000-8000-000000000001",
          tenantId: "b0000000-0000-4000-8000-000000000002",
          walletAddress: "0x1234567890123456789012345678901234567890",
          accountStatus: "SUSPENDED",
        }),
      /accountStatus/i,
    );
  });

  it("validates account status and provisioning state schemas", () => {
    assert.equal(ArcHostedAccountStatusSchema.parse("ACTIVE"), "ACTIVE");
    assert.equal(ArcHostedAccountStatusSchema.parse("PAUSED"), "PAUSED");
    assert.equal(ArcHostedAccountStatusSchema.parse("CLOSED"), "CLOSED");
    assert.throws(() => ArcHostedAccountStatusSchema.parse("UNKNOWN"));

    assert.equal(ArcWalletProvisioningStateSchema.parse("PENDING"), "PENDING");
    assert.equal(ArcWalletProvisioningStateSchema.parse("PROVISIONING"), "PROVISIONING");
    assert.equal(ArcWalletProvisioningStateSchema.parse("LIVE"), "LIVE");
    assert.equal(ArcWalletProvisioningStateSchema.parse("FAILED"), "FAILED");
    assert.equal(ArcWalletProvisioningStateSchema.parse("CLOSED"), "CLOSED");
    assert.throws(() => ArcWalletProvisioningStateSchema.parse("READY"));
  });

  it("validates safe public account projection excluding Circle IDs and secrets", () => {
    const safeAccountData = {
      authUserId: "a0000000-0000-4000-8000-000000000001",
      tenantId: "b0000000-0000-4000-8000-000000000002",
      accountStatus: "ACTIVE",
      consentVersion: "arc-hosted-autonomy-v1",
      consentTimestamp: "2026-07-29T00:00:00.000Z",
      walletAddress: "0x1234567890123456789012345678901234567890",
      walletStatus: "LIVE",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };

    const parsed = ArcHostedAccountSchema.parse(safeAccountData);
    assert.equal(parsed.consentVersion, "arc-hosted-autonomy-v1");
    assert.equal(parsed.walletStatus, "LIVE");

    // Must not accept invalid consent version
    assert.throws(
      () =>
        ArcHostedAccountSchema.parse({
          ...safeAccountData,
          consentVersion: "v0-legacy",
        }),
      /consentVersion/i,
    );

    // Verify schema shape excludes circle secret fields or policy limit fields
    const keys = Object.keys(ArcHostedAccountSchema.shape);
    assert.ok(!keys.includes("circleWalletId"));
    assert.ok(!keys.includes("circleWalletSetId"));
    assert.ok(!keys.includes("circleEntitySecret"));
    assert.ok(!keys.includes("dailyLimit"));
    assert.ok(!keys.includes("perPaymentCap"));
    assert.ok(!keys.includes("recipientAllowlist"));
  });
});
