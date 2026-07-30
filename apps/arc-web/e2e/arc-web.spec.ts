import { test, expect } from "@playwright/test";

const ARC_AUTONOMY_CONSENT_VERSION = "arc-hosted-autonomy-v1";
const FAKE_AUTH_USER_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const FAKE_WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

test.beforeEach(async ({ page }) => {
  // Set up mock network interceptors for Supabase and Arc API
  await page.route("**/auth/v1/**", async (route) => {
    const url = route.request().url();

    if (url.includes("/token") || url.includes("/signup") || url.includes("/user")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access_token: "test_dummy_user_token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "test_dummy_refresh_token",
          user: {
            id: FAKE_AUTH_USER_ID,
            email: "agent@example.com",
            role: "authenticated",
          },
        }),
      });
    }

    if (url.includes("/session")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: {
            access_token: "test_dummy_user_token",
            user: { id: FAKE_AUTH_USER_ID, email: "agent@example.com" },
          },
        }),
      });
    }

    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  // Mock Arc API Endpoints
  let accountState: "unclaimed" | "claimed" | "live" | "paused" = "unclaimed";

  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.endsWith("/api/account") && method === "GET") {
      if (accountState === "unclaimed") {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Hosted account not found" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: accountState === "paused" ? "PAUSED" : "ACTIVE",
            consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
            wallet: {
              status: accountState === "live" || accountState === "paused" ? "LIVE" : "PENDING",
              ...(accountState === "live" || accountState === "paused" ? { address: FAKE_WALLET_ADDRESS } : {}),
            },
          },
        }),
      });
    }

    if (url.endsWith("/api/account/claim") && method === "POST") {
      accountState = "claimed";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "ACTIVE",
            consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
            wallet: { status: "PENDING" },
          },
        }),
      });
    }

    if (url.endsWith("/api/wallet/provision") && method === "POST") {
      accountState = "live";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          wallet: {
            address: FAKE_WALLET_ADDRESS,
            status: "LIVE",
          },
        }),
      });
    }

    if (url.endsWith("/api/account/pause") && method === "POST") {
      accountState = "paused";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "PAUSED",
            consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
            wallet: { status: "LIVE", address: FAKE_WALLET_ADDRESS },
          },
        }),
      });
    }

    if (url.endsWith("/api/account/resume") && method === "POST") {
      accountState = "live";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "ACTIVE",
            consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
            wallet: { status: "LIVE", address: FAKE_WALLET_ADDRESS },
          },
        }),
      });
    }

    if (url.endsWith("/api/account/withdraw") && method === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          withdrawal: {
            status: "COMPLETED",
            transactionHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            reconciliationRequired: false,
          },
        }),
      });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ success: false, error: "Not found" }) });
  });
});

test("full registration, autonomy consent, wallet provisioning, pause/resume, and withdrawal journey", async ({ page }) => {
  await page.goto("/");

  // 1. Sign In / Register Page
  await expect(page.locator("#auth-title")).toContainText("Sign In");
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "secretpass123");
  await page.click("#auth-submit-btn");

  // 2. Autonomy Consent Modal
  await expect(page.locator("#consent-modal-title")).toBeVisible();
  await expect(page.locator("#autonomy-consent-text")).toContainText("arc-hosted-autonomy-v1");
  await expect(page.locator("#claim-account-btn")).toBeDisabled();

  // Check consent checkbox and claim
  await page.check("#consent-checkbox");
  await expect(page.locator("#claim-account-btn")).toBeEnabled();
  await page.click("#claim-account-btn");

  // 3. Dashboard - Wallet Provisioning Pending
  await expect(page.locator("#wallet-card-title")).toBeVisible();
  await expect(page.locator("#wallet-status-badge")).toContainText("SCA: PENDING");
  await expect(page.locator("#provision-wallet-btn")).toBeVisible();

  // Trigger Provisioning
  await page.click("#provision-wallet-btn");
  await expect(page.locator("#wallet-status-badge")).toContainText("SCA: LIVE");
  await expect(page.locator("#wallet-address-display")).toContainText(FAKE_WALLET_ADDRESS);

  // 4. Pause & Resume Account
  await page.click("#pause-account-btn");
  await expect(page.locator("#account-status-badge")).toContainText("Account: PAUSED");
  await expect(page.locator("#resume-account-btn")).toBeVisible();

  await page.click("#resume-account-btn");
  await expect(page.locator("#account-status-badge")).toContainText("Account: ACTIVE");

  // 5. Withdrawal Journey
  await page.fill("#withdraw-dest", "0x2222222222222222222222222222222222222222");
  await page.fill("#withdraw-amount", "15.00");
  await page.check("#withdraw-confirm-checkbox");
  await expect(page.locator("#submit-withdraw-btn")).toBeEnabled();

  await page.click("#submit-withdraw-btn");
  await expect(page.locator("#withdrawal-result-alert")).toContainText("COMPLETED");

  // 6. Sign Out
  await page.click("#sign-out-btn");
  await expect(page.locator("#auth-title")).toBeVisible();
});

test("OAuth 2.1 Consent approve journey", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");

  await expect(page.locator("#oauth-title")).toBeVisible();
  await expect(page.locator("#oauth-client-name")).toContainText("AgentPay Arc MCP Client");
  await expect(page.locator("#oauth-scopes-list")).toContainText("openid");

  await expect(page.locator("#oauth-approve-btn")).toBeVisible();
  await expect(page.locator("#oauth-deny-btn")).toBeVisible();
});

test("OAuth 2.1 Consent invalid authorization_id error state", async ({ page }) => {
  await page.goto("/oauth/consent?authorization_id=invalid-uuid");

  await expect(page.locator("#oauth-error-alert")).toContainText("Invalid authorization_id format");
  await expect(page.locator("#oauth-return-home")).toBeVisible();
});
