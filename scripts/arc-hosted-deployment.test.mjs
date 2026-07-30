import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const deploymentFiles = Object.freeze({
  readme: "deploy/arc/README.md",
  rollback: "deploy/arc/ROLLBACK.md",
  validator: "deploy/arc/validate-env.mjs",
  manifestGenerator: "deploy/arc/generate-artifact-manifest.mjs",
  staticServer: "deploy/arc/static-server.mjs",
  webEnv: "deploy/arc/env/web.env.example",
  mcpEnv: "deploy/arc/env/mcp.env.example",
  webService: "deploy/arc/systemd/agentpay-arc-web.service",
  mcpService: "deploy/arc/systemd/agentpay-arc-mcp.service",
  logrotate: "deploy/arc/logrotate/agentpay-arc",
  nginx: "deploy/arc/nginx/agentpay-arc.conf",
});

const validMcpEnv = Object.freeze({
  ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
  ARC_MCP_RESOURCE_URL: "https://mcp.arc.agentpay.site/mcp",
  ARC_MCP_ALLOWED_ORIGINS: "https://arc.agentpay.site",
  ARC_SUPABASE_URL: "https://project-ref.supabase.co",
  ARC_SUPABASE_AUTH_ISSUER: "https://project-ref.supabase.co/auth/v1",
  ARC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake_test_value",
  ARC_SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-value-with-32-bytes",
  ARC_CIRCLE_API_KEY: "fake-circle-api-key-with-32-bytes",
  ARC_CIRCLE_ENTITY_SECRET: "f".repeat(64),
  ARC_MCP_HOST: "127.0.0.1",
  ARC_MCP_PORT: "3002",
});

const validWebEnv = Object.freeze({
  VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
  VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
  VITE_ARC_SUPABASE_URL: "https://project-ref.supabase.co",
  VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake_test_value",
});

async function loadDeploymentFiles() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(deploymentFiles).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
}

describe("Arc-only hosted deployment artifacts", () => {
  it("ships the complete reproducible surface without cross-product references", async () => {
    const files = await loadDeploymentFiles();
    const forbiddenProduct = new RegExp(["ce", "lo"].join(""), "i");
    const forbiddenRepository = new RegExp(
      ["agentpay", "ce", "lo"].join("-"),
      "i",
    );

    for (const [name, content] of Object.entries(files)) {
      assert.ok(content.trim().length > 0, `${name} must not be empty`);
      assert.doesNotMatch(
        content,
        forbiddenProduct,
        `${name} must remain Arc-only`,
      );
      assert.doesNotMatch(content, forbiddenRepository);
      assert.doesNotMatch(content, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
      assert.doesNotMatch(content, /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/);
    }
  });

  it("isolates web and MCP systemd services on exact loopback listeners", async () => {
    const { webService, mcpService, logrotate } = await loadDeploymentFiles();

    assert.match(webService, /^User=agentpay-arc-web$/m);
    assert.match(webService, /^Group=agentpay-arc-web$/m);
    assert.match(
      webService,
      /^EnvironmentFile=\/etc\/agentpay-arc\/web\.env$/m,
    );
    assert.match(
      webService,
      /validate-env\.mjs web[\s\S]*static-server\.mjs --host 127\.0\.0\.1 --port 3001/,
    );
    assert.match(
      webService,
      /arc-artifact-manifest\.json/,
    );
    assert.match(webService, /^SocketBindAllow=tcp:3001$/m);
    assert.match(webService, /^NoNewPrivileges=true$/m);
    assert.match(webService, /^ProtectSystem=strict$/m);
    assert.match(webService, /^Restart=on-failure$/m);
    assert.match(webService, /^RestartSec=5$/m);
    assert.match(webService, /^TimeoutStartSec=30$/m);
    assert.match(webService, /127\.0\.0\.1:3001\/healthz/);
    assert.doesNotMatch(webService, /^Environment=.*(?:KEY|SECRET|TOKEN)=/m);

    assert.match(mcpService, /^User=agentpay-arc-mcp$/m);
    assert.match(mcpService, /^Group=agentpay-arc-mcp$/m);
    assert.match(
      mcpService,
      /^EnvironmentFile=\/etc\/agentpay-arc\/mcp\.env$/m,
    );
    assert.match(mcpService, /validate-env\.mjs mcp/);
    assert.match(
      mcpService,
      /npm run start:hosted-arc --workspace apps\/mcp-server/,
    );
    assert.match(mcpService, /^SocketBindAllow=tcp:3002$/m);
    assert.match(mcpService, /^NoNewPrivileges=true$/m);
    assert.match(mcpService, /^ProtectSystem=strict$/m);
    assert.match(mcpService, /^Restart=on-failure$/m);
    assert.match(mcpService, /^RestartSec=5$/m);
    assert.match(mcpService, /^TimeoutStartSec=45$/m);
    assert.match(mcpService, /127\.0\.0\.1:3002\/healthz/);
	    assert.match(
	      mcpService,
	      /Host: mcp\.arc\.agentpay\.site/,
	    );
    assert.doesNotMatch(mcpService, /^Environment=.*(?:KEY|SECRET|TOKEN)=/m);

    assert.match(
      logrotate,
      /^\/var\/log\/agentpay-arc\/\*\.jsonl \/var\/log\/agentpay-arc\/\*\.log \{$/m,
    );
    assert.match(logrotate, /^\s+rotate 14$/m);
    assert.match(logrotate, /^\s+maxsize 32M$/m);
    assert.match(logrotate, /^\s+compress$/m);
  });

  it("routes only the two exact TLS hosts to the intended loopback service", async () => {
    const { nginx } = await loadDeploymentFiles();

    assert.match(nginx, /server_name arc\.agentpay\.site;/);
    assert.match(nginx, /server_name mcp\.arc\.agentpay\.site;/);
    assert.equal((nginx.match(/listen 443 ssl http2;/g) ?? []).length, 2);
    assert.match(
      nginx,
      /return 308 https:\/\/arc\.agentpay\.site\$request_uri;/,
    );
    assert.match(
      nginx,
      /return 308 https:\/\/mcp\.arc\.agentpay\.site\$request_uri;/,
    );
    assert.match(
      nginx,
      /if \(\$host != arc\.agentpay\.site\) \{ return 421; \}/,
    );
    assert.match(
      nginx,
      /if \(\$host != mcp\.arc\.agentpay\.site\) \{ return 421; \}/,
    );
    assert.match(
      nginx,
      /server_name arc\.agentpay\.site;[\s\S]*location \^~ \/api\/ \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3002;/,
    );
    assert.match(
      nginx,
      /server_name arc\.agentpay\.site;[\s\S]*location \/ \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3001;/,
    );
    assert.match(
      nginx,
      /server_name mcp\.arc\.agentpay\.site;[\s\S]*location = \/mcp \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3002\/mcp;/,
    );
    assert.match(
      nginx,
      /server_name mcp\.arc\.agentpay\.site;[\s\S]*location \^~ \/api\/ \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3002;/,
    );
    assert.doesNotMatch(nginx, /default_server|\bserver_name\s+_|proxy_pass\s+https?:\/\/(?!127\.0\.0\.1)/);
    assert.doesNotMatch(nginx, /\$http_authorization|\$request_body/);
  });

  it("keeps public and server environment contracts separate and complete", async () => {
    const { webEnv, mcpEnv } = await loadDeploymentFiles();
    const rootEnv = await readFile(".env.example", "utf8");
    const arcBlock = rootEnv.match(
      /# BEGIN ARC HOSTED\n(?<body>[\s\S]*?)# END ARC HOSTED/,
    )?.groups?.body;

    assert.ok(arcBlock, "root .env.example must contain a bounded Arc block");
    for (const assignment of arcBlock.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
      assert.equal(
        assignment[2],
        "",
        `${assignment[1]} must be name-only in the root example`,
      );
    }
    for (const key of Object.keys(validWebEnv)) {
      assert.match(webEnv, new RegExp(`^${key}=`, "m"));
      assert.match(arcBlock, new RegExp(`^${key}=`, "m"));
      assert.doesNotMatch(mcpEnv, new RegExp(`^${key}=`, "m"));
    }
    for (const key of Object.keys(validMcpEnv)) {
      assert.match(mcpEnv, new RegExp(`^${key}=`, "m"));
      assert.match(arcBlock, new RegExp(`^${key}=`, "m"));
      assert.doesNotMatch(webEnv, new RegExp(`^${key}=`, "m"));
    }
    assert.doesNotMatch(webEnv, /SERVICE_ROLE|CIRCLE|ENTITY_SECRET/);
    assert.match(mcpEnv, /^ARC_SUPABASE_SERVICE_ROLE_KEY=$/m);
    assert.match(mcpEnv, /^ARC_CIRCLE_API_KEY=$/m);
    assert.match(mcpEnv, /^ARC_CIRCLE_ENTITY_SECRET=$/m);
  });

  it("fails closed on missing, unsafe, or cross-product environment values", async () => {
    const { validateArcDeploymentEnvironment } = await import(
      "../deploy/arc/validate-env.mjs"
    );

    const mcp = validateArcDeploymentEnvironment("mcp", validMcpEnv);
    const web = validateArcDeploymentEnvironment("web", validWebEnv);
    assert.deepEqual(Object.keys(mcp).sort(), Object.keys(validMcpEnv).sort());
    assert.deepEqual(Object.keys(web).sort(), Object.keys(validWebEnv).sort());
    assert.ok(Object.isFrozen(mcp));
    assert.ok(Object.isFrozen(web));

    assert.throws(
      () => validateArcDeploymentEnvironment("mcp", {
        ...validMcpEnv,
        ARC_CIRCLE_API_KEY: "",
      }),
      /ARC_CIRCLE_API_KEY/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("mcp", {
        ...validMcpEnv,
        ARC_MCP_HOST: "0.0.0.0",
      }),
      /ARC_MCP_HOST/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("mcp", {
        ...validMcpEnv,
        ARC_SUPABASE_AUTH_ISSUER: "https://foreign.supabase.co/auth/v1",
      }),
      /ARC_SUPABASE_AUTH_ISSUER/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("mcp", {
        ...validMcpEnv,
        LEGACY_RPC_URL: "https://example.invalid",
      }),
      /cross-product environment variable/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("web", {
        ...validWebEnv,
        VITE_ARC_CIRCLE_API_KEY: "not-public",
      }),
      /unapproved Arc environment variable/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("web", {
        ...validWebEnv,
        ARC_SUPABASE_SERVICE_ROLE_KEY: "must-not-reach-browser-scope",
      }),
      /server Arc environment variable in web scope/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("mcp", {
        ...validMcpEnv,
        VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "must-not-reach-server-scope",
      }),
      /browser Arc environment variable in mcp scope/,
    );
    assert.throws(
      () => validateArcDeploymentEnvironment("web", {
        ...validWebEnv,
        VITE_ARC_API_ORIGIN: "https://arc.agentpay.site",
      }),
      /VITE_ARC_API_ORIGIN/,
    );
  });

  it("serves static assets safely and never logs URL query secrets", async () => {
    const { startArcStaticServer } = await import(
      "../deploy/arc/static-server.mjs"
    );
    const root = await mkdtemp(join(tmpdir(), "agentpay-arc-static-"));
    await writeFile(join(root, "index.html"), "<main>Arc</main>");
    await writeFile(join(root, "app.js"), "console.log('arc');");
    const logs = [];
    const server = await startArcStaticServer({
      host: "127.0.0.1",
      port: 0,
      root: await realpath(root),
      logger(entry) {
        logs.push(entry);
      },
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const index = await fetch(
        `${origin}/oauth/consent?authorization_id=never-log-this`,
      );
      const asset = await fetch(`${origin}/app.js`);
      const health = await fetch(`${origin}/healthz`);
      const traversal = await fetch(`${origin}/..%2f..%2fetc%2fpasswd`);
      const method = await fetch(`${origin}/`, { method: "POST" });

      assert.equal(index.status, 200);
      assert.equal(await index.text(), "<main>Arc</main>");
      assert.equal(index.headers.get("cache-control"), "no-store");
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
      assert.deepEqual(await health.json(), { status: "ok" });
      assert.equal(traversal.status, 404);
      assert.equal(method.status, 405);
      assert.match(index.headers.get("x-content-type-options") ?? "", /nosniff/);
      assert.doesNotMatch(JSON.stringify(logs), /never-log-this/);
      assert.match(JSON.stringify(logs), /"path":"\/oauth\/consent"/);
    } finally {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
    }
  });

  it("generates and verifies the artifact manifest from the Vite build environment", async () => {
    const { writeFile, mkdtemp, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir = await mkdtemp(join(tmpdir(), "arc-artifact-test-"));
    const manifestPath = join(tmpDir, "arc-artifact-manifest.json");

    const testEnv = {
      VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
      VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
      VITE_ARC_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake_key",
    };

    const originalEnv = { ...process.env };
    Object.assign(process.env, testEnv);

    try {
      const { generateArtifactManifest } = await import(
        "../deploy/arc/generate-artifact-manifest.mjs"
      );
      const distFilePath = join(tmpDir, "index.html");
      await mkdir(join(tmpDir, "assets"), { recursive: true });
      await writeFile(
        distFilePath,
        `<html><head><base href="${testEnv.VITE_ARC_PUBLIC_ORIGIN}/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${testEnv.VITE_ARC_API_ORIGIN} ${testEnv.VITE_ARC_SUPABASE_URL};" /><meta name="api-origin" content="${testEnv.VITE_ARC_API_ORIGIN}" /></head><body><main>Arc</main><script type="module" src="/assets/bundle.js"></script></body></html>`,
      );
      await writeFile(
        join(tmpDir, "assets", "bundle.js"),
        `const config = { VITE_ARC_PUBLIC_ORIGIN: "${testEnv.VITE_ARC_PUBLIC_ORIGIN}", VITE_ARC_API_ORIGIN: "${testEnv.VITE_ARC_API_ORIGIN}", VITE_ARC_SUPABASE_URL: "${testEnv.VITE_ARC_SUPABASE_URL}", VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "${testEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY}" };`,
      );
      const manifest = await generateArtifactManifest(tmpDir);
      assert.ok(manifest);
      assert.equal(manifest.VITE_ARC_PUBLIC_ORIGIN, testEnv.VITE_ARC_PUBLIC_ORIGIN);
      assert.equal(manifest.VITE_ARC_API_ORIGIN, testEnv.VITE_ARC_API_ORIGIN);
      assert.equal(manifest.VITE_ARC_SUPABASE_URL, testEnv.VITE_ARC_SUPABASE_URL);
      assert.equal(
        manifest.VITE_ARC_SUPABASE_PUBLISHABLE_KEY,
        testEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY,
      );
      assert.equal(Object.keys(manifest).length, 5);
      assert.deepEqual(Object.keys(manifest.artifactDigests).sort(), [
        "assets/bundle.js",
        "index.html",
      ]);
      await writeFile(manifestPath, JSON.stringify(manifest));

      const { verifyArtifactManifest } = await import(
        "../deploy/arc/validate-env.mjs"
      );
      await verifyArtifactManifest(process.env, manifestPath);

      const extraManifestDir = join(tmpDir, "extra-test");
      await mkdir(extraManifestDir, { recursive: true });

      const extraManifestPath = join(extraManifestDir, "extra-keys.json");
      await writeFile(
        extraManifestPath,
        JSON.stringify({ ...manifest, EXTRA_KEY: "should-be-rejected" }),
      );
      await assert.rejects(
        verifyArtifactManifest(process.env, extraManifestPath),
        /unexpected key/,
      );

      const emptyManifestPath = join(extraManifestDir, "empty.json");
      await writeFile(emptyManifestPath, "{}");
      await assert.rejects(
        verifyArtifactManifest(process.env, emptyManifestPath),
        /exactly 5 keys/,
      );

      const partialManifestPath = join(extraManifestDir, "partial.json");
      await writeFile(
        partialManifestPath,
        JSON.stringify({ VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site" }),
      );
      await assert.rejects(
        verifyArtifactManifest(process.env, partialManifestPath),
        /exactly 5 keys/,
      );

      const distWithPlaceholder = join(tmpDir, "app.js");
      await writeFile(
        distWithPlaceholder,
        "const apiOrigin = '%VITE_ARC_API_ORIGIN%';",
      );
      await writeFile(
        manifestPath,
        JSON.stringify(await generateArtifactManifest(tmpDir)),
      );
      await assert.rejects(
        verifyArtifactManifest(
          process.env,
          manifestPath,
        ),
        /unresolved VITE_ARC_ placeholder/,
      );

      const { rm } = await import("node:fs/promises");

      const noValueDir = await mkdtemp(join(tmpdir(), "arc-no-value-"));
      const noValueManifest = join(noValueDir, "arc-artifact-manifest.json");
      await writeFile(noValueManifest, JSON.stringify(manifest));
      await writeFile(
        join(noValueDir, "empty.txt"),
        "no manifest values here",
      );
      await assert.rejects(
        verifyArtifactManifest(process.env, noValueManifest),
        /Artifact digest|was not found in any artifact file/,
      );
      await rm(noValueDir, { recursive: true });

      await rm(distWithPlaceholder);
      await rm(distFilePath);
      await rm(extraManifestDir, { recursive: true });

      await mkdir(join(tmpDir, "assets"), { recursive: true });
      await writeFile(
        join(tmpDir, "assets", "bundle.js"),
        `const config = { VITE_ARC_PUBLIC_ORIGIN: "${testEnv.VITE_ARC_PUBLIC_ORIGIN}", VITE_ARC_API_ORIGIN: "${testEnv.VITE_ARC_API_ORIGIN}", VITE_ARC_SUPABASE_URL: "${testEnv.VITE_ARC_SUPABASE_URL}", VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "${testEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY}" };`,
      );
      await writeFile(
        join(tmpDir, "index.html"),
        `<html><head><base href="${testEnv.VITE_ARC_PUBLIC_ORIGIN}/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${testEnv.VITE_ARC_API_ORIGIN} ${testEnv.VITE_ARC_SUPABASE_URL};"></head><body><script type="module" src="/assets/bundle.js"></script></body></html>`,
      );
      const refreshedManifest = await generateArtifactManifest(tmpDir);
      await writeFile(manifestPath, JSON.stringify(refreshedManifest));
      await verifyArtifactManifest(process.env, manifestPath);

      const attackerDistDir = join(tmpDir, "attacker-dist");
      await mkdir(attackerDistDir, { recursive: true });
      await writeFile(
        join(attackerDistDir, "arc-artifact-manifest.json"),
        JSON.stringify(manifest),
      );
      await writeFile(
        join(attackerDistDir, "index.html"),
        `<html><head><meta http-equiv="Content-Security-Policy" content="connect-src ${testEnv.VITE_ARC_SUPABASE_URL};" /></head><body><script>const api = "https://attacker.invalid";</script></body></html>`,
      );
      await assert.rejects(
        verifyArtifactManifest(process.env, join(attackerDistDir, "arc-artifact-manifest.json")),
        /Artifact digest|was not found in any artifact file/,
      );
    } finally {
      process.env = originalEnv;
    }
  });

  it("rejects a poisoned real Vite build even when its safe manifest and decoy are restored", async () => {
    const { copyFile, mkdir } = await import("node:fs/promises");
    const repoRoot = resolve(".");
    const distDir = resolve("apps/arc-web/dist");
    const safeManifestBackup = await mkdtemp(join(tmpdir(), "arc-safe-manifest-"));
    const safeManifestPath = join(safeManifestBackup, "arc-artifact-manifest.json");
    const testEnv = {
      VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
      VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
      VITE_ARC_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_real_build_test_key",
    };

    const buildEnvironment = {
      ...process.env,
      ...testEnv,
    };
    const runBuild = (apiOrigin) => spawnSync(
      "npm",
      ["run", "build", "--workspace", "apps/arc-web"],
      {
        cwd: repoRoot,
        env: { ...buildEnvironment, VITE_ARC_API_ORIGIN: apiOrigin },
        encoding: "utf8",
      },
    );
    const runExactWebValidation = () => spawnSync(
      process.execPath,
      [
        "deploy/arc/validate-env.mjs",
        "web",
        "apps/arc-web/dist/arc-artifact-manifest.json",
      ],
      {
        cwd: repoRoot,
        env: buildEnvironment,
        encoding: "utf8",
      },
    );

    await rm(distDir, { recursive: true, force: true });
    try {
      const safeBuild = runBuild(testEnv.VITE_ARC_API_ORIGIN);
      assert.equal(
        safeBuild.status,
        0,
        `safe real Vite build failed:\n${safeBuild.stdout}\n${safeBuild.stderr}`,
      );
      await copyFile(
        join(distDir, "arc-artifact-manifest.json"),
        safeManifestPath,
      );

      const safeValidation = runExactWebValidation();
      assert.equal(
        safeValidation.status,
        0,
        `safe exact web validation failed:\n${safeValidation.stdout}\n${safeValidation.stderr}`,
      );

      const poisonedBuild = runBuild("https://attacker.invalid");
      assert.equal(
        poisonedBuild.status,
        0,
        `poisoned real Vite build failed before validation:\n${poisonedBuild.stdout}\n${poisonedBuild.stderr}`,
      );
      await copyFile(safeManifestPath, join(distDir, "arc-artifact-manifest.json"));
      await mkdir(join(distDir, "proof"), { recursive: true });
      await writeFile(
        join(distDir, "proof", "release-proof.txt"),
        `approved API origin: ${testEnv.VITE_ARC_API_ORIGIN}\n`,
      );

      const poisonedValidation = runExactWebValidation();
      assert.notEqual(
        poisonedValidation.status,
        0,
        `poisoned artifact unexpectedly passed:\n${poisonedValidation.stdout}\n${poisonedValidation.stderr}`,
      );
      assert.match(
        `${poisonedValidation.stdout}\n${poisonedValidation.stderr}`,
        /attacker\.invalid|artifact/i,
      );
    } finally {
      await rm(distDir, { recursive: true, force: true });
      await rm(safeManifestBackup, { recursive: true, force: true });
    }
  });

  it("rejects a computed API-origin property hidden by a safe executable decoy", async () => {
    const { readdir } = await import("node:fs/promises");
    const repoRoot = resolve(".");
    const distDir = resolve("apps/arc-web/dist");
    const testEnv = {
      VITE_ARC_PUBLIC_ORIGIN: "https://arc.agentpay.site",
      VITE_ARC_API_ORIGIN: "https://mcp.arc.agentpay.site",
      VITE_ARC_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_computed_test_key",
    };
    const buildEnvironment = { ...process.env, ...testEnv };
    const runBuild = () => spawnSync(
      "npm",
      ["run", "build", "--workspace", "apps/arc-web"],
      { cwd: repoRoot, env: buildEnvironment, encoding: "utf8" },
    );
    const runExactWebValidation = () => spawnSync(
      process.execPath,
      [
        "deploy/arc/validate-env.mjs",
        "web",
        "apps/arc-web/dist/arc-artifact-manifest.json",
      ],
      { cwd: repoRoot, env: buildEnvironment, encoding: "utf8" },
    );

    await rm(distDir, { recursive: true, force: true });
    try {
      const build = runBuild();
      assert.equal(
        build.status,
        0,
        `real Vite build failed:\n${build.stdout}\n${build.stderr}`,
      );
      const assetNames = await readdir(join(distDir, "assets"));
      const scriptName = assetNames.find((name) => name.endsWith(".js"));
      assert.ok(scriptName, "real Vite build must emit a JavaScript asset");
      const scriptPath = join(distDir, "assets", scriptName);
      const originalScript = await readFile(scriptPath, "utf8");
      const quote = String.fromCharCode(96);
      const literalAssignment = `VITE_ARC_API_ORIGIN:${quote}https://mcp.arc.agentpay.site${quote}`;
      assert.match(originalScript, new RegExp(literalAssignment.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
      const computedAssignment = `["VITE_ARC_"+"API_ORIGIN"]:${quote}https://attacker.invalid${quote}`;
      const safeLiteralDecoy = [
        "",
        "const __arcReleaseDecoy = {",
        `  VITE_ARC_PUBLIC_ORIGIN: "${testEnv.VITE_ARC_PUBLIC_ORIGIN}",`,
        `  VITE_ARC_API_ORIGIN: "${testEnv.VITE_ARC_API_ORIGIN}",`,
        `  VITE_ARC_SUPABASE_URL: "${testEnv.VITE_ARC_SUPABASE_URL}",`,
        `  VITE_ARC_SUPABASE_PUBLISHABLE_KEY: "${testEnv.VITE_ARC_SUPABASE_PUBLISHABLE_KEY}",`,
        "};",
      ].join("\n");
      await writeFile(
        scriptPath,
        originalScript.replace(literalAssignment, computedAssignment) + safeLiteralDecoy,
      );

      const validation = runExactWebValidation();
      assert.notEqual(
        validation.status,
        0,
        `computed-property poisoned artifact unexpectedly passed:\n${validation.stdout}\n${validation.stderr}`,
      );
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });
});
