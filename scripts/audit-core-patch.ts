// Re-audit helper: print the patch constants for the pi version installed in
// this repository's own node_modules. Read-only. Never touches a live install.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "./apply-core-patch.js";
import { runtimePatches } from "./runtime-patches.js";
import { bundleFingerprint, PATCHES, PI_NAME, planEdits, sha256 } from "./core-patch-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = realpathSync(join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
const pkg: { name?: unknown; version?: unknown } = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
if (pkg.name !== PI_NAME || typeof pkg.version !== "string") throw new Error(`Expected ${PI_NAME}, found ${String(pkg.name)} ${String(pkg.version)}`);
const files = readBundle(target);
const edits = planEdits(files, [...PATCHES, ...runtimePatches(files)]);
if (edits.length !== 1) {
  throw new Error(`Expected exactly one patched file, found ${edits.length}: ${edits.map(edit => edit.path).join(", ")}`);
}
console.log(JSON.stringify({
  PI_VERSION: pkg.version,
  patchedPath: edits[0].path,
  discoveredFiles: files.size,
  BUNDLE_HASH: bundleFingerprint(files),
  ORIGINAL_HASH: sha256(edits[0].original),
  UI_HASH: sha256(edits[0].patched),
}, null, 2));
