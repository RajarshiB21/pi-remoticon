import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync,
  fsyncSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync, rmdirSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { runtimePatches } from "./runtime-patches.js";
import {
  CLI_PATH, STATE_DIR, PI_VERSION, PATCHES, sha256, inspectPlan, runningProcesses,
  type Edit, type Manifest, type Inspection, type ProcessRecord,
} from "./core-patch-plan.js";

export type Command = "status" | "check" | "apply" | "restore";
const commands: Command[] = ["status", "check", "apply", "restore"];
const here = dirname(fileURLToPath(import.meta.url));
const parsedDependencies = new Map<string, string[]>();
/** Identify the exact maintained planner and delivery source in each manifest. */
export function patchSourceDigest(): string {
  return sha256(["core-patch-plan.ts", "apply-core-patch.ts", "runtime-patches.ts", "../patches/runtime/assistant.ts", "../patches/runtime/tool-group.ts", "../patches/runtime/skill.ts"].map(name =>
    `${name}\n${readFileSync(join(here, name), "utf8")}`).join("\n"));
}

/** Reject links in every path we may replace, including parent directories. */
function safePath(target: string, path: string): string {
  const full = resolve(target, path);
  const rel = relative(target, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes target: ${path}`);
  let current = target;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    let linked = false;
    try { linked = lstatSync(current).isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (linked) throw new Error(`Refusing linked patch path: ${path}`);
  }
  return full;
}

/** Find literal local JS dependencies without evaluating the audited bundle. */
function localDependencies(path: string, content: string): string[] {
  const refs = new Set<string>();
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  /** Collect imports, requires and worker URLs while traversing the syntax tree. */
  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require")) specifier = node.arguments[0];
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") specifier = node.arguments?.[0];
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith(".") && specifier.text.endsWith(".js")) {
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier.text));
      if (!dependency.startsWith("dist/bundle/")) throw new Error("Bundled dependency escapes dist/bundle");
      refs.add(dependency);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...refs];
}

/** Reject lossy decoding so text edits preserve the original byte fingerprints. */
function readUtf8(path: string): string {
  const bytes = readFileSync(path);
  const content = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error(`Invalid UTF-8 bytes in ${path}`);
  return content;
}

/** Read the CLI dependency graph; cache parsing only, never file contents. */
export function readBundle(target: string, dependencies = parsedDependencies): Map<string, string> {
  const files = new Map<string, string>();
  /** Read each reachable file once, including graphs containing import cycles. */
  function read(path: string): void {
    if (files.has(path)) return;
    const content = readUtf8(safePath(target, path));
    files.set(path, content);
    const key = `${path}:${sha256(content)}`;
    let refs = dependencies.get(key);
    if (!refs) { refs = localDependencies(path, content); dependencies.set(key, refs); }
    for (const dependency of refs) read(dependency);
  }
  read(CLI_PATH);
  return files;
}

/** Keep original bytes separate from the installed bundle and its sibling stages. */
const backupPath = (path: string) => `${STATE_DIR}/backups/${path}.original`;
/** Keep replacements beside their destination for same-filesystem renames. */
const stagePath = (path: string) => `${path}.pi-remoticon-next.js`;
const manifestPath = `${STATE_DIR}/manifest.json`;
const lockPath = `${STATE_DIR}/lock.json`;

/** Validate live package, bundle and recovery metadata before any mutation. */
function readInspection(target: string, dependencies: Map<string, string[]>): Inspection {
  const pkg: { name?: unknown; version?: unknown } = JSON.parse(readFileSync(safePath(target, "package.json"), "utf8"));
  const files = readBundle(target, dependencies);
  const state = safePath(target, STATE_DIR);
  const manifestFile = safePath(target, manifestPath);
  const manifest: unknown = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : undefined;
  // Backup paths come from the discovered bundle, never from untrusted JSON.
  const backups = new Map<string, string>();
  for (const path of files.keys()) {
    const backup = safePath(target, backupPath(path));
    if (existsSync(backup)) backups.set(path, readUtf8(backup));
  }
  const pristine = new Map([...files].map(([path, content]) => [path, backups.get(path) ?? content]));
  return inspectPlan(target, pkg.name, pkg.version, files, patchSourceDigest(), manifest, backups,
    existsSync(safePath(target, lockPath)) || existsSync(state) && manifest === undefined ||
    existsSync(safePath(target, `${manifestPath}.next`)) || [...files.keys()].some(path => existsSync(safePath(target, stagePath(path)))),
    [...PATCHES, ...runtimePatches(pristine)]);
}

/** Flush directory entries where the platform supports opening directories. */
function syncDirectory(path: string): void {
  // Windows cannot open directories through Node's fs.open. File contents are
  // flushed on both platforms; directory entries are additionally flushed on Unix.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Flush file contents before returning; exclusive writes refuse existing stages. */
function durableWrite(path: string, bytes: string, exclusive = false): void {
  const fd = openSync(path, exclusive ? "wx" : "w");
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

/** Replace the phase record only after its complete contents have been flushed. */
function saveManifest(target: string, manifest: Manifest): void {
  const path = safePath(target, manifestPath);
  const next = safePath(target, `${manifestPath}.next`);
  durableWrite(next, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(next, path);
  syncDirectory(dirname(path));
}

/** Read process identities internally without exposing command lines in diagnostics. */
function processRows(): ProcessRecord[] {
  if (process.platform === "win32") {
    if (!process.env.SystemRoot) throw new Error("SystemRoot is required for process inspection");
    const shell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // OEM encoding can turn Unicode arrows into raw JSON control bytes.
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,Name) | ConvertTo-Json -Compress";
    const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const rows: { ProcessId: number; ParentProcessId: number; ExecutablePath: string | null; CommandLine: string | null; Name: string }[] = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error("Process query returned no process list");
    return rows.map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, executable: row.ExecutablePath, commandLine: row.CommandLine, name: row.Name }));
  }
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,comm=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Cannot read process identity");
    return { pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3], commandLine: match[4], name: match[3] };
  });
}

/** Refuse mutations when the target is running or process identity is unavailable. */
function assertClosed(target: string, command: Command): void {
  let rows: ProcessRecord[];
  try {
    rows = processRows();
    if (rows.some(row => /(?:^|[\\/])(?:node|pi)(?:\.exe)?$/i.test(row.name) && (!row.commandLine || !row.executable))) {
      throw new Error("A pi-capable process is not visible");
    }
  } catch (error) {
    throw new Error(`Process visibility is insufficient. Confirm pi using ${target} is closed before recovery; no files changed. Restore process-query access and rerun ${command}.`, { cause: error });
  }
  const modules = dirname(dirname(target));
  const prefix = dirname(modules);
  const paths = [join(target, CLI_PATH), ...["pi", "pi.cmd", "pi.ps1"].flatMap(name => [join(prefix, name), join(modules, ".bin", name)])];
  const pids = runningProcesses(rows, paths, process.platform === "win32");
  if (pids.length) throw new Error(`PID ${pids.join(", ")} is running ${target}. Close pi using ${target}, then rerun ${command}. No files changed.`);
}

/** This low-level transaction is also exercised with tiny disposable test files. */
export function transact(
  target: string, edits: readonly Edit[], command: "apply" | "restore", sourceDigest: string,
  replaceFile: (from: string, to: string) => void = renameSync,
): void {
  const targets = edits.map(edit => resolve(target, edit.path));
  if (!edits.length || new Set(targets.map(path => process.platform === "win32" ? path.toLowerCase() : path)).size !== edits.length) throw new Error("Empty or duplicate target plans");
  const state = safePath(target, STATE_DIR);
  const staged: string[] = [];
  let replacing = false;
  const manifest: Manifest = {
    format: 1, target, version: PI_VERSION, sourceDigest, phase: "prepared",
    files: edits.map(edit => ({ path: edit.path, originalHash: sha256(edit.original), patchedHash: sha256(edit.patched),
      ...(edit.previous === undefined ? {} : { previousHash: sha256(edit.previous) }) })),
  };
  // All current bytes and path boundaries must be checked before any staging.
  for (const edit of edits) {
    const hash = sha256(readFileSync(safePath(target, edit.path)));
    if (![edit.original, edit.patched, edit.previous].some(bytes => bytes !== undefined && sha256(bytes) === hash)) throw new Error(`Unknown edits in ${edit.path}; no files changed`);
    if (existsSync(safePath(target, stagePath(edit.path)))) throw new Error(`Staged file exists for ${edit.path}; recover it first`);
    const backup = safePath(target, backupPath(edit.path));
    if (existsSync(backup) && sha256(readFileSync(backup)) !== sha256(edit.original)) throw new Error(`Changed backup for ${edit.path}`);
  }
  mkdirSync(state, { recursive: true });
  try {
    for (const edit of edits) {
      const stage = safePath(target, stagePath(edit.path));
      durableWrite(stage, command === "apply" ? edit.patched : edit.original, true);
      staged.push(stage);
      execFileSync(process.execPath, ["--check", stage], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    }
    for (const edit of edits) {
      const backup = safePath(target, backupPath(edit.path));
      mkdirSync(dirname(backup), { recursive: true });
      if (!existsSync(backup)) durableWrite(backup, edit.original, true);
      if (sha256(readFileSync(backup)) !== sha256(edit.original)) throw new Error(`Backup verification failed for ${edit.path}`);
    }
    saveManifest(target, manifest);
    manifest.phase = command === "apply" ? "applying" : "restoring";
    saveManifest(target, manifest);
    replacing = true;
    for (const edit of edits) {
      const path = safePath(target, edit.path);
      const hash = sha256(readFileSync(path));
      if (![edit.original, edit.patched, edit.previous].some(bytes => bytes !== undefined && sha256(bytes) === hash)) throw new Error(`Concurrent edit to ${edit.path}`);
      replaceFile(safePath(target, stagePath(edit.path)), path);
      syncDirectory(dirname(path));
      if (sha256(readFileSync(path)) !== sha256(command === "apply" ? edit.patched : edit.original)) throw new Error(`Replacement verification failed for ${edit.path}`);
    }
    manifest.phase = command === "apply" ? "applied" : "restored";
    saveManifest(target, manifest);
  } catch (error) {
    const failures: string[] = [];
    if (replacing) {
      // Try every file even if a prior restoration fails. Unknown concurrent
      // changes are preserved, not overwritten in the name of rollback.
      for (const edit of edits) {
        try {
          const path = safePath(target, edit.path);
          const hash = sha256(readFileSync(path));
          if (hash === sha256(edit.original)) continue;
          if (![edit.patched, edit.previous].some(bytes => bytes !== undefined && sha256(bytes) === hash)) throw new Error("Unknown concurrent edits", { cause: error });
          const stage = safePath(target, stagePath(edit.path));
          durableWrite(stage, edit.original);
          replaceFile(stage, path);
          syncDirectory(dirname(path));
          if (sha256(readFileSync(path)) !== sha256(edit.original)) throw new Error("Original hash not restored", { cause: error });
        } catch (failure) { failures.push(`${edit.path}: ${failure instanceof Error ? failure.message : "restore failed"}`); }
      }
      manifest.phase = failures.length ? "rollback-failed" : "restored";
      try { saveManifest(target, manifest); } catch { failures.push("Could not save recovery phase"); }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}${replacing ? failures.length ? `; rollback failures: ${failures.join("; ")}` : "; rollback verified: every original hash restored" : "; no installed files replaced"}`, { cause: error });
  } finally {
    for (const path of staged) if (existsSync(path)) unlinkSync(path);
  }
}

/** Remove interrupted stages only after every staged file matches audited bytes. */
function recoverStaging(target: string, inspection: Inspection): void {
  for (const edit of inspection.edits) {
    const stage = safePath(target, stagePath(edit.path));
    if (!existsSync(stage)) continue;
    const hash = sha256(readFileSync(stage));
    if (hash !== sha256(edit.original) && hash !== sha256(edit.patched)) throw new Error(`Unknown staged bytes for ${edit.path}; preserve and inspect them`);
  }
  for (const edit of inspection.edits) {
    const stage = safePath(target, stagePath(edit.path));
    if (existsSync(stage)) unlinkSync(stage);
  }
}

export interface Status { target: string; version: string; state: Inspection["state"]; location: string; phase: string; sourceDigest: string; instruction: string }
/** Inspect an explicit installation or perform its locked, guarded apply/restore. */
export function runCorePatch(command: Command, explicitTarget: string): Status {
  if (!commands.includes(command) || !explicitTarget?.trim()) throw new Error("Use status|check|apply|restore --target <explicit-package-root>");
  const target = realpathSync(resolve(explicitTarget));
  // Only hash-keyed dependency parsing is reused across calls. Every preflight
  // rereads and hashes every file, including backups and the manifest.
  const dependencies = parsedDependencies;
  let inspection: Inspection;
  try { inspection = readInspection(target, dependencies); }
  catch (error) {
    if (command !== "status") throw error;
    return { target, version: "unverified", state: "unsupported/drifted", location: join(target, STATE_DIR), phase: "unverified", sourceDigest: patchSourceDigest(), instruction: error instanceof Error ? error.message : String(error) };
  }
  const result = (): Status => ({ target, version: PI_VERSION, state: inspection.state, location: join(target, STATE_DIR),
    phase: inspection.manifest?.phase ?? "none", sourceDigest: inspection.manifest?.sourceDigest ?? patchSourceDigest(),
    instruction: inspection.state === "interrupted managed" || inspection.state === "legacy thin-bar-only" ? "Close pi, then run restore for this target before apply." : "Close pi before apply or restore. Re-audit any pi upgrade." });
  if (command === "status") return result();
  if (command === "check") {
    if (inspection.state === "interrupted managed" || inspection.state === "legacy thin-bar-only") throw new Error(result().instruction);
    return result();
  }
  if (command === "apply" && (inspection.state === "interrupted managed" || inspection.state === "legacy thin-bar-only")) throw new Error(result().instruction);
  assertClosed(target, command);
  if (command === "apply" && inspection.state === "current managed") return result();
  const lock = safePath(target, lockPath);
  if (existsSync(lock)) {
    const recorded: { pid?: unknown } = JSON.parse(readFileSync(lock, "utf8"));
    if (typeof recorded.pid !== "number" || !Number.isSafeInteger(recorded.pid) || recorded.pid <= 0) throw new Error("Invalid operation lock; preserve it for inspection");
    let alive = true;
    try { process.kill(recorded.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error(`Patch operation PID ${recorded.pid} may still be running; no files changed`);
    if (command !== "restore") throw new Error("Interrupted operation; run restore first");
    unlinkSync(lock);
  }
  mkdirSync(safePath(target, STATE_DIR), { recursive: true });
  durableWrite(lock, JSON.stringify({ pid: process.pid }), true);
  try {
    if (command === "restore") recoverStaging(target, inspection);
    // Repeat the hash preflight after taking the lock. The lock itself marks
    // the transaction interrupted until its durable final phase is recorded.
    inspection = readInspection(target, dependencies);
    transact(target, inspection.edits, command, patchSourceDigest());
  } finally {
    unlinkSync(lock);
    const state = safePath(target, STATE_DIR);
    if (readdirSync(state).length === 0) rmdirSync(state);
  }
  inspection = readInspection(target, dependencies);
  return result();
}

/** Apply through the same guarded entry point used by the command-line interface. */
export function applyCorePatch(target: string): Status { return runCorePatch("apply", target); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, flag, target, ...extra] = process.argv.slice(2);
    if (!commands.includes(command as Command) || flag !== "--target" || !target || extra.length) throw new Error("Use npm run core-patch -- status|check|apply|restore --target <explicit-package-root>");
    const status = runCorePatch(command as Command, target);
    console.log(JSON.stringify(status, null, 2));
    if (status.state === "unsupported/drifted") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
