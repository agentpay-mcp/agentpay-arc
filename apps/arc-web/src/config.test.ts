import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicConfig } from "./config.ts";

test("getPublicConfig returns validated public configuration for HTTPS and localhost", () => {
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

  const localConfig = getPublicConfig({
    VITE_ARC_PUBLIC_ORIGIN: "http://localhost:4173",
    VITE_ARC_API_ORIGIN: "http://127.0.0.1:4173",
    VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
    VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
  });
  assert.equal(localConfig.publicOrigin, "http://localhost:4173");
});

test("getPublicConfig throws error when required environment variables are missing", () => {
  assert.throws(
    () => {
      getPublicConfig({});
    },
    (err: Error) => err.message.includes("Missing required public environment variables"),
  );
});

test("getPublicConfig throws error when URL is non-HTTPS or includes user credentials", () => {
  assert.throws(
    () => {
      getPublicConfig({
        VITE_ARC_PUBLIC_ORIGIN: "https://user:pass@arc.agentpay.site",
        VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
        VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
      });
    },
    (err: Error) => err.message.includes("Must be a valid HTTPS URL without embedded user credentials"),
  );

  assert.throws(
    () => {
      getPublicConfig({
        VITE_ARC_PUBLIC_ORIGIN: "http://insecure-domain.com",
        VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
        VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
      });
    },
    (err: Error) => err.message.includes("Must be a valid HTTPS URL without embedded user credentials"),
  );

  assert.throws(
    () => {
      getPublicConfig({
        VITE_ARC_PUBLIC_ORIGIN: "ftp://localhost:4173",
        VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
        VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
      });
    },
    (err: Error) => err.message.includes("Must be a valid HTTPS URL without embedded user credentials"),
  );
});

test("getPublicConfig accepts origins only, without path, query, or fragment", () => {
  for (const publicOrigin of [
    "https://arc.agentpay.site/app",
    "https://arc.agentpay.site?tenant=other",
    "https://arc.agentpay.site/#fragment",
  ]) {
    assert.throws(
      () => getPublicConfig({
        VITE_ARC_PUBLIC_ORIGIN: publicOrigin,
        VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
        VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
      }),
      (err: Error) => err.message.includes("Must be an HTTPS origin without path"),
    );
  }
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

test("getPublicConfig throws error if unapproved VITE_ARC_* environment variable is present", () => {
  for (const key of [
    "VITE_ARC_SECRET_KEY",
    "VITE_ARC_SUPABASE_SERVICE_ROLE_KEY",
    "VITE_ARC_CIRCLE_API_KEY",
  ]) {
    assert.throws(
      () => getPublicConfig({
        VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
        VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
        VITE_ARC_SUPABASE_URL: "https://example.supabase.co",
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "public-key-123",
        [key]: "unapproved-secret",
      } as Record<string, string>),
      (err: Error) => err.message.includes(`Unapproved environment variable ${key}`),
    );
  }
});
