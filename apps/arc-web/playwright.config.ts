import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --host 127.0.0.1",
    port: 4173,
    reuseExistingServer: false,
    env: {
      VITE_ARC_PUBLIC_ORIGIN: "http://127.0.0.1:4173",
      VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
      VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
      VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-for-e2e-tests",
    },
  },
});
