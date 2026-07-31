import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";

const AUTHORIZATION_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const AUTH_USER_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_A_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_B_ID = "33333333-3333-4333-8333-333333333333";
const EXTERNAL_WALLET = "0x1111111111111111111111111111111111111111";
const CODE_VERIFIER_A = "client-a-pkce-verifier-with-at-least-forty-three-characters";
const CODE_CHALLENGE_A = createHash("sha256")
  .update(CODE_VERIFIER_A)
  .digest("base64url");
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

async function installAuthenticatedArcFakes(page: Page): Promise<void> {
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
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    const request = route.request();
    expect(request.url()).toContain("grant_type=web3");
    const body = request.postDataJSON();
    expect(body.chain).toBe("ethereum");
    expect(body.message).toContain(EXTERNAL_WALLET);
    expect(body.message).toContain("identity only");
    const user = {
      id: AUTH_USER_ID,
      role: "authenticated",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        access_token: "browser-user-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "browser-refresh-token",
        user,
      }),
    });
  });
  await page.route("**/auth/v1/logout*", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: "{}",
    });
  });
  await page.route("**/api/account", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        account: {
          status: "ACTIVE",
          consentVersion: "arc-hosted-autonomy-v1",
          wallet: {
            status: "LIVE",
            address: "0x1111111111111111111111111111111111111111",
          },
        },
      }),
    });
  });
}

test("MCP discovery, PKCE consent, token exchange, and authenticated MCP complete as one journey", async ({
  page,
}) => {
  await installAuthenticatedArcFakes(page);

  let authorizationRead = 0;
  let authorizationApproved = 0;
  let tokenExchange = 0;
  let authenticatedMcp = 0;
  let authorizationCodeUsed = false;

  await page.route(
    "https://mcp.arc.agentpay.site/.well-known/oauth-protected-resource/mcp",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({
          resource: "https://mcp.arc.agentpay.site/mcp",
          authorization_servers: ["https://example.supabase.co/auth/v1"],
          scopes_supported: ["openid", "profile", "email"],
        }),
      });
    },
  );
  await page.route("**/auth/v1/oauth/authorizations/**", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    if (route.request().method() === "POST") {
      authorizationApproved += 1;
      expect(route.request().postDataJSON()).toEqual({ action: "approve" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({
          redirect_url:
            "http://127.0.0.1:4173/mcp-client-callback?code=client-a-code&state=client-a-state",
        }),
      });
      return;
    }
    authorizationRead += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        authorization_id: AUTHORIZATION_ID,
        redirect_uri: "http://127.0.0.1:4173/mcp-client-callback",
        client: {
          id: CLIENT_A_ID,
          name: "MCP Client A",
          uri: "https://client-a.example",
          logo_uri: "https://client-a.example/logo.png",
        },
        user: {
          id: AUTH_USER_ID,
        },
        scope: "openid profile email",
      }),
    });
  });
  await page.route("**/auth/v1/oauth/token", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    tokenExchange += 1;
    const body = new URLSearchParams(route.request().postData() ?? "");
    const submittedChallenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    const isValid = (
      body.get("grant_type") === "authorization_code"
      && body.get("code") === "client-a-code"
      && body.get("client_id") === CLIENT_A_ID
      && submittedChallenge === CODE_CHALLENGE_A
      && !authorizationCodeUsed
    );
    if (!isValid) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "invalid_grant" }),
      });
      return;
    }
    authorizationCodeUsed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        access_token: "mcp-token-client-a",
        token_type: "bearer",
        expires_in: 3600,
      }),
    });
  });
  await page.route("https://mcp.arc.agentpay.site/mcp", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    authenticatedMcp += 1;
    expect(route.request().headers().authorization).toBe("Bearer mcp-token-client-a");
    expect(route.request().postDataJSON()).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/list",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          principal_client_id: CLIENT_A_ID,
          tools: [{ name: "get_balance" }],
        },
      }),
    });
  });

  await page.goto(`/oauth/consent?authorization_id=${AUTHORIZATION_ID}`);
  const metadata = await page.evaluate(async () => {
    const response = await fetch(
      "https://mcp.arc.agentpay.site/.well-known/oauth-protected-resource/mcp",
    );
    return response.json();
  });
  expect(metadata.authorization_servers).toEqual(["https://example.supabase.co/auth/v1"]);

  await page.click("#wallet-sign-in-btn");
  await expect(page.locator("#oauth-client-name")).toHaveText("MCP Client A");
  await page.click("#oauth-approve-btn");
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/mcp-client-callback?code=client-a-code&state=client-a-state",
  );

  const exchange = await page.evaluate(async ({ clientId, verifier }) => {
    const tokenResponse = await fetch("https://example.supabase.co/auth/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "client-a-code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:4173/mcp-client-callback",
        code_verifier: verifier,
      }),
    });
    const tokenBody = await tokenResponse.json();
    const mcpResponse = await fetch("https://mcp.arc.agentpay.site/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return {
      tokenStatus: tokenResponse.status,
      tokenBody,
      mcpStatus: mcpResponse.status,
      mcpBody: await mcpResponse.json(),
    };
  }, { clientId: CLIENT_A_ID, verifier: CODE_VERIFIER_A });

  expect(exchange.tokenStatus).toBe(200);
  expect(exchange.tokenBody.access_token).toBe("mcp-token-client-a");
  expect(exchange.mcpStatus).toBe(200);
  expect(exchange.mcpBody.result.principal_client_id).toBe(CLIENT_A_ID);
  expect(exchange.mcpBody.result.tools).toEqual([{ name: "get_balance" }]);
  expect(authorizationRead).toBeGreaterThanOrEqual(1);
  expect(authorizationApproved).toBe(1);
  expect(tokenExchange).toBe(1);
  expect(authenticatedMcp).toBe(1);
});

test("OAuth code, token, and client authority cannot be replayed by another client", async ({
  page,
}) => {
  let authorizationCodeUsed = false;
  await page.route("**/auth/v1/oauth/token", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    const body = new URLSearchParams(route.request().postData() ?? "");
    const submittedChallenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    const isValid = (
      body.get("code") === "client-a-single-use-code"
      && body.get("client_id") === CLIENT_A_ID
      && submittedChallenge === CODE_CHALLENGE_A
      && !authorizationCodeUsed
    );
    if (!isValid) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "invalid_grant" }),
      });
      return;
    }
    authorizationCodeUsed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({ access_token: "mcp-token-client-a", token_type: "bearer" }),
    });
  });
  await page.route("https://mcp.arc.agentpay.site/mcp", async (route) => {
    if (await fulfillCorsPreflight(route)) {
      return;
    }
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          principal_client_id: CLIENT_A_ID,
          ignored_caller_client_id: body.params?.client_id,
        },
      }),
    });
  });

  await page.goto("/");
  const result = await page.evaluate(async ({ clientA, clientB, verifier }) => {
    const exchange = async (clientId: string) => {
      const response = await fetch("https://example.supabase.co/auth/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "client-a-single-use-code",
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:4173/mcp-client-callback",
          code_verifier: verifier,
        }),
      });
      return { status: response.status, body: await response.json() };
    };

    const crossClient = await exchange(clientB);
    const clientAFirst = await exchange(clientA);
    const replay = await exchange(clientA);
    const mcpResponse = await fetch("https://mcp.arc.agentpay.site/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientAFirst.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { client_id: clientB },
      }),
    });
    return {
      crossClient,
      clientAFirst,
      replay,
      mcp: await mcpResponse.json(),
    };
  }, { clientA: CLIENT_A_ID, clientB: CLIENT_B_ID, verifier: CODE_VERIFIER_A });

  expect(result.crossClient.status).toBe(400);
  expect(result.crossClient.body.error).toBe("invalid_grant");
  expect(result.clientAFirst.status).toBe(200);
  expect(result.replay.status).toBe(400);
  expect(result.replay.body.error).toBe("invalid_grant");
  expect(result.mcp.result.principal_client_id).toBe(CLIENT_A_ID);
  expect(result.mcp.result.ignored_caller_client_id).toBe(CLIENT_B_ID);
});
