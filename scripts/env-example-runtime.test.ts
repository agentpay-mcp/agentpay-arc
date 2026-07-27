import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseAgentPayEnv } from "../apps/mcp-server/src/runtime/agentpay-runtime.ts";

/**
 * `env-example.test.mjs` compares key NAMES only, so a committed value can be
 * wrong for the runtime and still pass. This suite feeds the committed values
 * through the parser that actually starts the MCP server and asserts none of
 * them is rejected.
 *
 * Blank values are intentional secret placeholders, so "missing" findings are
 * ignored here. Only "invalid" findings — a wrong chain ID, a wrong public URL,
 * a malformed endpoint — fail this test.
 */

function parseEnvExample(contents: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const value = trimmed.slice(separator + 1);
    if (value.length > 0) env[trimmed.slice(0, separator)] = value;
  }

  return env;
}

function invalidNames(env: Record<string, string>): string[] {
  try {
    parseAgentPayEnv(env);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /invalid: ([^)]*)\)/.exec(message);
    if (!match) return [];

    return match[1]
      .split(", ")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }
}

describe(".env.example runtime values", () => {
  it("is accepted by the runtime parser that starts the MCP server", async () => {
    const env = parseEnvExample(await readFile(".env.example", "utf8"));

    assert.deepEqual(
      invalidNames({
        ...env,
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40),
      }),
      [],
      "committed .env.example values must not be rejected by parseAgentPayEnv",
    );
  });

  it("is accepted by the runtime parser in production mode", async () => {
    const env = parseEnvExample(await readFile(".env.example", "utf8"));

    // Production forbids the staging-only Celo aliases; a real operator
    // environment sets the production aliases instead.
    const { CELO_RPC_URL, CELO_SEPOLIA_RPC_URL, ...productionEnv } = env;
    void CELO_RPC_URL;
    void CELO_SEPOLIA_RPC_URL;

    assert.deepEqual(
      invalidNames({
        ...productionEnv,
        AGENTPAY_ENVIRONMENT: "production",
        AGENTPAY_ACCOUNT_VERSION: "v2",
        SUPABASE_PRODUCTION_URL: "https://production.supabase.co",
        SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "p".repeat(40),
      }),
      [],
      "committed .env.example values must not be rejected in production mode",
    );
  });
});
