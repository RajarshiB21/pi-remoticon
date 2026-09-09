import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const ORIGINAL_PTY_HASH = "8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a";
export const REPAIRED_PTY_HASH = "4a03e43ab60106322b822397e217340a0882c7e531c2f2110a737e84a7e6a55d";
// node-pty MIT, copyright Christopher Jeffrey. See patches/README.md.
export const ORIGINAL_CLEANUP = "                });\n                this._ptyNative.kill(this._pty, this._useConptyDll);\n                this._conoutSocketWorker.dispose();";
export const REPAIRED_CLEANUP = "                    _this._ptyNative.kill(_this._pty, _this._useConptyDll);\n                    _this._conoutSocketWorker.dispose();\n                });";
/** Fingerprint full dependency bytes before accepting either supported state. */
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Reject links through every parent so setup cannot redirect outside its target. */
function rejectLinks(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("Refusing a linked node-pty package or file");
    if (current === dirname(current)) return;
  }
}

/** Shared I/O for the fixed CLI target and disposable filesystem tests. */
export function repairPtyPackage(packageRoot: string): "applied" | "already applied" {
  const metadata = join(resolve(packageRoot), "package.json");
  const file = join(resolve(packageRoot), "lib", "windowsPtyAgent.js");
  rejectLinks(metadata);
  rejectLinks(file);
  const metadataBytes = readFileSync(metadata);
  const pkg: { name?: unknown; version?: unknown } = JSON.parse(metadataBytes.toString("utf8"));
  if (pkg.name !== "node-pty" || pkg.version !== "1.1.0") throw new Error("Only audited node-pty 1.1.0 is supported");
  const original = readFileSync(file);
  const fingerprint = hash(original);
  if (fingerprint !== ORIGINAL_PTY_HASH && fingerprint !== REPAIRED_PTY_HASH) throw new Error("Unknown node-pty bytes; refusing repair");
  const stage = `${file}.remoticon-next.js`;
  if (lstatSync(stage, { throwIfNoEntry: false })) {
    rejectLinks(stage);
    if (hash(readFileSync(stage)) !== REPAIRED_PTY_HASH) throw new Error("Unknown repair stage; preserve it for inspection, then use npm ci to restore this test dependency");
    unlinkSync(stage);
  }
  if (fingerprint === REPAIRED_PTY_HASH) return "already applied";
  const source = original.toString("utf8");
  if (source.split(ORIGINAL_CLEANUP).length !== 2) throw new Error("node-pty cleanup anchor is not unique");
  const candidate = Buffer.from(source.replace(ORIGINAL_CLEANUP, REPAIRED_CLEANUP));
  if (hash(candidate) !== REPAIRED_PTY_HASH) throw new Error("Repair does not match the audited result");
  let staged = false;
  try {
    writeFileSync(stage, candidate, { flag: "wx", flush: true });
    staged = true;
    execFileSync(process.execPath, ["--check", stage], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    rejectLinks(metadata);
    rejectLinks(file);
    if (!readFileSync(metadata).equals(metadataBytes)) throw new Error("node-pty changed during repair");
    if (hash(readFileSync(file)) !== ORIGINAL_PTY_HASH) throw new Error("node-pty changed during repair");
    renameSync(stage, file);
    staged = false;
    if (hash(readFileSync(file)) !== REPAIRED_PTY_HASH) throw new Error("Repair verification failed; npm ci restores this test dependency");
    return "applied";
  } finally {
    if (staged) unlinkSync(stage);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("This command accepts no target or other arguments");
    if (process.platform !== "win32") console.log("Test PTY repair is not needed on this platform.");
    else {
      const root = dirname(dirname(fileURLToPath(import.meta.url)));
      console.log(`Test PTY repair: ${repairPtyPackage(join(root, "node_modules", "node-pty"))}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
