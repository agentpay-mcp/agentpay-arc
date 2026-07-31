import { test, expect } from "@playwright/test";

const FAKE_AUTH_USER_ID = "11111111-2222-4333-8444-555555555555";
const FAKE_AUTH_USER_ID_B = "99999999-8888-4777-8666-555555555555";
const VALID_AUTH_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

async function signInWithWallet(page: import("@playwright/test").Page, wallet: "a" | "b" = "a") {
  await page.evaluate((selectedWallet) => {
    window.sessionStorage.setItem("arc-test-wallet", selectedWallet);
  }, wallet);
  await page.click("#wallet-sign-in-btn");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ walletA, walletB }) => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        async request({ method }: { method: string }) {
          const selected = window.sessionStorage.getItem("arc-test-wallet");
          if (selected === "reject") {
            throw new Error("wallet rejected with sensitive provider details");
          }
          const address = selected === "b" ? walletB : walletA;
          if (method === "eth_requestAccounts") return [address];
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "personal_sign") return `0x${"1".repeat(130)}`;
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      },
    });
  }, { walletA: WALLET_A, walletB: WALLET_B });

  await page.route("**/auth/v1/token*", async (route) => {
    const postData = route.request().postDataJSON() || {};
    const isRefresh = route.request().url().includes("grant_type=refresh_token");
    if (!isRefresh) {
      expect(route.request().url()).toContain("grant_type=web3");
      expect(postData.chain).toBe("ethereum");
      expect(postData.message).toContain("identity only");
      expect(postData.message).toContain("This does not approve payments");
      expect(postData.message).toContain("URI: http://127.0.0.1:4173/");
      expect(postData.signature).toMatch(/^0x1{130}$/);
    }
    const userObj = {
      id: postData.message?.includes(WALLET_B) ? FAKE_AUTH_USER_ID_B : FAKE_AUTH_USER_ID,
      role: "authenticated",
    };
    const sessionObj = {
      access_token: postData.message?.includes(WALLET_B) ? "test_dummy_user_b_token" : "test_dummy_user_token",
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
  let disallowedOriginReached = false;
  await page.route("https://evil.example/**", async (route) => {
    disallowedOriginReached = true;
    await route.fulfill({ status: 200, body: "should not be reached" });
  });
  await page.goto("/");

  const cspMeta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(cspMeta).toHaveCount(1);
  const cspContent = await cspMeta.getAttribute("content");
  expect(cspContent).toContain("default-src 'self'");
  expect(cspContent).toContain("script-src 'self'");
  expect(cspContent).toContain(
    "connect-src 'self' https://mcp.arc.agentpay.site https://example.supabase.co;",
  );
  expect(cspContent).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;)/);
  expect(cspContent).not.toContain("*.supabase.co");
  expect(cspContent).toContain("frame-ancestors 'none'");
  expect(cspContent).toContain("object-src 'none'");

  const disallowedFetch = await page.evaluate(async () => {
    try {
      await fetch("https://evil.example/private");
      return "allowed";
    } catch {
      return "blocked";
    }
  });
  expect(disallowedFetch).toBe("blocked");
  expect(disallowedOriginReached).toBe(false);

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

test("Authentication Journey: Wallet Sign In, Sign Out, rejected signature, and retry", async ({ page }) => {
  await page.route(/\/api\/account/, async (route) => {
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Account not claimed" }),
    });
  });

  await page.goto("/");

  await expect(page.locator("#auth-title")).toHaveText("Connect Wallet to AgentPay Arc");
  await expect(page.locator("#auth-email")).toHaveCount(0);
  await expect(page.locator("#auth-password")).toHaveCount(0);

  await page.evaluate(() => window.sessionStorage.setItem("arc-test-wallet", "reject"));
  await page.click("#wallet-sign-in-btn");
  await expect(page.locator("#auth-error-alert")).toContainText(
    "Wallet sign in failed. Connect your wallet and try again.",
  );
  await expect(page.locator("#auth-error-alert")).not.toContainText("sensitive provider details");

  await signInWithWallet(page);

  await expect(page.locator("#consent-card")).toBeVisible();
  await expect(page.locator("#verified-wallet-session")).toContainText("your verified wallet session");

  // Sign out
  await page.click("#consent-sign-out-btn");
  await expect(page.locator("#auth-title")).toBeVisible();

  // A repeated wallet sign in returns to the product journey without registration.
  await signInWithWallet(page);
  await expect(page.locator("#consent-card")).toBeVisible();
});

test("Autonomy Consent & Account Claim Journey", async ({ page }) => {
  let isClaimed = false;
  let walletIsReady = false;
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
            wallet: walletIsReady
              ? { status: "LIVE", address: "0x1111111111111111111111111111111111111111" }
              : { status: "PENDING" },
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
            wallet: walletIsReady
              ? { status: "LIVE", address: "0x1111111111111111111111111111111111111111" }
              : { status: "PENDING" },
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

  await page.route("**/api/wallet/provision", async (route) => {
    walletIsReady = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        wallet: {
          status: "LIVE",
          address: "0x1111111111111111111111111111111111111111",
        },
      }),
    });
  });

  await page.goto("/");

  // Wallet sign in
  await signInWithWallet(page);

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

  await page.click("#provision-wallet-btn");
  await expect(page.locator("#wallet-status-badge")).toContainText("LIVE");
  await expect(page.locator("#wallet-address-display")).toContainText(
    "0x1111111111111111111111111111111111111111",
  );
});

test("Dashboard Lifecycle: Wallet Provisioning, Pause/Resume, and Confirmed Withdrawal", async ({ page }) => {
  let currentStatus = "ACTIVE";
  let walletStatus = "LIVE";
  let walletAddress = "0x1111111111111111111111111111111111111111";
  const withdrawalKeys: string[] = [];

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
    expect(postData.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    withdrawalKeys.push(postData.idempotencyKey);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        withdrawal: {
          status: withdrawalKeys.length === 1 ? "COMPLETED" : "RECONCILIATION_REQUIRED",
          transactionHash: withdrawalKeys.length === 1 ? "0x9876543210abcdef" : undefined,
          reconciliationRequired: withdrawalKeys.length > 1,
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

  // Wallet sign in
  await signInWithWallet(page);

  // Dashboard loaded
  await expect(page.locator("#wallet-address-display")).toContainText(walletAddress);
  await expect(page.locator("#budget-amount")).toContainText("150.00 USDC");

  // Click Pause Account
  await page.click("#pause-account-btn");
  await expect(page.locator("#account-status-badge")).toContainText("PAUSED");
  await expect(page.locator("#resume-account-btn")).toBeVisible();
  await expect(page.locator("#withdraw-dest")).toBeDisabled();
  await expect(page.locator("#withdraw-amount")).toBeDisabled();
  await expect(page.locator("#submit-withdraw-btn")).toBeDisabled();
  await page.locator("#withdrawal-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("#withdrawal-input-error-alert")).toContainText(
    "Resume the account before requesting a withdrawal.",
  );
  expect(withdrawalKeys).toHaveLength(0);

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

  // A retry is a separate user action and therefore receives a fresh idempotency key.
  await expect(page.locator("#submit-withdraw-btn")).toBeEnabled();
  await page.click("#submit-withdraw-btn");
  await expect(page.locator("#withdrawal-result-alert")).toContainText(
    "pending reconciliation with Arc network",
  );
  expect(withdrawalKeys).toHaveLength(2);
  expect(withdrawalKeys[0]).not.toBe(withdrawalKeys[1]);
});

test("OAuth 2.1 Consent Journey: authenticated approval uses exact Supabase APIs and returned redirect", async ({ page }) => {
  let authorizationRead = 0;
  let approveCount = 0;
  await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
    const request = route.request();
    expect(request.headers()["authorization"]).toContain("test_dummy_user_token");
    if (request.method() === "POST") {
      approveCount += 1;
      expect(request.url()).toContain(`/${VALID_AUTH_ID}/consent`);
      expect(request.postDataJSON()).toEqual({ action: "approve" });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          redirect_url: "http://127.0.0.1:4173/oauth-approved?code=approved&state=state-a",
        }),
      });
    }
    authorizationRead += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authorization_id: VALID_AUTH_ID,
        redirect_uri: "https://client-a.example/callback",
        client: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "MCP Client A",
          uri: "https://client-a.example",
          logo_uri: "https://client-a.example/logo.png",
        },
        user: {
          id: FAKE_AUTH_USER_ID,
        },
        scope: "openid profile email",
      }),
    });
  });

  // 1. Unauthenticated hit on /oauth/consent -> Prompted to Sign In first
  await page.goto(
    `/oauth/consent?authorization_id=${VALID_AUTH_ID}&redirect_uri=javascript:alert(document.domain)`,
  );
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

  // Wallet sign in as user
  await signInWithWallet(page);

  await expect(page.locator("#oauth-consent-card")).toBeVisible();
  await expect(page.locator("#oauth-client-name")).toHaveText("MCP Client A");
  await expect(page.locator("#oauth-redirect-uri")).toContainText("https://client-a.example/callback");
  await expect(page.locator("#oauth-scopes-list")).toContainText("openid");
  await expect(page.locator("#oauth-scopes-list")).toContainText("profile");
  expect(authorizationRead).toBeGreaterThanOrEqual(1);

  await page.click("#oauth-approve-btn");
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/oauth-approved?code=approved&state=state-a",
  );
  expect(approveCount).toBe(1);
});

test("OAuth 2.1 Consent Journey: explicit denial follows only Supabase redirect", async ({ page }) => {
  let denyCount = 0;
  await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
    if (route.request().method() === "POST") {
      denyCount += 1;
      expect(route.request().postDataJSON()).toEqual({ action: "deny" });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          redirect_url: "http://127.0.0.1:4173/oauth-denied?error=access_denied&state=state-b",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authorization_id: VALID_AUTH_ID,
        redirect_uri: "https://client-b.example/callback",
        client: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "MCP Client B",
          uri: "https://client-b.example",
          logo_uri: "https://client-b.example/logo.png",
        },
        user: { id: FAKE_AUTH_USER_ID },
        scope: "openid",
      }),
    });
  });
  await page.route("**/api/account", async (route) => route.fulfill({
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
  }));

  await page.goto(`/oauth/consent?authorization_id=${VALID_AUTH_ID}`);
  await signInWithWallet(page);
  await expect(page.locator("#oauth-consent-card")).toBeVisible();
  await page.click("#oauth-deny-btn");
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/oauth-denied?error=access_denied&state=state-b",
  );
  expect(denyCount).toBe(1);
});

test("OAuth 2.1 Consent Journey: already-approved, expired, and invalid requests fail safely", async ({ page }) => {
  let oauthRequests = 0;
  await page.route("**/api/account", async (route) => route.fulfill({
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
  }));
  await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
    oauthRequests += 1;
    const url = route.request().url();
    if (url.includes(VALID_AUTH_ID)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          redirect_url: "http://127.0.0.1:4173/already-approved?code=existing",
        }),
      });
    }
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        message: "raw database authorization failure for another tenant",
      }),
    });
  });

  await page.goto(`/oauth/consent?authorization_id=${VALID_AUTH_ID}`);
  await signInWithWallet(page);
  await expect(page).toHaveURL("http://127.0.0.1:4173/already-approved?code=existing");
  expect(oauthRequests).toBeGreaterThanOrEqual(1);
  const requestsAfterRedirect = oauthRequests;

  const expiredId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await page.goto(`/oauth/consent?authorization_id=${expiredId}`);
  await expect(page.locator("#oauth-error-alert")).toContainText(
    "Unable to load this authorization request. It may be invalid or expired.",
  );
  await expect(page.locator("#oauth-error-alert")).not.toContainText("database");
  expect(oauthRequests).toBeGreaterThan(requestsAfterRedirect);
  const requestsAfterExpired = oauthRequests;

  await page.goto("/oauth/consent?authorization_id=invalid-uuid-format");
  await expect(page.locator("#oauth-error-alert")).toContainText("Invalid authorization_id format.");
  expect(oauthRequests).toBe(requestsAfterExpired);
});

test("Session refresh and expired-session recovery retain the authenticated journey", async ({ page }) => {
  let refreshCount = 0;
  await page.route("**/auth/v1/token*", async (route) => {
    const body = route.request().postData() ?? "";
    const isRefresh = body.includes("refresh_token") || route.request().url().includes("grant_type=refresh_token");
    if (isRefresh) {
      refreshCount += 1;
    }
    const user = {
      id: FAKE_AUTH_USER_ID,
      role: "authenticated",
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: isRefresh ? "refreshed_access_token" : "test_dummy_user_token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "test_dummy_refresh_token",
        user,
      }),
    });
  });
  await page.route("**/api/account", async (route) => route.fulfill({
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
  }));

  await page.goto("/");
  await signInWithWallet(page);
  await expect(page.locator("#dashboard-container")).toBeVisible();

  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.includes("auth-token"));
    if (!key) throw new Error("Supabase auth session was not persisted");
    const session = JSON.parse(localStorage.getItem(key) ?? "{}");
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem(key, JSON.stringify(session));
  });
  await page.reload();
  await expect(page.locator("#dashboard-container")).toBeVisible();
  expect(refreshCount).toBeGreaterThan(0);

  // A backend rejection signs the expired identity out and allows a clean login.
  await page.unroute("**/api/account");
  await page.route("**/api/account", async (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ success: false, error: "raw expired token details" }),
  }));
  await page.reload();
  await expect(page.locator("#auth-title")).toBeVisible();
  await expect(page.getByText("raw expired token details")).toHaveCount(0);
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

  // Login User A through the external wallet identity.
  await signInWithWallet(page, "a");

  // Verify User A data
  await expect(page.locator("#wallet-address-display")).toContainText("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.locator("#budget-amount")).toContainText("100.00 USDC");
  await expect(page.locator("#activity-card")).toContainText("User A Payment");

  // Logout User A
  await page.click("#sign-out-btn");
  await expect(page.locator("#auth-title")).toBeVisible();

  // Login User B through a different external wallet identity.
  await signInWithWallet(page, "b");

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

  // Wallet sign in
  await signInWithWallet(page);

  // Expect Error Card (NOT Consent Modal!)
  await expect(page.locator("#account-error-card")).toBeVisible();
  await expect(page.locator("#account-fetch-error-alert")).toContainText(
    "The Arc server could not complete the request. Please try again.",
  );
  await expect(page.locator("#account-fetch-error-alert")).not.toContainText("Internal Server Error");
  await expect(page.locator("#consent-card")).not.toBeVisible();

  // Allow next attempt to succeed and click Retry button
  shouldFail = false;
  await page.click("#retry-account-fetch-btn");

  // Dashboard loaded successfully
  await expect(page.locator("#dashboard-container")).toBeVisible();
  await expect(page.locator("#budget-amount")).toContainText("200.00 USDC");
});

test("Accessibility and responsive layout: keyboard focus is visible and content does not overflow", async ({ page }) => {
  await page.goto("/");
  await page.locator("#wallet-sign-in-btn").focus();
  await expect(page.locator("#wallet-sign-in-btn")).toBeFocused();

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    title: document.querySelector("h2")?.textContent,
    identityOnlyCopy: document.querySelector(".card p")?.textContent,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.title).toContain("Connect Wallet");
  expect(layout.identityOnlyCopy).toContain("identity only");
});
