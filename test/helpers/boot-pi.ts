// Integration-lane harness: boot the real pi CLI headlessly in a PTY (termless)
// and read the frame-zero viewport. This is the ONLY lane that boots pi.
//
// Discipline baked in (see the spec's "Termless discipline"):
//  - read the VIEWPORT, never the absolute scrollback buffer;
//  - assert only frame-zero (first painted, settled frame);
//  - boot pi's native fullscreen TUI via --tui-mode fullscreen (a real PTY, not
//    a fake resize, and not pi's "regular" default);
//  - no machine-absolute paths — pi is resolved from node_modules;
//  - select the fake provider so no real/metered model is ever reachable.
import { createTerminal, type TestTerminal } from "termless";
import { createVtermBackend } from "@termless/vterm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root = two levels up from test/helpers/. Exported so slice tests build
// their own paths (themes/, extensions/, fixtures/) off it, no abs paths.
export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// pi's CLI, from the repo's own node_modules (no machine-absolute path). pi's
// `exports` block ./package.json and the CJS require condition, and vitest's
// Vite runner has no import.meta.resolve, so neither resolver works in both
// runtimes — the npm install layout is stable, so join the known path.
const PI_CLI = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

// The fake model provider — loaded per-run, never shipped in extensions/.
const FAKE_PROVIDER = join(repoRoot, "test", "fixtures", "fake-provider.ts");

// A repo-local, git-ignored HOME so pi's one-time fd/ripgrep download is cached
// between runs and no ambient auth from the user's ~/.pi ever leaks in.
const TEST_HOME = join(repoRoot, ".pi-test-home");

// What actually keeps a real model unreachable (Rule 1) — not a key blanklist,
// which can never be complete (termless spawns with `...process.env`):
//   1. `--provider fake --model fake/fake-model` pins selection to the stub;
//   2. the stub's baseUrl (127.0.0.1:1) is unreachable, so even a stray turn
//      can't hit a network model;
//   3. CI runs with no provider credentials at all;
//   4. the spike test asserts the real frame shows the fake model, no openrouter.

// Boot pi at native fullscreen under the fake model, settled to frame-zero.
// Returns the live terminal; read it with `term.viewport.getText()` and always
// `await term.close()`.
//
// Defaults (15s + 15s) suit a warm boot (~2s real). The first boot on a cold
// machine pays pi's one-time fd/ripgrep download and a cold bundle load, so the
// warm-up caller passes a bigger paint budget. Ceilings, not sleeps: each
// returns the instant its condition holds. Their sum is kept below the caller's
// vitest timeout so a genuine hang fails with termless's own message.
export async function bootPi(paintMs = 15000, stableMs = 15000, extraArgs: string[] = [], env: Record<string, string> = {}, cwd = repoRoot): Promise<TestTerminal> {
  const term = createTerminal({ backend: createVtermBackend(), cols: 100, rows: 30 });

  try {
    await term.spawn(
      // --tui-mode fullscreen: pi's default is "regular"; INTENT/AGENTS require the
      // fullscreen mode, so pin it explicitly rather than trusting the default.
      // extraArgs lets a slice add its own flags (--theme, -e header.ts, ...) without
      // each slice re-implementing the boot; S0 passes none and is unchanged.
      // cwd defaults to repoRoot; override it to boot from a directory that is NOT
      // the package (the real scenario — users run pi elsewhere, with the package
      // enabled through settings).
      [process.execPath, PI_CLI, "-e", FAKE_PROVIDER, "--provider", "fake", "--model", "fake/fake-model", "--tui-mode", "fullscreen", ...extraArgs],
      {
        cwd,
        env: { TERM: "xterm-256color", HOME: TEST_HOME, USERPROFILE: TEST_HOME, ...env },
      }
    );
    await term.waitFor("pi v", paintMs);
    await term.waitForStable(400, stableMs);
    return term;
  } catch (e) {
    // Startup rejected — close the PTY so the pi child isn't leaked, then rethrow
    // the original error (close()'s own failure must not mask it).
    await term.close().catch(() => {});
    throw e;
  }
}
