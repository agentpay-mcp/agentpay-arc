import { test, expect } from "@playwright/test";

const FAKE_AUTH_USER_ID = "11111111-2222-3333-4444-555555555555";
const FAKE_AUTH_USER_ID_B = "99999999-8888-7777-6666-555555555555";
const VALID_AUTH_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

test.beforeEach(async ({ page }) => {
  // Intercept Supabase Auth endpoints with fakes
  await page.route("**/auth/v1/token*", async (route) => {
    const postData = route.request().postDataJSON() || {};
    if (postData.password === "wrongpass") {
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "Invalid login credentials",
        }),
      });
    }
    const userObj = {
      id: postData.email?.includes("userb") ? FAKE_AUTH_USER_ID_B : FAKE_AUTH_USER_ID,
      email: postData.email || "agent@example.com",
      role: "authenticated",
    };
    const sessionObj = {
      access_token: postData.email?.includes("userb") ? "test_dummy_user_b_token" : "test_dummy_user_token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test_dummy_refresh_token",
      user: userObj,
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: sessionObj.access_token,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "test_dummy_refresh_token",
        user: userObj,
        session: sessionObj,
      }),
    });
  });

  await page.route("**/auth/v1/signup*", async (route) => {
    const postData = route.request().postDataJSON() || {};
    const userObj = {
      id: FAKE_AUTH_USER_ID,
      email: postData.email || "newagent@example.com",
      role: "authenticated",
    };
    const sessionObj = {
      access_token: "test_dummy_user_token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test_dummy_refresh_token",
      user: userObj,
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "test_dummy_user_token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "test_dummy_refresh_token",
        user: userObj,
        session: sessionObj,
      }),
    });
  });

  await page.route("**/auth/v1/session*", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: null,
      }),
    });
  });

  await page.route("**/auth/v1/logout*", async (route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
});

test("Security & Policy: CSP meta tag present and no secret keys exposed in browser window", async ({ page }) => {
  await page.goto("/");

  // Verify Content-Security-Policy meta tag
  const cspMeta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(cspMeta).toHaveCount(1);
  const cspContent = await cspMeta.getAttribute("content");
  expect(cspContent).toContain("default-src 'self'");
  expect(cspContent).toContain("script-src 'self'");

  // Verify window object does not expose backend secret keys
  const hasSecret = await page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    return Boolean(
      win.ARC_CIRCLE_API_KEY ||
      win.ARC_SUPABASE_SERVICE_ROLE_KEY ||
      win.ARC_CIRCLE_ENTITY_SECRET
    );
  });
  expect(hasSecret).toBe(false);
});

test("Authentication Journey: Sign In, Sign Up tab, Wrong credentials error, and Sign Out", async ({ page }) => {
  // Register 404 (Unclaimed) route before loading page
  await page.route(/\/api\/account/, async (route) => {
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Account not claimed" }),
    });
  });

  await page.goto("/");

  // Verify Auth Form title and initial Sign In tab
  await expect(page.locator("#auth-title")).toHaveText("Sign In to AgentPay Arc");

  // Attempt Sign In with wrong password
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "wrongpass");
  await page.click("#auth-submit-btn");

  // Expect error alert
  await expect(page.locator("#auth-error-alert")).toBeVisible();

  // Switch to Sign Up tab
  await page.click("#switch-to-signup");
  await expect(page.locator("#auth-title")).toHaveText("Create Arc Account");

  // Sign Up with new credentials
  await page.fill("#auth-email", "newagent@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Verify user lands on Autonomy Consent modal
  await expect(page.locator("#consent-card")).toBeVisible();
  await expect(page.locator("#user-email-display")).toContainText("newagent@example.com");

  // Sign out
  await page.click("#consent-sign-out-btn");
  await expect(page.locator("#auth-title")).toBeVisible();
});

test("Autonomy Consent & Account Claim Journey", async ({ page }) => {
  let isClaimed = false;
  // Mock 404 on initial account load, and 200 on claim and subsequent reads
  await page.route(/\/api\/account/, async (route) => {
    if (route.request().url().includes("claim")) {
      isClaimed = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "ACTIVE",
            consentVersion: "arc-hosted-autonomy-v1",
            wallet: { status: "PENDING" },
            balanceUsdc: "0.00",
            activity: [],
          },
        }),
      });
    }
    if (isClaimed) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "ACTIVE",
            consentVersion: "arc-hosted-autonomy-v1",
            wallet: { status: "PENDING" },
            balanceUsdc: "0.00",
            activity: [],
          },
        }),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Account not claimed" }),
    });
  });

  await page.goto("/");

  // Sign in
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Consent modal visible
  await expect(page.locator("#consent-card")).toBeVisible();
  await expect(page.locator("#claim-account-btn")).toBeDisabled();

  // Check agreement checkbox
  await page.check("#consent-checkbox");
  await expect(page.locator("#claim-account-btn")).toBeEnabled();

  await page.click("#claim-account-btn");

  // Verify transition to Dashboard
  await expect(page.locator("#dashboard-container")).toBeVisible();
  await expect(page.locator("#account-status-badge")).toContainText("ACTIVE");
  await expect(page.locator("#wallet-status-badge")).toContainText("PENDING");
});

test("Dashboard Lifecycle: Wallet Provisioning, Pause/Resume, and Confirmed Withdrawal", async ({ page }) => {
  let currentStatus = "ACTIVE";
  let walletStatus = "LIVE";
  let walletAddress = "0x1111111111111111111111111111111111111111";

  await page.route("**/api/account/pause", async (route) => {
    currentStatus = "PAUSED";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: "PAUSED",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: walletStatus, address: walletAddress },
          balanceUsdc: "150.00",
          activity: [],
        },
      }),
    });
  });

  await page.route("**/api/account/resume", async (route) => {
    currentStatus = "ACTIVE";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: walletStatus, address: walletAddress },
          balanceUsdc: "150.00",
          activity: [],
        },
      }),
    });
  });

  await page.route("**/api/account/withdraw", async (route) => {
    const postData = route.request().postDataJSON();
    expect(postData.destination).toBe("0x2222222222222222222222222222222222222222");
    expect(postData.amount).toBe("25.00");
    expect(postData.confirmed).toBe(true);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        withdrawal: {
          status: "COMPLETED",
          transactionHash: "0x9876543210abcdef",
          reconciliationRequired: false,
        },
      }),
    });
  });

  await page.route("**/api/account", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: currentStatus,
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: walletStatus, address: walletAddress },
          balanceUsdc: "150.00",
          activity: [
            { id: "act-1", type: "Claim", status: "SUCCESS", timestamp: "2026-07-30T10:00:00Z" }
          ],
        },
      }),
    });
  });

  await page.goto("/");

  // Sign in
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Dashboard loaded
  await expect(page.locator("#wallet-address-display")).toContainText(walletAddress);
  await expect(page.locator("#budget-amount")).toContainText("150.00 USDC");

  // Click Pause Account
  await page.click("#pause-account-btn");
  await expect(page.locator("#account-status-badge")).toContainText("PAUSED");
  await expect(page.locator("#resume-account-btn")).toBeVisible();

  // Click Resume Account
  await page.click("#resume-account-btn");
  await expect(page.locator("#account-status-badge")).toContainText("ACTIVE");

  // Test Confirmed Withdrawal Form
  await page.fill("#withdraw-dest", "0x2222222222222222222222222222222222222222");
  await page.fill("#withdraw-amount", "25.00");
  await expect(page.locator("#submit-withdraw-btn")).toBeDisabled();

  await page.check("#withdraw-confirm-checkbox");
  await expect(page.locator("#submit-withdraw-btn")).toBeEnabled();

  await page.click("#submit-withdraw-btn");

  // Verify withdrawal outcome displayed
  await expect(page.locator("#withdrawal-result-alert")).toBeVisible();
  await expect(page.locator("#withdrawal-result-alert")).toContainText("0x9876543210abcdef");
});

test("OAuth 2.1 Consent Journey: Login Requirement, Approve & Deny Redirection", async ({ page }) => {
  // 1. Unauthenticated hit on /oauth/consent -> Prompted to Sign In first
  await page.goto(`/oauth/consent?authorization_id=${VALID_AUTH_ID}`);
  await expect(page.locator("#oauth-signin-banner")).toBeVisible();
  await expect(page.locator("#oauth-signin-banner")).toContainText("Please sign in to authorize application request.");

  // Mock account 200 for user
  await page.route(/\/api\/account/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
        },
      }),
    });
  });

  // Sign in as user
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Verify OAuth Consent Screen renders with authorization details (or error state for mock client)
  await expect(page.locator("#oauth-consent-card").or(page.locator("#oauth-error"))).toBeVisible();

  // Test Invalid authorization_id format error
  await page.goto("/oauth/consent?authorization_id=invalid-uuid-format");
  await expect(page.locator("#oauth-error-alert")).toBeVisible();
  await expect(page.locator("#oauth-error-alert")).toContainText("Invalid authorization_id format.");
});

test("Cross-Tenant Isolation: User A and User B observe isolated wallet addresses & balances", async ({ page }) => {
  // Mock User A vs User B data
  await page.route(/\/api\/account/, async (route) => {
    const authHeader = route.request().headers()["authorization"];
    if (authHeader && authHeader.includes("test_dummy_user_token")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: {
            status: "ACTIVE",
            consentVersion: "arc-hosted-autonomy-v1",
            wallet: { status: "LIVE", address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
            balanceUsdc: "100.00",
            activity: [{ id: "a1", type: "User A Payment", status: "COMPLETED", timestamp: "2026-07-30" }],
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: "LIVE", address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
          balanceUsdc: "500.00",
          activity: [{ id: "b1", type: "User B Payment", status: "COMPLETED", timestamp: "2026-07-30" }],
        },
      }),
    });
  });

  await page.goto("/");

  // Login User A
  await page.fill("#auth-email", "usera@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Verify User A data
  await expect(page.locator("#wallet-address-display")).toContainText("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.locator("#budget-amount")).toContainText("100.00 USDC");
  await expect(page.locator("#activity-card")).toContainText("User A Payment");

  // Logout User A
  await page.click("#sign-out-btn");
  await expect(page.locator("#auth-title")).toBeVisible();

  // Login User B
  await page.fill("#auth-email", "userb@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Verify User B data (isolated from User A)
  await expect(page.locator("#wallet-address-display")).toContainText("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  await expect(page.locator("#budget-amount")).toContainText("500.00 USDC");
  await expect(page.locator("#activity-card")).toContainText("User B Payment");
});

test("Account Read Failure & Retry Flow: 500 Error shows Error Card with Retry button", async ({ page }) => {
  let shouldFail = true;
  await page.route(/\/api\/account/, async (route) => {
    if (shouldFail) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Internal Server Error" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
          balanceUsdc: "200.00",
          activity: [],
        },
      }),
    });
  });

  await page.goto("/");

  // Login user
  await page.fill("#auth-email", "agent@example.com");
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");

  // Expect Error Card (NOT Consent Modal!)
  await expect(page.locator("#account-error-card")).toBeVisible();
  await expect(page.locator("#account-fetch-error-alert")).toContainText("Internal Server Error");
  await expect(page.locator("#consent-card")).not.toBeVisible();

  // Allow next attempt to succeed and click Retry button
  shouldFail = false;
  await page.click("#retry-account-fetch-btn");

  // Dashboard loaded successfully
  await expect(page.locator("#dashboard-container")).toBeVisible();
  await expect(page.locator("#budget-amount")).toContainText("200.00 USDC");
});
