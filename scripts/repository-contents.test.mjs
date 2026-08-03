import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("repository contents", () => {
  it("keeps generated/local agent docs out of the pushed repository", () => {
    const result = spawnSync("git", ["ls-files"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const trackedFiles = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    assert.equal(trackedFiles.includes("AGENTS.md"), false);
    assert.equal(trackedFiles.includes("AGENTPAY_CONCEPT.md"), false);
    assert.equal(trackedFiles.includes("apps/setup-web/PRODUCT.md"), false);
    // `docs/` holds local handoff material and must not reach this public
    // repository -- with one deliberately narrow exception for the submission
    // bundle, which exists to be read publicly. Stated as an allowlist rather
    // than relaxed to a warning: a blanket rule that people bypass with
    // `--no-verify` protects nothing, and a vague one drifts back to blanket.
    const PUBLIC_DOCS_PREFIX = "docs/hackathon/";
    const leakedDocs = trackedFiles.filter(
      (file) => file.startsWith("docs/") && !file.startsWith(PUBLIC_DOCS_PREFIX),
    );
    assert.deepEqual(
      leakedDocs,
      [],
      `local docs must not be tracked in a public repository; move public material under ${PUBLIC_DOCS_PREFIX}`,
    );
    assert.equal(
      trackedFiles.some((file) => /(^|\/)(?:.*concept.*|PRODUCT\.md)$/i.test(file)),
      false,
    );
  });
});
