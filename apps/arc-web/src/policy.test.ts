import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

test("arc-web exposes an enforcing per-module branch coverage gate", async () => {
  const packageJson = JSON.parse(await readFile(`${appRoot}/package.json`, "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.["test:coverage"], "node scripts/verify-coverage.mjs");

  const coverageScript = await readFile(`${appRoot}/scripts/verify-coverage.mjs`, "utf8");
  assert.match(coverageScript, /MINIMUM_BRANCH_COVERAGE\s*=\s*80/);
  for (const moduleName of [
    "api.ts",
    "App.tsx",
    "AuthForm.tsx",
    "ConsentModal.tsx",
    "Dashboard.tsx",
    "OAuthConsent.tsx",
    "config.ts",
    "supabase.ts",
    "withdrawal.ts",
  ]) {
    assert.ok(coverageScript.includes(moduleName), `coverage gate must include ${moduleName}`);
  }
});

test("CSP uses exact build-time Arc origins and never wildcard HTTPS or Supabase hosts", async () => {
  const html = await readFile(`${appRoot}/index.html`, "utf8");
  assert.match(
    html,
    /connect-src 'self' %VITE_ARC_API_ORIGIN% %VITE_ARC_SUPABASE_URL%;/,
  );
  assert.equal(html.includes("https:"), false);
  assert.equal(html.includes("*.supabase.co"), false);
  assert.equal(html.includes("http://localhost:*"), false);
  assert.equal(html.includes("http://127.0.0.1:*"), false);
});

test("arc-web imports browser-safe shared subpaths that are included in package releases", async () => {
  const sharedPackage = JSON.parse(
    await readFile(`${appRoot}/../../packages/shared/package.json`, "utf8"),
  ) as {
    exports?: Record<string, string>;
    files?: string[];
  };
  assert.equal(
    sharedPackage.exports?.["./arc-hosted-auth"],
    "./src/arc-hosted-auth.ts",
  );
  assert.equal(
    sharedPackage.exports?.["./batch-payout"],
    "./src/batch-payout.ts",
  );
  assert.ok(sharedPackage.files?.includes("src/arc-hosted-auth.ts"));
});
