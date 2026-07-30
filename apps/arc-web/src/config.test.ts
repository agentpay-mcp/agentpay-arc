import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicConfig } from "./config.ts";

test("getPublicConfig returns validated public configuration", () => {
  const config = getPublicConfig({
    VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
    VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
    VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
    VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
  });

  assert.equal(config.publicOrigin, "https://arc.agentpay.site");
  assert.equal(config.apiOrigin, "https://mcp.arc.agentpay.site");
  assert.equal(config.supabaseUrl, "https://example.supabase.co");
  assert.equal(config.supabasePublishableKey, "public-key-123");
});

test("getPublicConfig handles fallback values when env is empty", () => {
  const config = getPublicConfig({});
  assert.equal(config.publicOrigin, "https://arc.agentpay.site");
  assert.equal(config.apiOrigin, "https://mcp.arc.agentpay.site");
  assert.equal(config.supabaseUrl, "https://fake-project.supabase.co");
  assert.equal(config.supabasePublishableKey, "fake-publishable-key-for-tests");
});

test("getPublicConfig throws error if ARC_CIRCLE_API_KEY is exposed", () => {
  assert.throws(
    () => {
      getPublicConfig({
        ARC_CIRCLE_API_KEY: "secret-key",
      } as unknown as Record<string, string>);
    },
    (err: Error) => err.message.includes("ARC_CIRCLE_API_KEY"),
  );
});

test("getPublicConfig throws error if ARC_SUPABASE_SERVICE_ROLE_KEY is exposed", () => {
  assert.throws(
    () => {
      getPublicConfig({
        ARC_SUPABASE_SERVICE_ROLE_KEY: "service-key",
      } as unknown as Record<string, string>);
    },
    (err: Error) => err.message.includes("ARC_SUPABASE_SERVICE_ROLE_KEY"),
  );
});

test("getPublicConfig throws error if ARC_CIRCLE_ENTITY_SECRET is exposed", () => {
  assert.throws(
    () => {
      getPublicConfig({
        ARC_CIRCLE_ENTITY_SECRET: "entity-secret",
      } as unknown as Record<string, string>);
    },
    (err: Error) => err.message.includes("ARC_CIRCLE_ENTITY_SECRET"),
  );
});
