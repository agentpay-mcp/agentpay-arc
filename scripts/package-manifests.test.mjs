import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const publishablePackages = [
  "packages/skill",
  "packages/shared",
  "apps/mcp-server",
  "apps/setup-web",
  "packages/cli",
];
const publishScope = "@agentpay-ai";
const expectedPackageNames = new Map([
  ["packages/skill", "@agentpay-ai/skill-arc"],
  ["packages/shared", "@agentpay-ai/shared-arc"],
  ["apps/mcp-server", "@agentpay-ai/mcp-server-arc"],
  ["apps/setup-web", "@agentpay-ai/setup-web-arc"],
  ["packages/cli", "@agentpay-ai/agentpay-arc"],
]);

async function readPackageJson(packageDir) {
  const path = join(process.cwd(), packageDir, "package.json");
  return JSON.parse(await readFile(path, "utf8"));
}

describe("publishable AgentPay package manifests", () => {
  it("exposes a local tarball smoke command before publishing", async () => {
    const rootManifest = await readPackageJson(".");
    const command = rootManifest.scripts?.["release:smoke"];

    assert.equal(command, "node scripts/smoke-agentpay-release.mjs");
    await access("scripts/smoke-agentpay-release.mjs");
  });

  it("keeps mainnet and testnet deployment commands explicit", async () => {
    const rootManifest = await readPackageJson(".");
    const mainnetCommand = rootManifest.scripts?.["contracts:deploy:celo"] ?? "";
    const mainnetSimulationCommand = rootManifest.scripts?.["contracts:deploy:celo:simulate"] ?? "";
    const mainnetDeploymentSource = await readFile("scripts/deploy-celo-factory.ts", "utf8");

    assert.match(mainnetCommand, /deploy-celo-factory\.ts --broadcast/);
    assert.match(mainnetSimulationCommand, /deploy-celo-factory\.ts/);
    assert.doesNotMatch(mainnetSimulationCommand, /--broadcast/);
    assert.match(mainnetDeploymentSource, /CELO_MAINNET_RPC_URL/);
    assert.match(mainnetDeploymentSource, /CELO_ATTRIBUTION_TAG/);
    assert.match(mainnetDeploymentSource, /toDataSuffix/);
    assert.doesNotMatch(mainnetCommand, /DeployAgentPayAccountV2/);
    assert.match(rootManifest.scripts?.["contracts:deploy:celo:sepolia"] ?? "", /CELO_SEPOLIA_RPC_URL/);
    assert.equal(rootManifest.scripts?.["contracts:deploy:xlayer"], undefined);
  });

  it("keeps the npx install dependency chain publishable", async () => {
    const packages = new Map(
      await Promise.all(
        publishablePackages.map(async (packageDir) => {
          const manifest = await readPackageJson(packageDir);
          assert.equal(
            manifest.name,
            expectedPackageNames.get(packageDir),
            `${packageDir} must publish under the ${publishScope} npm org`,
          );
          return [manifest.name, { packageDir, manifest }];
        }),
      ),
    );

    for (const { packageDir, manifest } of packages.values()) {
      assert.notEqual(manifest.private, true, `${packageDir} must be publishable`);
      assert.ok(Array.isArray(manifest.files), `${packageDir} must explicitly whitelist package files`);
      assert.ok(manifest.files.length > 0, `${packageDir} must include package files`);
      assert.ok(manifest.files.includes("README.md"), `${packageDir} must publish its npm README.md`);
      await access(join(packageDir, "README.md"));

      for (const filePattern of manifest.files) {
        assert.doesNotMatch(filePattern, /\.test\./, `${packageDir} must not publish test files`);
      }

      if (manifest.name.startsWith(`${publishScope}/`)) {
        assert.equal(manifest.publishConfig?.access, "public", `${packageDir} scoped package must publish public`);
      }
    }

    for (const { packageDir, manifest } of packages.values()) {
      for (const [dependencyName, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
        const dependency = packages.get(dependencyName);

        if (!dependency) {
          continue;
        }

        assert.equal(
          dependencyVersion,
          dependency.manifest.version,
          `${packageDir} must depend on published ${dependencyName} ${dependency.manifest.version}`,
        );
      }
    }
  });

  it("declares runtime dependencies in the package that imports them", async () => {
    const rootManifest = await readPackageJson(".");
    const skillManifest = await readPackageJson("packages/skill");
    const expectedDependencies = {
      "@agentpay-ai/shared-arc": {
        "@noble/hashes": rootManifest.dependencies["@noble/hashes"],
        zod: rootManifest.dependencies.zod,
      },
      "@agentpay-ai/mcp-server-arc": {
        "@x402/core": rootManifest.dependencies["@x402/core"],
        "@x402/evm": rootManifest.dependencies["@x402/evm"],
        "@supabase/supabase-js": rootManifest.dependencies["@supabase/supabase-js"],
        ethers: rootManifest.dependencies.ethers,
      },
      "@agentpay-ai/setup-web-arc": {
        ethers: rootManifest.dependencies.ethers,
        zod: rootManifest.dependencies.zod,
      },
      "@agentpay-ai/agentpay-arc": {
        "@agentpay-ai/skill-arc": skillManifest.version,
      },
    };

    const packages = new Map(
      await Promise.all(
        publishablePackages.map(async (packageDir) => {
          const manifest = await readPackageJson(packageDir);
          return [manifest.name, { packageDir, manifest }];
        }),
      ),
    );

    for (const [packageName, dependencies] of Object.entries(expectedDependencies)) {
      const entry = packages.get(packageName);
      assert.ok(entry, `${packageName} package must exist`);

      for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
        assert.equal(
          entry.manifest.dependencies?.[dependencyName],
          dependencyVersion,
          `${entry.packageDir} must declare ${dependencyName} as a direct runtime dependency`,
        );
      }
    }
  });

  it("keeps the CLI bin wrapper trackable by Git", () => {
    const result = spawnSync("git", ["check-ignore", "-q", "packages/cli/dist/index.js"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, "packages/cli/dist/index.js must not be ignored");
  });

  it("keeps the CLI bin path in npm publish-normalized form", async () => {
    const manifest = await readPackageJson("packages/cli");

    assert.equal(manifest.bin?.agentpay, "dist/index.js");
  });

  it("keeps the published CLI wrapper resolving tsx from its package dependency", async () => {
    const wrapper = await readFile("packages/cli/dist/index.js", "utf8");

    assert.match(wrapper, /createRequire\(import\.meta\.url\)/);
    assert.match(wrapper, /require\.resolve\("tsx"\)/);
    assert.doesNotMatch(wrapper, /\["--import", "tsx"/);
  });

  it("defaults installed MCP templates to hosted tools plus the local Agent Wallet", async () => {
    const templatePaths = [
      "packages/cli/templates/codex/mcp.json",
      "packages/cli/templates/cursor/mcp.json",
      "packages/cli/templates/generic/mcp.json",
      "packages/cli/templates/hermes/mcp.json",
      "packages/cli/templates/claude/claude_desktop_config.json",
    ];

    for (const templatePath of templatePaths) {
      const template = JSON.parse(await readFile(templatePath, "utf8"));

      assert.deepEqual(template.mcpServers.agentpay, {
        url: "https://wallet.agentpay.site/arc/mcp",
      });
      assert.deepEqual(template.mcpServers["agentpay-wallet"], {
        command: "npx",
        args: ["-y", "@agentpay-ai/agentpay-arc", "agent-wallet-mcp"],
      });
    }
  });

  it("keeps bundled runtime instructions on the Arc package and public routes", async () => {
    const instructionPaths = [
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
      "packages/cli/templates/claude/CLAUDE.md",
    ];

    for (const instructionPath of instructionPaths) {
      const instructions = await readFile(instructionPath, "utf8");

      assert.match(instructions, /@agentpay-ai\/agentpay-arc/);
      assert.match(instructions, /https:\/\/wallet\.agentpay\.site\/arc\/mcp/);
      assert.doesNotMatch(instructions, /@agentpay-ai\/agentpay-celo|agentpay\.site\/celo\/mcp/);
    }
  });

  it("publishes the public HTTP MCP transport for A2MCP deployments", async () => {
    const manifest = await readPackageJson("apps/mcp-server");

    assert.ok(manifest.files.includes("src/mcp/http.ts"));
    assert.ok(manifest.files.includes("src/mcp/celo-agent-payment.ts"));
    assert.ok(manifest.files.includes("src/runtime/paid-execution-canary-ledger.ts"));
    assert.ok(manifest.files.includes("src/services/production-setup.ts"));
    assert.ok(manifest.files.includes("src/services/production-setup-supabase.ts"));
    assert.ok(manifest.files.includes("src/tools/circle-agent-wallet.ts"));
    await access("apps/mcp-server/src/mcp/http.ts");
    await access("apps/mcp-server/src/mcp/celo-agent-payment.ts");
    await access("apps/mcp-server/src/runtime/paid-execution-canary-ledger.ts");
    await access("apps/mcp-server/src/services/production-setup.ts");
    await access("apps/mcp-server/src/services/production-setup-supabase.ts");
    await access("apps/mcp-server/src/tools/circle-agent-wallet.ts");
  });

  it("publishes the isolated Celo onboarding web and deployment worker entrypoints", async () => {
    const manifest = await readPackageJson("apps/setup-web");
    const requiredFiles = [
      "src/onboarding/start.ts",
      "src/onboarding/runtime.ts",
      "src/worker/start.ts",
      "src/worker/runtime.ts",
    ];

    for (const file of requiredFiles) {
      assert.ok(manifest.files.includes(file), `apps/setup-web must publish ${file}`);
      await access(join("apps/setup-web", file));
    }

    assert.equal(manifest.scripts?.["start:onboarding"], "tsx src/onboarding/start.ts");
    assert.equal(manifest.scripts?.["start:setup-worker"], "tsx src/worker/start.ts");
  });
});
