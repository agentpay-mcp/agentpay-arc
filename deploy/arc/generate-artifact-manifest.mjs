import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_KEYS = Object.freeze([
  "VITE_ARC_PUBLIC_ORIGIN",
  "VITE_ARC_API_ORIGIN",
  "VITE_ARC_SUPABASE_URL",
  "VITE_ARC_SUPABASE_PUBLISHABLE_KEY",
]);

function generateManifest() {
  const manifest = {};
  for (const key of MANIFEST_KEYS) {
    const value = process.env[key]?.trim() ?? "";
    if (value.length === 0) {
      process.stderr.write(
        `${JSON.stringify({ event: "manifest_env_missing", key })}\n`,
      );
    }
    manifest[key] = value;
  }
  return manifest;
}

export { generateManifest as generateArtifactManifest };

function isMainModule() {
  return (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  const manifest = generateManifest();
  if (manifest) {
    const outDir = resolve(process.argv[2] ?? "dist");
    const outPath = resolve(outDir, "arc-artifact-manifest.json");
    await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        event: "arc_artifact_manifest_written",
        path: outPath,
        keys: Object.keys(manifest),
      })}\n`,
    );
  }
}