// Re-audit helper: print the patch constants for the pi version installed in
// this repository's own node_modules. Read-only. Never touches a live install.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "./apply-core-patch.js";
import { runtimePatches } from "./runtime-patches.js";
import { bundleFingerprint, PATCHES, PI_NAME, PI_VERSION, planEdits, sha256, BUNDLE_HASH, ORIGINAL_HASH, UI_HASH } from "./core-patch-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = realpathSync(join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
const pkg: { name?: unknown; version?: unknown } = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
if (pkg.name !== PI_NAME || typeof pkg.version !== "string") throw new Error(`Expected ${PI_NAME}, found ${String(pkg.name)} ${String(pkg.version)}`);
const files = readBundle(target);
const edits = planEdits(files, [...PATCHES, ...runtimePatches(files)]);
if (edits.length !== 1) {
  throw new Error(`Expected exactly one patched file, found ${edits.length}: ${edits.map(edit => edit.path).join(", ")}`);
}
const computed = {
  PI_VERSION: pkg.version,
  patchedPath: edits[0].path,
  discoveredFiles: files.size,
  BUNDLE_HASH: bundleFingerprint(files),
  ORIGINAL_HASH: sha256(edits[0].original),
  UI_HASH: sha256(edits[0].patched),
};
const recorded = { PI_VERSION, BUNDLE_HASH, ORIGINAL_HASH, UI_HASH };
for (const key of ["PI_VERSION", "BUNDLE_HASH", "ORIGINAL_HASH", "UI_HASH"] as const) {
  if (computed[key] !== recorded[key]) {
    throw new Error(`Audit drift: ${key} recorded ${recorded[key]} does not match computed ${computed[key]}. If this is an intentional re-audit, update core-patch-plan.ts with the computed value.`);
  }
}
console.log(JSON.stringify(computed, null, 2));
