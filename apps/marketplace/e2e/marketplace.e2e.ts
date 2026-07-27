import { expect, test } from "@playwright/test";

const TX = `0x${"cd".repeat(32)}`;

test("lists services with Arc price and network", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Paid services on Arc");
  await expect(page.getByRole("link", { name: "Weather Oracle" })).toBeVisible();
  // Two cards render, so both of these match more than once.
  await expect(page.getByText("0.010000 USDC").first()).toBeVisible();
  await expect(page.getByText("Arc Testnet").first()).toBeVisible();
});

test("filters by search term", async ({ page }) => {
  await page.goto("/?q=translate");

  await expect(page.getByRole("link", { name: "Translate API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Weather Oracle" })).toHaveCount(0);
});

test("the search form actually submits from the browser", async ({ page }) => {
  // Navigating straight to /?q=... passes even when CSP form-action blocks the
  // form. Only a real submit catches that.
  await page.goto("/");
  await page.getByLabel("Search services").fill("translate");
  await page.getByLabel("Search services").press("Enter");

  await expect(page).toHaveURL(/[?&]q=translate/);
  await expect(page.getByRole("link", { name: "Translate API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Weather Oracle" })).toHaveCount(0);
});

test("the category filter submits from the browser too", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Category").fill("language");
  await page.getByLabel("Category").press("Enter");

  await expect(page).toHaveURL(/[?&]category=language/);
  await expect(page.getByRole("link", { name: "Translate API" })).toBeVisible();
});

test("filters by category", async ({ page }) => {
  await page.goto("/?category=language");

  await expect(page.getByRole("link", { name: "Translate API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Weather Oracle" })).toHaveCount(0);
});

test("shows an empty state instead of a blank page", async ({ page }) => {
  await page.goto("/?q=nothing-matches-this");

  await expect(page.getByText(/No services matched/i)).toBeVisible();
});

test("service detail shows trust, jobs, and a copyable prompt", async ({ page }) => {
  await page.goto("/services/svc-weather");

  await expect(page.getByText("Registration metadata fetched and validated")).toBeVisible();
  await expect(page.getByText("Endpoint domain control not verified")).toBeVisible();
  await expect(page.getByText(/Job 8183/)).toBeVisible();

  const prompt = page.getByLabel("AgentPay prompt");
  await expect(prompt).toHaveValue(/pay_paid_service/);
  await expect(prompt).toHaveAttribute("readonly", "");
});

test("the detail page cannot execute a payment", async ({ page }) => {
  await page.goto("/services/svc-weather");

  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(0);
  await expect(page.locator("button[type=submit]")).toHaveCount(0);
});

test("activity refuses an anonymous visitor", async ({ page }) => {
  await page.goto("/activity");

  await expect(page.getByRole("heading", { name: /Sign in required/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /View proof on Arcscan/i })).toHaveCount(0);
});

test("activity shows a working Arcscan proof link for a signed-in tenant", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-tenant": "tenant-a" });
  await page.goto("/activity");

  const proof = page.getByRole("link", { name: /View proof on Arcscan/i });
  await expect(proof).toHaveAttribute("href", `https://testnet.arcscan.app/tx/${TX}`);
  await expect(proof).toHaveAttribute("rel", /noopener/);
});

test("serves a strict CSP and no-store on private activity", async ({ page }) => {
  const catalogue = await page.goto("/");
  expect(catalogue?.headers()["content-security-policy"]).toContain("script-src 'none'");

  const activity = await page.goto("/activity");
  expect(activity?.headers()["cache-control"]).toBe("no-store");
  expect(catalogue?.headers()["content-security-policy"]).toContain("form-action 'self'");
});

test("is reachable by keyboard alone", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();

  // Tab to the search field and type without touching the mouse.
  await page.getByLabel("Search services").focus();
  await page.keyboard.type("weather");
  await expect(page.getByLabel("Search services")).toHaveValue("weather");
});

test("renders a single-column layout on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile projection only");

  await page.goto("/");
  const body = page.locator("body");

  await expect(body).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
