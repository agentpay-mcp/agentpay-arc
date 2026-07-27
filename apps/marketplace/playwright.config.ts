import { defineConfig, devices } from "@playwright/test";

/**
 * Desktop and mobile run the same specs. The marketplace ships no script, so
 * these check rendered structure, security headers, and keyboard reachability
 * rather than client behaviour.
 */
export default defineConfig({
  testDir: "./e2e",
  // The handoff fixes the spec filename as marketplace.e2e.ts, which is not
  // Playwright default testMatch.
  testMatch: /.*\.e2e\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.MARKETPLACE_BASE_URL ?? "http://127.0.0.1:8790",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx tsx e2e/fixture-server.ts",
    url: process.env.MARKETPLACE_BASE_URL ?? "http://127.0.0.1:8790",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
