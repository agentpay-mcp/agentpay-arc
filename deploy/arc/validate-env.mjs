import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_KEYS = Object.freeze([
  "VITE_ARC_PUBLIC_ORIGIN",
  "VITE_ARC_API_ORIGIN",
  "VITE_ARC_SUPABASE_URL",
  "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
]);

const PUBLIC_ORIGIN = "https://arc.agentpay.site";
const API_ORIGIN = "https://mcp.arc.agentpay.site";
const MCP_RESOURCE_URL = "https://mcp.arc.agentpay.site/mcp";
const MCP_HOST = "127.0.0.1";
const MCP_PORT = "3002";

const WEB_KEYS = Object.freeze([
  "VITE_ARC_PUBLIC_ORIGIN",
  "VITE_ARC_API_ORIGIN",
  "VITE_ARC_SUPABASE_URL",
  "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
]);

const MCP_KEYS = Object.freeze([
  "ARC_PUBLIC_ORIGIN",
  "ARC_MCP_RESOURCE_URL",
  "ARC_MCP_ALLOWED_ORIGINS",
  "ARC_SUPABASE_URL",
  "ARC_SUPABASE_AUTH_ISSUER",
  "ARC_SUPABASE_PUBLISHABLE_KEY",
  "ARC_SUPABASE_SERVICE_ROLE_KEY",
  "ARC_CIRCLE_API_KEY",
  "ARC_CIRCLE_ENTITY_SECRET",
  "ARC_MCP_HOST",
  "ARC_MCP_PORT",
]);

const APPROVED_KEYS = new Set([...WEB_KEYS, ...MCP_KEYS]);

function requiredValue(env, key, minimumLength = 1) {
  const value = env[key]?.trim();
  if (
    value === undefined
    || value.length < minimumLength
    || value.length > 8_192
    || value.includes("\0")
  ) {
    throw new Error(`${key} is required and invalid`);
  }
  return value;
}

function credentialFreeHttpsUrl(value, key, expectedPathname) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== expectedPathname
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(
      `${key} must be credential-free HTTPS with pathname ${expectedPathname}`,
    );
  }
  return parsed;
}

function rejectUnapprovedEnvironment(scope, env) {
  const permittedScopeKeys = new Set(scope === "web" ? WEB_KEYS : MCP_KEYS);
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith("ARC_") || key.startsWith("VITE_ARC_"))
      && !APPROVED_KEYS.has(key)
    ) {
      throw new Error(`Found unapproved Arc environment variable: ${key}`);
    }
    if (
      APPROVED_KEYS.has(key)
      && !permittedScopeKeys.has(key)
    ) {
      throw new Error(
        `Found ${scope === "web" ? "server" : "browser"} Arc environment variable in ${scope} scope: ${key}`,
      );
    }
    if (
      /^(?:AGENTPAY_|SUPABASE_|CIRCLE_)/.test(key)
      || /(?:^|_)RPC_URL$/.test(key)
    ) {
      throw new Error(`Found cross-product environment variable: ${key}`);
    }
  }
}

function validateWebEnvironment(env) {
  const publicOrigin = credentialFreeHttpsUrl(
    requiredValue(env, "VITE_ARC_PUBLIC_ORIGIN"),
    "VITE_ARC_PUBLIC_ORIGIN",
    "/",
  );
  const apiOrigin = credentialFreeHttpsUrl(
    requiredValue(env, "VITE_ARC_API_ORIGIN"),
    "VITE_ARC_API_ORIGIN",
    "/",
  );
  const supabaseUrl = credentialFreeHttpsUrl(
    requiredValue(env, "VITE_ARC_SUPABASE_URL"),
    "VITE_ARC_SUPABASE_URL",
    "/",
  );
  if (publicOrigin.origin !== PUBLIC_ORIGIN) {
    throw new Error(`VITE_ARC_PUBLIC_ORIGIN must be ${PUBLIC_ORIGIN}`);
  }
  if (apiOrigin.origin !== API_ORIGIN) {
    throw new Error(`VITE_ARC_API_ORIGIN must be ${API_ORIGIN}`);
  }

  return Object.freeze({
    VITE_ARC_PUBLIC_ORIGIN: publicOrigin.origin,
    VITE_ARC_API_ORIGIN: apiOrigin.origin,
    VITE_ARC_SUPABASE_URL: supabaseUrl.origin,
    VITE_ARC_SUPABASE_PUBLISHABLE_KEY: requiredValue(
      env,
      "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
      16,
    ),
  });
}

function validateMcpEnvironment(env) {
  const publicOrigin = credentialFreeHttpsUrl(
    requiredValue(env, "ARC_PUBLIC_ORIGIN"),
    "ARC_PUBLIC_ORIGIN",
    "/",
  );
  const resourceUrl = credentialFreeHttpsUrl(
    requiredValue(env, "ARC_MCP_RESOURCE_URL"),
    "ARC_MCP_RESOURCE_URL",
    "/mcp",
  );
  const supabaseUrl = credentialFreeHttpsUrl(
    requiredValue(env, "ARC_SUPABASE_URL"),
    "ARC_SUPABASE_URL",
    "/",
  );
  const authIssuer = credentialFreeHttpsUrl(
    requiredValue(env, "ARC_SUPABASE_AUTH_ISSUER"),
    "ARC_SUPABASE_AUTH_ISSUER",
    "/auth/v1",
  );
  if (publicOrigin.origin !== PUBLIC_ORIGIN) {
    throw new Error(`ARC_PUBLIC_ORIGIN must be ${PUBLIC_ORIGIN}`);
  }
  if (resourceUrl.toString() !== MCP_RESOURCE_URL) {
    throw new Error(`ARC_MCP_RESOURCE_URL must be ${MCP_RESOURCE_URL}`);
  }
  if (requiredValue(env, "ARC_MCP_ALLOWED_ORIGINS") !== PUBLIC_ORIGIN) {
    throw new Error(`ARC_MCP_ALLOWED_ORIGINS must be ${PUBLIC_ORIGIN}`);
  }
  if (authIssuer.origin !== supabaseUrl.origin) {
    throw new Error(
      "ARC_SUPABASE_AUTH_ISSUER must use the ARC_SUPABASE_URL origin",
    );
  }
  if (requiredValue(env, "ARC_MCP_HOST") !== MCP_HOST) {
    throw new Error(`ARC_MCP_HOST must be ${MCP_HOST}`);
  }
  if (requiredValue(env, "ARC_MCP_PORT") !== MCP_PORT) {
    throw new Error(`ARC_MCP_PORT must be ${MCP_PORT}`);
  }

  const publishableKey = requiredValue(
    env,
    "ARC_SUPABASE_PUBLISHABLE_KEY",
    16,
  );
  const serviceRoleKey = requiredValue(
    env,
    "ARC_SUPABASE_SERVICE_ROLE_KEY",
    20,
  );
  const circleApiKey = requiredValue(env, "ARC_CIRCLE_API_KEY", 20);
  const circleEntitySecret = requiredValue(
    env,
    "ARC_CIRCLE_ENTITY_SECRET",
    64,
  );
  if (!/^[a-fA-F0-9]{64}$/.test(circleEntitySecret)) {
    throw new Error("ARC_CIRCLE_ENTITY_SECRET must be a 32-byte hex value");
  }
  if (
    publishableKey === serviceRoleKey
    || circleApiKey === circleEntitySecret
  ) {
    throw new Error("Arc public and secret credentials must be distinct");
  }

  return Object.freeze({
    ARC_PUBLIC_ORIGIN: publicOrigin.origin,
    ARC_MCP_RESOURCE_URL: resourceUrl.toString(),
    ARC_MCP_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
    ARC_SUPABASE_URL: supabaseUrl.origin,
    ARC_SUPABASE_AUTH_ISSUER: authIssuer.toString(),
    ARC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    ARC_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    ARC_CIRCLE_API_KEY: circleApiKey,
    ARC_CIRCLE_ENTITY_SECRET: circleEntitySecret,
    ARC_MCP_HOST: MCP_HOST,
    ARC_MCP_PORT: MCP_PORT,
  });
}

export async function verifyArtifactManifest(
  env,
  artifactManifestPath,
) {
  let manifestContent;
  try {
    manifestContent = await readFile(artifactManifestPath, "utf8");
  } catch {
    throw new Error(
      `Artifact manifest not found at ${artifactManifestPath}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new Error(
      `Artifact manifest at ${artifactManifestPath} is not valid JSON`,
    );
  }
  const manifestKeys = Object.keys(manifest);
  for (const key of manifestKeys) {
    if (!MANIFEST_KEYS.includes(key)) {
      throw new Error(
        `Artifact manifest contains unexpected key: ${key}`,
      );
    }
  }
  if (manifestKeys.length !== MANIFEST_KEYS.length) {
    throw new Error(
      `Artifact manifest must have exactly ${MANIFEST_KEYS.length} keys, got ${manifestKeys.length}`,
    );
  }
  for (const key of MANIFEST_KEYS) {
    if (!(key in manifest)) {
      throw new Error(
        `Artifact manifest is missing required key: ${key}`,
      );
    }
    const expected = manifest[key];
    if (typeof expected !== "string" || expected.trim().length === 0) {
      throw new Error(
        `Artifact manifest ${key} must be a non-empty string`,
      );
    }
    const actual = env[key]?.trim();
    if (actual !== expected) {
      throw new Error(
        `Artifact manifest ${key} mismatch: manifest has ${JSON.stringify(expected)}, runtime has ${JSON.stringify(actual)}`,
      );
    }
  }

  const distDir = resolve(dirname(artifactManifestPath));
  await verifyArtifactDistFiles(distDir, manifest);
}

async function verifyArtifactDistFiles(
  distDir,
  manifest,
) {
  const placeholderPattern = /%VITE_ARC_[A-Z_]+%/;
  const distFiles = await readdir(distDir, { withFileTypes: true });
  for (const entry of distFiles) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = resolve(distDir, entry.name);
    const content = await readFile(filePath, "utf8");

    if (placeholderPattern.test(content)) {
      throw new Error(
        `Artifact dist file ${entry.name} contains unresolved VITE_ARC_ placeholder`,
      );
    }

    for (const key of MANIFEST_KEYS) {
      const value = manifest[key];
      if (typeof value === "string" && value.length > 0) {
        if (!content.includes(value)) {
          throw new Error(
            `Artifact dist file ${entry.name} does not contain manifest value for ${key} (${JSON.stringify(value)})`,
          );
        }
      }
    }
  }
}

export function validateArcDeploymentEnvironment(scope, env) {
  if (scope !== "web" && scope !== "mcp") {
    throw new Error("Deployment scope must be web or mcp");
  }
  rejectUnapprovedEnvironment(scope, env);
  if (scope === "web") {
    return validateWebEnvironment(env);
  }
  return validateMcpEnvironment(env);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  const scope = process.argv[2];
  let artifactManifestPath;
  if (scope === "web") {
    artifactManifestPath =
      process.argv[3]
        ?? resolve(process.env.ARC_ARTIFACT_MANIFEST_PATH ?? "./dist/arc-artifact-manifest.json");
  }
  try {
    await validateArcDeploymentEnvironment(scope, process.env);
    if (artifactManifestPath) {
      await verifyArtifactManifest(process.env, artifactManifestPath);
    }
    process.stdout.write(
      `${JSON.stringify({ event: "arc_config_valid", scope, verifiedArtifacts: Boolean(artifactManifestPath) })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "arc_config_invalid",
        error: error instanceof Error ? error.message : "Invalid configuration",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
