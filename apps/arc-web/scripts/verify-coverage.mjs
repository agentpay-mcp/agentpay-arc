import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MINIMUM_BRANCH_COVERAGE = 80;
const REQUIRED_MODULES = [
  "api.ts",
  "App.tsx",
  "AuthForm.tsx",
  "ConsentModal.tsx",
  "Dashboard.tsx",
  "OAuthConsent.tsx",
  "config.ts",
  "supabase.ts",
  "withdrawal.ts",
];

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const testFiles = readdirSync(sourceRoot)
  .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))
  .map((name) => `src/${name}`);

const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--experimental-test-coverage",
  ...testFiles,
], {
  cwd: appRoot,
  encoding: "utf8",
  env: process.env,
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const lines = output.split(/\r?\n/);
const failures = [];
for (const moduleName of REQUIRED_MODULES) {
  const row = lines.find((line) => line.includes(moduleName) && line.includes("|"));
  if (!row) {
    failures.push(`${moduleName}: coverage row missing`);
    continue;
  }
  const columns = row.split("|").map((column) => column.trim());
  const branchCoverage = Number.parseFloat(columns[2] ?? "");
  if (!Number.isFinite(branchCoverage) || branchCoverage < MINIMUM_BRANCH_COVERAGE) {
    failures.push(`${moduleName}: ${columns[2] ?? "unknown"}% branch coverage`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `\nPer-module branch coverage must be at least ${MINIMUM_BRANCH_COVERAGE}%:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}
