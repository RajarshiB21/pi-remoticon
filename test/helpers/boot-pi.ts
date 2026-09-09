// Each fullscreen boot owns fresh config and sessions. Only search binaries
// are shared between boots; no auth, settings or sessions are copied.
import { createTerminal, type TestTerminal } from "termless";
import { createVtermBackend } from "@termless/vterm";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { testEnvironment } from "./test-environment.js";

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PI_CLI = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const FAKE_PROVIDER = join(repoRoot, "test", "fixtures", "fake-provider.ts");
const CACHED_BIN = join(repoRoot, ".pi-test-home", ".pi", "agent", "bin");

/** Acknowledge this pi version only in the owned test settings directory. */
export function ackChangelog(home: string): void {
  const dir = join(home, ".pi", "agent");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch { /* A malformed test setting must not open the changelog screen. */ }
  }
  settings.lastChangelogVersion = VERSION;
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** Only fixture presentation inputs may follow the controlled fake selection. */
export function validateTestArgs(args: readonly string[]): void {
  const extensions = ["header.ts", "footer.ts"].map(name => join(repoRoot, "extensions", name));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-e" || arg === "--extension") {
      if (!args[i + 1] || !extensions.includes(resolve(args[++i]))) throw new Error("Only product UI extensions may be loaded by this helper");
    } else if (arg === "--theme") {
      if (!args[i + 1] || resolve(args[++i]) !== join(repoRoot, "themes", "remoticon.json")) throw new Error("Only the product theme may be loaded by this helper");
    } else if (arg === "--use-theme") {
      if (args[++i] !== "remoticon") throw new Error("Only the remoticon theme may be selected");
    } else if (arg.startsWith("-") || arg.startsWith("@") || ["install", "remove", "update", "list", "config"].includes(arg)) {
      throw new Error("Unsupported test argument; provider, model, auth and config overrides are forbidden");
    }
  }
}

export interface BootSettings { quietStartup?: boolean; package?: boolean }

/** Boot the offline fake model with fresh directories, removed when the terminal closes. */
export async function bootPi(paintMs = 15000, stableMs = 15000, extraArgs: string[] = [], settings: BootSettings = {}, cwd?: string, piCli = PI_CLI): Promise<TestTerminal> {
  validateTestArgs(extraArgs);
  if (Object.keys(settings).some(key => key !== "quietStartup" && key !== "package")) throw new Error("Only fixture startup/package settings are allowed");
  const home = mkdtempSync(join(tmpdir(), "pi-test-"));
  let term: TestTerminal | undefined;
  try {
    cwd ??= home;
    writeFileSync(join(home, "package.json"), '{"name":"offline-tool-fixture","private":true}\n');
    const agentDir = join(home, ".pi", "agent");
    const bin = join(agentDir, "bin");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      quietStartup: settings.quietStartup ?? false,
      ...(settings.package ? { packages: [repoRoot], theme: "remoticon" } : {}),
    }));
    ackChangelog(home);
    if (existsSync(CACHED_BIN)) cpSync(CACHED_BIN, bin, { recursive: true });
    term = createTerminal({ backend: createVtermBackend(), cols: 100, rows: 30 });
    const close = term.close.bind(term);
    let closing: Promise<void> | undefined;
    term.close = () => closing ??= (async () => {
      await close();
      rmSync(home, { recursive: true, force: true });
    })();
    term[Symbol.asyncDispose] = term.close;
    await term.spawn([
      process.execPath, piCli, "-e", FAKE_PROVIDER, "--provider", "fake", "--model", "fake/fake-model",
      "--tui-mode", "fullscreen", "--offline", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve", ...extraArgs,
    ], { cwd, env: testEnvironment(home) });
    await term.waitFor("pi v", paintMs);
    await term.waitFor("fake-model", paintMs);
    await term.waitForStable(400, stableMs);
    if (existsSync(bin)) {
      mkdirSync(CACHED_BIN, { recursive: true });
      cpSync(bin, CACHED_BIN, { recursive: true });
    }
    return term;
  } catch (error) {
    try { if (term) await term.close(); else rmSync(home, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "pi startup and cleanup both failed", { cause: cleanupError }); }
    throw error;
  }
}
