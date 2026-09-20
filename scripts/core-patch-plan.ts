import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_VERSION = "0.86.0";
export const PI_NAME = "@earendil-works/pi-coding-agent";
export const CLI_PATH = "dist/bundle/cli.js";
export const STATE_DIR = ".pi-remoticon-patch";

// Audited npm 0.85.1 bytes. Keep these literal fingerprints when later patches
// change: the legacy thin-bar patch is the only earlier supported transform.
export const ORIGINAL_HASH = "8091e2b1cefd6b2962c2af09cb2b1359eac6a4200e5047cf61eaddddb0345abd";
export const THIN_BAR_HASH = "dc6b083dc16450b8bc82584cbc61718590c7c75192147a4c2eae2b955407e1b1";
export const BUNDLE_HASH = "bbb16214be9748c52613542d848388d55b42d062d25e0ebb6ba56aebd2b8bfdf";
export const S1_HASH = "a131e48f5368829aa3fd6763e2120615a0562903d9e573b2e72362e665fb187e";
export const INITIAL_UI_HASH = "2b59443dd6fe117213201279d8152a5ec1aba91bbaef106bb5971f21f848cd0f";
export const RESTORATION_PREVIEW_HASH = "8dcf5264d66860c4d46030eca64a4558b2ef6e2e4dc0e8997ff62d4dd385b26c";
export const RESTORATION_COLOR_HASH = "7c6f7003b1d9279ceba1fa39d5cf970f6741998454f44340c5a7613e407ffe32";
export const RESTORATION_GESTURE_HASH = "96207a8427cb7fea898bc5f3495b1251add31155aeadf65ed7bf8cd1e703f90c";
export const RESTORATION_HASH = "433b41975adb90f51a880fb042b1c2d6bd7dce56da9ee9f70073671f968299a5";
export const SKILL_PREVIEW_HASH = "1968440d198c79ad4d79adcab84903555a4eb1d29dd72f00240c56c49e702ac8";
export const COMPACT_SKILL_HASH = "43d1513f8461b10580dd3f7b715eef78167db016f39e62d5a3d5853be78af963";
export const PREVIOUS_UI_HASH = "d3c79adc9c29069e0b45564044b7e4dec074b59b9f9664a9fff891f760304f27";
export const LEGACY_UI_HASH = "5959d795fa3527de00404f7340a9602631ba421cb31bd315e46ccb042d6f46ff";
export const UI_HASH = "893c6e99988ba532574af0af69917966962f05036197241209c685b623619eb2";

export interface PatchEntry { name: string; find: string; replace: string }
// MIT excerpts from pi, copyright Mario Zechner. See patches/README.md.
export const PATCHES: readonly PatchEntry[] = [{
  name: "user-message-bar-height",
  find: 'new Box(this.outputPad,1,content=>theme.bg("userMessageBg",content))',
  replace: 'new Box(this.outputPad,0,content=>theme.bg("userMessageBg",content))',
}, {
  name: "footer-auto-compaction-bridge",
  find: 'this.customFooter=factory(this.ui,theme,this.footerDataProvider)',
  replace: 'this.customFooter=factory(this.ui,theme,{getGitBranch:()=>this.footerDataProvider.getGitBranch(),getExtensionStatuses:()=>this.footerDataProvider.getExtensionStatuses(),getAvailableProviderCount:()=>this.footerDataProvider.getAvailableProviderCount(),onBranchChange:callback=>this.footerDataProvider.onBranchChange(callback),remoticon:{version:1,getState:()=>({autoCompactionEnabled:this.session.autoCompactionEnabled,outputPad:this.outputPad})}})',
}, {
  name: "reset-retry-cancellation-notice",
  find: 'async _runAgentPrompt(messages){this._agentRunAbortRequested=!1,this._isAgentRunActive=!0;',
  replace: 'async _runAgentPrompt(messages){this._agentRunAbortRequested=!1,this.remoticonRetryStopped=false;this._isAgentRunActive=!0;',
}, {
  name: "record-retry-cancellation-notice",
  find: 'abortRetry(){this._retryAbortController?.abort()}',
  replace: 'abortRetry(){if(this._retryAbortController)this.remoticonRetryStopped=true;this._retryAbortController?.abort()}',
}, {
  name: "emit-retry-cancellation-notice",
  find: 'await this._extensionRunner.emit({type:"agent_settled"})',
  replace: 'await this._extensionRunner.emit({type:"agent_settled",remoticonRetryStopped:this.remoticonRetryStopped===true})',
}];

/** Fingerprint exact UTF-8 source or raw file bytes. */
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fingerprint the whole discovered graph: sorted [path, sha256] pairs, hashed. */
export function bundleFingerprint(files: ReadonlyMap<string, string>): string {
  const fingerprints = [...files].map(([path, bytes]) => [path, sha256(bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256(JSON.stringify(fingerprints));
}

export interface Edit { path: string; original: string; patched: string; previous?: string }
export interface FileRecord { path: string; originalHash: string; patchedHash: string; previousHash?: string }
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
    candidates.set(path, candidates.get(path)!.replace(entry.find, () => entry.replace));
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
    if (!edit || record.originalHash !== ORIGINAL_HASH || ![THIN_BAR_HASH, S1_HASH, INITIAL_UI_HASH, RESTORATION_PREVIEW_HASH, RESTORATION_COLOR_HASH, RESTORATION_GESTURE_HASH, RESTORATION_HASH, SKILL_PREVIEW_HASH, COMPACT_SKILL_HASH, LEGACY_UI_HASH, PREVIOUS_UI_HASH, UI_HASH].includes(record.patchedHash) ||
        record.previousHash !== undefined && ![THIN_BAR_HASH, S1_HASH, INITIAL_UI_HASH, RESTORATION_PREVIEW_HASH, RESTORATION_COLOR_HASH, RESTORATION_GESTURE_HASH, RESTORATION_HASH, SKILL_PREVIEW_HASH, COMPACT_SKILL_HASH, LEGACY_UI_HASH, PREVIOUS_UI_HASH, UI_HASH, ORIGINAL_HASH].includes(record.previousHash)) {
      throw new Error("Unsupported manifest file or historical fingerprint");
    }
  }
  return m as Manifest;
}

/** Files are the actual CLI's discovered local JS dependencies, including CLI. */
export function inspectPlan(
  target: string, name: unknown, version: unknown, files: ReadonlyMap<string, string>,
  sourceDigest: string, manifestValue?: unknown, backups: ReadonlyMap<string, string> = new Map(),
  interrupted = false, entries: readonly PatchEntry[] = PATCHES,
): Inspection {
  if (!target) throw new Error("An explicit target is required");
  if (name !== PI_NAME || version !== PI_VERSION) throw new Error(`Only ${PI_NAME} ${PI_VERSION} is audited; re-audit upgrades`);
  if (!files.has(CLI_PATH)) throw new Error("Actual bundled CLI is absent");
  const pristine = new Map(files);
  const modified: string[] = [];
  for (const [path, content] of files) {
    const hash = sha256(content);
    if ([THIN_BAR_HASH, S1_HASH, INITIAL_UI_HASH, RESTORATION_PREVIEW_HASH, RESTORATION_COLOR_HASH, RESTORATION_GESTURE_HASH, RESTORATION_HASH, SKILL_PREVIEW_HASH, COMPACT_SKILL_HASH, LEGACY_UI_HASH, PREVIOUS_UI_HASH, UI_HASH].includes(hash)) {
      const restored = hash === THIN_BAR_HASH ? content.replace(PATCHES[0].replace, PATCHES[0].find) : backups.get(path);
      if (restored === undefined) throw new Error("Missing original backup for managed UI patch");
      if (sha256(restored) !== ORIGINAL_HASH) throw new Error("Legacy original recovery failed");
      pristine.set(path, restored);
      modified.push(path);
    }
  }
  if (bundleFingerprint(pristine) !== BUNDLE_HASH) throw new Error("Unrecorded whole-file hash or bundled dependency graph drift");
  const edits = planEdits(pristine, entries);
  if (edits.length !== 1 || sha256(edits[0].original) !== ORIGINAL_HASH || sha256(edits[0].patched) !== UI_HASH) {
    throw new Error("Patch definitions no longer match the audited fingerprints");
  }
  for (const edit of edits) {
    const installed = files.get(edit.path);
    if (installed !== edit.original && installed !== edit.patched) edit.previous = installed;
  }
  if (manifestValue === undefined) {
    if (modified.some(path => sha256(files.get(path)!) !== THIN_BAR_HASH)) throw new Error("Missing managed UI manifest");
    return { state: interrupted ? "interrupted managed" : modified.length ? "legacy thin-bar-only" : "pristine", edits };
  }
  const manifest = validateManifest(manifestValue, target, edits);
  for (const file of manifest.files) {
    const backup = backups.get(file.path);
    if (backup === undefined || sha256(backup) !== file.originalHash) throw new Error(`Missing or changed original backup for ${file.path}`);
    const hash = sha256(files.get(file.path)!);
    if (hash !== file.originalHash && hash !== file.patchedHash && hash !== file.previousHash) throw new Error(`Unknown edits in ${file.path}`);
  }
  let state: PatchState = "interrupted managed";
  if (!interrupted && manifest.phase === "restored" && modified.length === 0) state = "pristine";
  if (!interrupted && manifest.phase === "applied" && modified.length === edits.length &&
      manifest.files.every(file => sha256(files.get(file.path)!) === file.patchedHash)) {
    state = manifest.sourceDigest === sourceDigest && manifest.files.every(file => file.patchedHash === UI_HASH) ? "current managed" : "older managed";
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
  const { running, launchers } = processRoles(rows, paths, windows);
  return [...new Set([...running, ...launchers])].sort((a, b) => a - b);
}

/**
 * Only the processes that execute code from the target. A launcher (a terminal,
 * an editor, Explorer) merely started pi: it holds none of the target's code, so
 * it must be reported but must never block a patch. Blocking on it made the
 * documented "close pi, then apply" runbook impossible on a desktop, where pi's
 * ancestor chain always reaches the shell session.
 */
export function runningProcesses(rows: readonly ProcessRecord[], paths: readonly string[], windows: boolean): number[] {
  return processRoles(rows, paths, windows).running;
}

/** Split the matched processes: those running the target, and those that launched it. */
function processRoles(rows: readonly ProcessRecord[], paths: readonly string[], windows: boolean): { running: number[]; launchers: number[] } {
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
  const running = [...affected].sort((a, b) => a - b);
  const launchers = new Set<number>();
  for (const row of direct) {
    let parent = rows.find(candidate => candidate.pid === row.parentPid);
    const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid); launchers.add(parent.pid);
      parent = rows.find(candidate => candidate.pid === parent!.parentPid);
    }
  }
  return { running, launchers: [...launchers].filter(pid => !running.includes(pid)).sort((a, b) => a - b) };
}
