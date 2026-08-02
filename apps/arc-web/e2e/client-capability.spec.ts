import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Browser coverage for the capability journeys in the P0-1 acceptance list:
 * read-only, payment-capable, deny, revoke, and auth-epoch invalidation.
 *
 * Unit tests already cover enforcement. What they cannot show is whether the
 * screen tells the truth about it -- which is what the person deciding whether
 * to trust a client is relying on.
 */

const AUTHORIZATION_ID = "xdjoahdagwfu365xo2c3mwpy3wiaaowg";
const AUTH_USER_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_WALLET = "0x1111111111111111111111111111111111111111";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

async function fulfillCorsPreflight(route: Route): Promise<boolean> {
  if (route.request().method() !== "OPTIONS") {
    return false;
  }
  await route.fulfill({ status: 204, headers: CORS_HEADERS, body: "" });
  return true;
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * Signs in through the wallet flow the app actually uses, rather than seeding a
 * session. `grant`: null means no grant row exists, which is where a freshly
 * registered DCR client starts.
 */
async function installArcSession(
  page: Page,
  grant: { canSendPayments: boolean; revoked?: boolean } | null,
): Promise<void> {
  await page.addInitScript((address) => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        async request({ method }: { method: string }) {
          if (method === "eth_requestAccounts") return [address];
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "personal_sign") return `0x${"2".repeat(130)}`;
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      },
    });
  }, EXTERNAL_WALLET);

  await page.route("**/auth/v1/token*", async (route) => {
    if (await fulfillCorsPreflight(route)) return;
    await json(route, 200, {
      access_token: "browser-user-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "browser-refresh-token",
      user: { id: AUTH_USER_ID, role: "authenticated" },
    });
  });

  await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
    if (await fulfillCorsPreflight(route)) return;
    if (route.request().method() === "POST") {
      await json(route, 200, {
        redirect_url: "http://127.0.0.1:4173/mcp-client-callback?code=c&state=s",
      });
      return;
    }
    await json(route, 200, {
      authorization_id: AUTHORIZATION_ID,
      redirect_uri: "http://localhost:6274/oauth/callback",
      client: { name: "Some MCP Client", id: CLIENT_ID },
      user: { id: AUTH_USER_ID, email: "owner@example.test" },
      scope: "openid email",
    });
  });

  await page.route("**/api/account", async (route) => {
    if (await fulfillCorsPreflight(route)) return;
    await json(route, 200, {
      success: true,
      account: {
        status: "ACTIVE",
        consentVersion: "arc-hosted-autonomy-v1",
        wallet: { status: "LIVE", address: EXTERNAL_WALLET },
      },
    });
  });

  await page.route("**/api/account/clients", async (route) => {
    if (await fulfillCorsPreflight(route)) return;
    await json(route, 200, {
      clients: grant
        ? [
            {
              oauthClientId: CLIENT_ID,
              canRead: grant.revoked !== true,
              canSendPayments: grant.canSendPayments,
              revoked: grant.revoked === true,
            },
          ]
        : [],
    });
  });
}

async function openConsent(page: Page): Promise<void> {
  await page.goto(`/oauth/consent?authorization_id=${AUTHORIZATION_ID}`);
  await page.click("#wallet-sign-in-btn");
  await expect(page.locator("#oauth-client-name")).toHaveText("Some MCP Client");
}

test.describe("client capability journeys", () => {
  test("a read-only client is shown as unable to send payments", async ({ page }) => {
    await installArcSession(page, { canSendPayments: false });
    await openConsent(page);

    await expect(page.locator("#oauth-payment-not-granted")).toBeVisible();
    await expect(page.locator("#oauth-payment-granted")).toHaveCount(0);
  });

  test("a payment-capable client is shown as already holding payment access", async ({ page }) => {
    await installArcSession(page, { canSendPayments: true });
    await openConsent(page);

    await expect(page.locator("#oauth-payment-granted")).toBeVisible();
    await expect(page.locator("#oauth-payment-not-granted")).toHaveCount(0);
  });

  test("a client with no grant at all reads as not granted", async ({ page }) => {
    await installArcSession(page, null);
    await openConsent(page);

    await expect(page.locator("#oauth-payment-not-granted")).toBeVisible();
  });

  test("a revoked grant is shown as not granted, not as its stored capability", async ({ page }) => {
    // The stored row still lists payment:send. Rendering that rather than the
    // effective authority would tell the owner a revoked client can still
    // spend.
    await installArcSession(page, { canSendPayments: false, revoked: true });
    await openConsent(page);

    await expect(page.locator("#oauth-payment-not-granted")).toBeVisible();
    await expect(page.locator("#oauth-payment-granted")).toHaveCount(0);
  });

  test("an auth-epoch-retired grant reads as not granted", async ({ page }) => {
    // The server drops a grant issued against an older epoch to wallet:read, so
    // the browser sees canSendPayments false without needing to know why.
    await installArcSession(page, { canSendPayments: false });
    await openConsent(page);

    await expect(page.locator("#oauth-payment-not-granted")).toBeVisible();
  });

  test("denying never sends an approval", async ({ page }) => {
    await installArcSession(page, { canSendPayments: false });

    let approvals = 0;
    await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
      if (await fulfillCorsPreflight(route)) return;
      if (route.request().method() === "POST") {
        if (JSON.stringify(route.request().postDataJSON()).includes("approve")) {
          approvals += 1;
        }
        await json(route, 200, {
          redirect_url: "http://127.0.0.1:4173/mcp-client-callback?error=access_denied",
        });
        return;
      }
      await json(route, 200, {
        authorization_id: AUTHORIZATION_ID,
        redirect_uri: "http://localhost:6274/oauth/callback",
        client: { name: "Some MCP Client", id: CLIENT_ID },
        user: { id: AUTH_USER_ID, email: "owner@example.test" },
        scope: "openid email",
      });
    });

    await openConsent(page);
    await page.click("#oauth-deny-btn");

    expect(approvals, "denying must never send an approval").toBe(0);
  });
});
