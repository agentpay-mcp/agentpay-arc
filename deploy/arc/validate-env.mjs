import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_KEYS = Object.freeze([
  "VITE_ARC_PUBLIC_ORIGIN",
  "VITE_ARC_API_ORIGIN",
  "VITE_ARC_SUPABASE_URL",
  "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
]);
const ARTIFACT_MANIFEST_FILE = "arc-artifact-manifest.json";
const ARTIFACT_DIGESTS_KEY = "artifactDigests";
const MANIFEST_SCHEMA_KEYS = Object.freeze([
  ...MANIFEST_KEYS,
  ARTIFACT_DIGESTS_KEY,
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artifactPathForReference(reference, distDir) {
  if (
    reference.length === 0
    || reference.startsWith("#")
    || /^(?:data|mailto|javascript):/i.test(reference)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(reference, "https://arc.agentpay.site/");
  } catch {
    throw new Error(`Artifact reference is not a valid URL: ${reference}`);
  }
  if (parsed.origin !== "https://arc.agentpay.site") {
    return null;
  }

  const decodedPath = decodeURIComponent(parsed.pathname);
  if (decodedPath === "/") {
    return null;
  }
  const artifactPath = resolve(distDir, `.${decodedPath}`);
  if (
    artifactPath !== distDir
    && !artifactPath.startsWith(`${distDir}/`)
  ) {
    throw new Error(`Artifact reference escapes dist: ${reference}`);
  }
  return artifactPath;
}

function arcConfigValuePattern(key) {
  return new RegExp(
    escapeRegExp(key) + "\\s*[:=]\\s*[\"'`]([^\"'`\\r\\n]*)[\"'`]",
    "g",
  );
}

function assertNoUnexpectedArcConfigValues(filePath, content, manifest, distDir) {
  for (const key of MANIFEST_KEYS) {
    for (const match of content.matchAll(arcConfigValuePattern(key))) {
      if (match[1] !== manifest[key]) {
        throw new Error(
          `Artifact file ${filePath.replace(`${distDir}/`, "")} contains an unapproved ${key} value`,
        );
      }
    }
  }
}

async function readServedArtifactFiles(distDir) {
  const indexPath = resolve(distDir, "index.html");
  let indexContent;
  try {
    indexContent = await readFile(indexPath, "utf8");
  } catch {
    throw new Error(`Served artifact is missing ${indexPath}`);
  }

  const servedPaths = new Set([indexPath]);
  const scriptPaths = new Set();
  const referencePattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of indexContent.matchAll(referencePattern)) {
    const artifactPath = artifactPathForReference(match[1], distDir);
    if (artifactPath) {
      servedPaths.add(artifactPath);
    }
  }

  const scriptPattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of indexContent.matchAll(scriptPattern)) {
    const artifactPath = artifactPathForReference(match[1], distDir);
    if (!artifactPath) {
      throw new Error("Served artifact contains a non-local script reference");
    }
    scriptPaths.add(artifactPath);
    servedPaths.add(artifactPath);
  }
  if (scriptPaths.size === 0) {
    throw new Error("Served artifact index.html has no local executable script reference");
  }

  const files = [];
  for (const filePath of servedPaths) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      throw new Error(
        `Served artifact reference is missing: ${filePath.replace(`${distDir}/`, "")}`,
      );
    }
    files.push({ filePath, content });
  }
  return { indexContent, files, scriptPaths };
}

function verifyServedArtifactContent(manifest, servedArtifact) {
  const servedContent = servedArtifact.files.map(({ content }) => content).join("\n");
  for (const key of MANIFEST_KEYS) {
    if (!servedContent.includes(manifest[key])) {
      throw new Error(
        `Manifest value for ${key} (${JSON.stringify(manifest[key])}) was not found in served browser references`,
      );
    }
  }

  const cspMatch = servedArtifact.indexContent.match(
    /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"[^>]*>/i,
  );
  if (!cspMatch) {
    throw new Error("Served artifact index.html is missing its Content-Security-Policy");
  }
  const connectSourceMatch = cspMatch[1].match(
    /(?:^|;)\s*connect-src\s+([^;]+)/i,
  );
  if (!connectSourceMatch) {
    throw new Error("Served artifact Content-Security-Policy is missing connect-src");
  }
  const allowedConnectOrigins = new Set([
    "'self'",
    manifest.VITE_ARC_API_ORIGIN,
    manifest.VITE_ARC_SUPABASE_URL,
  ]);
  const connectSources = connectSourceMatch[1].trim().split(/\s+/);
  for (const source of connectSources) {
    if (/^https?:\/\//i.test(source) && !allowedConnectOrigins.has(source)) {
      throw new Error(
        `Served artifact CSP contains an unapproved connect-src origin: ${source}`,
      );
    }
  }
  for (const requiredOrigin of [
    manifest.VITE_ARC_API_ORIGIN,
    manifest.VITE_ARC_SUPABASE_URL,
  ]) {
    if (!connectSources.includes(requiredOrigin)) {
      throw new Error(
        `Served artifact CSP is missing approved connect-src origin: ${requiredOrigin}`,
      );
    }
  }

  const executableFiles = servedArtifact.files.filter(({ filePath }) =>
    servedArtifact.scriptPaths.has(filePath),
  );
  const hasCompleteExecutableConfig = executableFiles.some(({ content }) =>
    MANIFEST_KEYS.every((key) =>
      [...content.matchAll(arcConfigValuePattern(key))]
        .some((match) => match[1] === manifest[key]),
    ),
  );
  if (!hasCompleteExecutableConfig) {
    throw new Error(
      "Served artifact executable scripts do not contain one complete approved Arc public configuration",
    );
  }
}

async function collectArtifactFiles(distDir, directory = distDir) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectArtifactFiles(distDir, filePath));
      continue;
    }
    if (!entry.isFile() || entry.name === ARTIFACT_MANIFEST_FILE) {
      continue;
    }
    files.push({
      filePath,
      relativePath: relative(distDir, filePath).split(sep).join("/"),
    });
  }
  return files;
}

async function verifyArtifactDigests(distDir, artifactDigests) {
  if (
    artifactDigests === null
    || typeof artifactDigests !== "object"
    || Array.isArray(artifactDigests)
  ) {
    throw new Error("Artifact manifest artifactDigests must be an object");
  }

  const digestEntries = Object.entries(artifactDigests);
  if (digestEntries.length === 0) {
    throw new Error("Artifact manifest artifactDigests must not be empty");
  }
  for (const [relativePath, digest] of digestEntries) {
    if (
      relativePath.length === 0
      || relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.split("/").includes("..")
    ) {
      throw new Error(`Artifact digest path is unsafe: ${relativePath}`);
    }
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new Error(`Artifact digest for ${relativePath} must be SHA-256 hex`);
    }
  }

  const actualFiles = await collectArtifactFiles(distDir);
  const actualByPath = new Map(
    actualFiles.map(({ relativePath, filePath }) => [relativePath, filePath]),
  );
  for (const relativePath of Object.keys(artifactDigests)) {
    if (!actualByPath.has(relativePath)) {
      throw new Error(`Artifact digest references missing file: ${relativePath}`);
    }
  }
  for (const relativePath of actualByPath.keys()) {
    if (!(relativePath in artifactDigests)) {
      throw new Error(`Artifact file is missing a signed digest: ${relativePath}`);
    }
  }

  for (const [relativePath, filePath] of actualByPath) {
    const actualDigest = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
    if (actualDigest !== artifactDigests[relativePath]) {
      throw new Error(`Artifact digest mismatch for ${relativePath}`);
    }
  }
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
    if (!MANIFEST_SCHEMA_KEYS.includes(key)) {
      throw new Error(
        `Artifact manifest contains unexpected key: ${key}`,
      );
    }
  }
  if (manifestKeys.length !== MANIFEST_SCHEMA_KEYS.length) {
    throw new Error(
      `Artifact manifest must have exactly ${MANIFEST_SCHEMA_KEYS.length} keys, got ${manifestKeys.length}`,
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
  await verifyArtifactDigests(distDir, manifest[ARTIFACT_DIGESTS_KEY]);
  await verifyArtifactDistFiles(distDir, manifest);
}

async function scanArtifactDistFiles(
  distDir,
  manifest,
  foundValues,
) {
  const placeholderPattern = /%VITE_ARC_[A-Z_]+%/;

  const entries = await readdir(distDir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = resolve(distDir, entry.name);
    if (entry.isDirectory()) {
      await scanArtifactDistFiles(filePath, manifest, foundValues);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === ARTIFACT_MANIFEST_FILE) {
      continue;
    }

    const content = await readFile(filePath, "utf8");

    if (placeholderPattern.test(content)) {
      throw new Error(
        `Artifact dist file ${filePath.replace(distDir + "/", "")} contains unresolved VITE_ARC_ placeholder`,
      );
    }

    assertNoUnexpectedArcConfigValues(filePath, content, manifest, distDir);

    for (const key of MANIFEST_KEYS) {
      const value = manifest[key];
      if (typeof value === "string" && value.length > 0) {
        if (content.includes(value)) {
          foundValues[key] = true;
        }
      }
    }
  }
}

async function verifyArtifactDistFiles(
  distDir,
  manifest,
) {
  const foundValues = {};
  await scanArtifactDistFiles(distDir, manifest, foundValues);

  for (const key of MANIFEST_KEYS) {
    if (!foundValues[key]) {
      throw new Error(
        `Manifest value for ${key} (${JSON.stringify(manifest[key])}) was not found in any artifact file`,
      );
    }
  }

  const servedArtifact = await readServedArtifactFiles(distDir);
  verifyServedArtifactContent(manifest, servedArtifact);
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
