import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_VERSION = "0.85.1";
export const PI_NAME = "@earendil-works/pi-coding-agent";
export const CLI_PATH = "dist/bundle/cli.js";
export const STATE_DIR = ".pi-remoticon-patch";

// Audited npm 0.85.1 bytes. Keep these literal fingerprints when later patches
// change: the legacy thin-bar patch is the only earlier supported transform.
export const ORIGINAL_HASH = "3d8b2dec97ff9fe4cabef1c69899b00cb8257c625fb0f66c52f4d9914a6b4232";
export const THIN_BAR_HASH = "954207c65f4c6d21fa69c5b8d7a9b484d1932c11315dd06949ba797059835fea";
export const BUNDLE_HASH = "11a2c450cb651aac10d180c3282775aee39fdcb0e423ed7c7a6d64dbd1d2616e";

export interface PatchEntry { name: string; find: string; replace: string }
// MIT excerpts from pi, copyright Mario Zechner. See patches/README.md.
export const PATCHES: readonly PatchEntry[] = [{
  name: "user-message-bar-height",
  find: 'new Box(this.outputPad,1,content=>theme.bg("userMessageBg",content))',
  replace: 'new Box(this.outputPad,0,content=>theme.bg("userMessageBg",content))',
}];

/** Fingerprint exact UTF-8 source or raw file bytes. */
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface Edit { path: string; original: string; patched: string }
export interface FileRecord { path: string; originalHash: string; patchedHash: string }
export type Phase = "prepared" | "applying" | "applied" | "restoring" | "restored" | "rollback-failed";
export interface Manifest {
  format: 1;
  target: string;
  version: string;
  sourceDigest: string;
  phase: Phase;
  files: FileRecord[];
}
export type PatchState = "pristine" | "current managed" | "older managed" | "legacy thin-bar-only" | "interrupted managed" | "unsupported/drifted";
export interface Inspection { state: PatchState; edits: Edit[]; manifest?: Manifest }

/** Compose every entry in memory. Never layer a revision over patched bytes. */
export function planEdits(files: ReadonlyMap<string, string>, entries: readonly PatchEntry[] = PATCHES): Edit[] {
  const candidates = new Map(files);
  for (const entry of entries) {
    if (!entry.find || entry.find === entry.replace) throw new Error(`Invalid patch entry ${entry.name}`);
    const hits: string[] = [];
    for (const [path, content] of candidates) {
      const count = content.split(entry.find).length - 1;
      for (let i = 0; i < count; i++) hits.push(path);
      if (content.includes(entry.replace)) throw new Error(`Inconsistent replacement for ${entry.name}`);
    }
    if (hits.length !== 1) throw new Error(`${entry.name}: anchor ${hits.length ? "ambiguous" : "not found"} (${hits.length})`);
    const path = hits[0];
    candidates.set(path, candidates.get(path)!.replace(entry.find, entry.replace));
  }
  return [...candidates].filter(([path, content]) => content !== files.get(path))
    .map(([path, patched]) => ({ path, original: files.get(path)!, patched }));
}

/** Accept only the recorded target and supported literal file fingerprints. */
function validateManifest(value: unknown, target: string, edits: readonly Edit[]): Manifest {
  if (!value || typeof value !== "object") throw new Error("Invalid patch manifest");
  const m = value as Partial<Manifest>;
  const phases: Phase[] = ["prepared", "applying", "applied", "restoring", "restored", "rollback-failed"];
  if (m.format !== 1 || m.target !== target || m.version !== PI_VERSION ||
      typeof m.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(m.sourceDigest) ||
      !m.phase || !phases.includes(m.phase) || !Array.isArray(m.files) || m.files.length !== edits.length) {
    throw new Error("Unsupported manifest identity, revision, or phase");
  }
  const paths = new Set<string>();
  for (const record of m.files) {
    if (!record || typeof record !== "object" || paths.has(record.path)) throw new Error("Duplicate or invalid manifest target");
    paths.add(record.path);
    const edit = edits.find(e => e.path === record.path);
    if (!edit || record.originalHash !== ORIGINAL_HASH || record.patchedHash !== THIN_BAR_HASH) {
      throw new Error("Unsupported manifest file or historical fingerprint");
    }
  }
  return m as Manifest;
}

/** Files are the actual CLI's discovered local JS dependencies, including CLI. */
export function inspectPlan(
  target: string, name: unknown, version: unknown, files: ReadonlyMap<string, string>,
  sourceDigest: string, manifestValue?: unknown, backups: ReadonlyMap<string, string> = new Map(),
  interrupted = false,
): Inspection {
  if (!target) throw new Error("An explicit target is required");
  if (name !== PI_NAME || version !== PI_VERSION) throw new Error(`Only ${PI_NAME} ${PI_VERSION} is audited; re-audit upgrades`);
  if (!files.has(CLI_PATH)) throw new Error("Actual bundled CLI is absent");
  const pristine = new Map(files);
  const modified: string[] = [];
  for (const [path, content] of files) {
    if (sha256(content) === THIN_BAR_HASH) {
      const restored = content.replace(PATCHES[0].replace, PATCHES[0].find);
      if (sha256(restored) !== ORIGINAL_HASH) throw new Error("Legacy original recovery failed");
      pristine.set(path, restored);
      modified.push(path);
    }
  }
  const fingerprints = [...pristine].map(([path, bytes]) => [path, sha256(bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (sha256(JSON.stringify(fingerprints)) !== BUNDLE_HASH) throw new Error("Unrecorded whole-file hash or bundled dependency graph drift");
  const edits = planEdits(pristine);
  if (edits.length !== 1 || sha256(edits[0].original) !== ORIGINAL_HASH || sha256(edits[0].patched) !== THIN_BAR_HASH) {
    throw new Error("Patch definitions no longer match the audited fingerprints");
  }
  if (manifestValue === undefined) {
    return { state: interrupted ? "interrupted managed" : modified.length ? "legacy thin-bar-only" : "pristine", edits };
  }
  const manifest = validateManifest(manifestValue, target, edits);
  for (const file of manifest.files) {
    const backup = backups.get(file.path);
    if (backup === undefined || sha256(backup) !== file.originalHash) throw new Error(`Missing or changed original backup for ${file.path}`);
    const hash = sha256(files.get(file.path)!);
    if (hash !== file.originalHash && hash !== file.patchedHash) throw new Error(`Unknown edits in ${file.path}`);
  }
  let state: PatchState = "interrupted managed";
  if (!interrupted && manifest.phase === "restored" && modified.length === 0) state = "pristine";
  if (!interrupted && manifest.phase === "applied" && modified.length === edits.length) {
    state = manifest.sourceDigest === sourceDigest ? "current managed" : "older managed";
  }
  return { state, edits, manifest };
}

export interface ProcessRecord { pid: number; parentPid: number; executable: string | null; commandLine: string | null; name: string }

/** Split launcher words without inspecting application arguments as commands. */
function commandWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map(word => word.replace(/"([^"]*)"|'([^']*)'/g, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? "")).filter(Boolean);
}

/** Name the process requiring closure without exposing its prompt. */
function ambiguousProcess(pid: number): never {
  throw new Error(`Cannot disambiguate pi-capable process PID ${pid}. Close it, then rerun the patch command. No files changed.`);
}

/** Recognize only pi launcher basenames when deciding whether ambiguity matters. */
function isPiEntry(path: string): boolean {
  return /(?:^|[\\/:])(?:cli\.js|pi(?:\.cmd|\.ps1|\.exe)?)$/i.test(path);
}

/** Collect executable preloads and the Node script, stopping before script args. */
function nodeEntries(args: string[], pid: number): string[] {
  const entries: string[] = [];
  const preloads = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
  const values = new Set(["-C", "--conditions", "--title", "--inspect-port", "--icu-data-dir", "--disable-warning"]);
  const switches = new Set(["--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-strip-types", "--no-experimental-strip-types", "--inspect", "--inspect-brk"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args[i + 1] ? [...entries, args[i + 1]] : entries;
    if (!arg.startsWith("-")) return [...entries, arg];
    const equals = arg.indexOf("=");
    const option = equals === -1 ? arg : arg.slice(0, equals);
    if (preloads.has(option)) {
      const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
      if (value) entries.push(value);
      continue;
    }
    if (arg.startsWith("-r") && !arg.startsWith("--") && arg.length > 2) { entries.push(arg.slice(2)); continue; }
    // Arbitrary evaluated code is outside CLI-path inspection, not a pi launch.
    if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg)) return entries;
    if (values.has(arg)) { i++; continue; }
    if (arg.includes("=") || switches.has(arg)) continue;
    if (args.slice(i + 1).some(isPiEntry)) ambiguousProcess(pid);
    return entries;
  }
  return entries;
}

/** Inspect direct Node and standard Windows npm shell-launcher positions only. */
function processEntries(row: ProcessRecord): string[] {
  const command = row.commandLine ?? "";
  const words = commandWords(command);
  const executable = (row.executable ?? words[0] ?? row.name).replaceAll("\\", "/").split("/").pop()?.replace(/\.exe$/i, "").toLowerCase();
  if (executable === "node") return nodeEntries(words.slice(1), row.pid);
  let launched: string[];
  if (executable === "cmd") {
    const body = /\s\/[ck]\s+([\s\S]+)/i.exec(command)?.[1];
    if (!body) return [];
    launched = commandWords(body.startsWith('""') && body.endsWith('"') ? body.slice(1, -1) : body);
  } else if (executable === "powershell" || executable === "pwsh") {
    const entry = words.findIndex(word => /^-(?:file|f|command|c)$/i.test(word));
    if (entry !== -1 && /^-(?:file|f)$/i.test(words[entry])) return words[entry + 1] ? [words[entry + 1]] : [];
    const body = /\s-(?:command|c)\s+([\s\S]+)/i.exec(command)?.[1];
    if (!body) return [];
    launched = commandWords(body.startsWith('"') && body.endsWith('"') ? body.slice(1, -1) : body);
    if (launched[0] === "&" || launched[0] === ".") launched.shift();
  } else return [];
  const launcher = launched[0];
  return launcher && /(?:^|[\\/])node(?:\.exe)?$/i.test(launcher) ? nodeEntries(launched.slice(1), row.pid) : launcher ? [launcher] : [];
}

/** Match executable/script paths and their process relatives, excluding prompts. */
export function affectedProcesses(rows: readonly ProcessRecord[], paths: readonly string[], windows: boolean): number[] {
  /** Normalize case, separators, extended prefixes and dot segments for matching. */
  const normalize = (value: string) => {
    if (value.startsWith("file:")) value = fileURLToPath(value, { windows });
    const plain = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    const p = (windows ? win32 : posix).normalize(plain).replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? p.toLowerCase() : p;
  };
  const targets = new Set(paths.map(normalize));
  const direct = rows.filter(row => {
    const paths = [row.executable ?? "", ...processEntries(row)].map(normalize);
    if (paths.some(path => targets.has(path))) return true;
    // CIM does not provide the working directory. A relative pi entry cannot
    // be assigned to another installation safely, so require it to be closed.
    if (paths.some(path => isPiEntry(path) &&
      !(windows ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+)/i.test(path) : posix.isAbsolute(path)))) {
      ambiguousProcess(row.pid);
    }
    return false;
  });
  const affected = new Set(direct.map(row => row.pid));
  // Children can outlive their launching pi. Include ancestors for reporting,
  // but do not traverse ancestors' other children and claim sibling installs.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (affected.has(row.parentPid) && !affected.has(row.pid)) {
      affected.add(row.pid); changed = true;
    }
  }
  for (const row of direct) {
    let parent = rows.find(candidate => candidate.pid === row.parentPid);
    const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid); affected.add(parent.pid);
      parent = rows.find(candidate => candidate.pid === parent!.parentPid);
    }
  }
  return [...affected].sort((a, b) => a - b);
}
