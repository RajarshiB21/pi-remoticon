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
import { VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

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

// Ack pi's changelog for the CURRENTLY installed version. After a pi update, a
// home whose lastChangelogVersion is older than pi shows a full-screen changelog
// instead of the normal header — which hides "pi v", so every frame-zero boot
// hangs until timeout. Pinning to the live VERSION (not a hardcoded string) means
// no test goes stale on the next update. Merges into any existing settings so a
// caller's quietStartup/packages/theme survive.
export function ackChangelog(home: string): void {
  const dir = join(home, ".pi", "agent");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // Only a plain object can carry the ack. null/array/primitive settings
      // would throw on assignment or (for []) be dropped by JSON.stringify,
      // silently leaving the changelog unacknowledged — so fall back to {}.
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      settings = {};
    }
  }
  settings.lastChangelogVersion = VERSION;
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

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

  // Ack the changelog in every dir pi might read for config, so an update never
  // hangs the boot behind the changelog view. The spawn sets HOME and USERPROFILE
  // (Linux reads HOME, Windows USERPROFILE); stamp both effective values so it
  // holds even if a caller overrides only one.
  for (const dir of new Set([env.HOME ?? TEST_HOME, env.USERPROFILE ?? TEST_HOME])) {
    ackChangelog(dir);
  }

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
        // Pin truecolor. Without a truecolor hint pi falls back to the nearest
        // 256-color approximation (e.g. #d99a5c -> 215,135,95), and the decision
        // is OS-dependent — Windows consoles force truecolor, Linux CI does not —
        // so an exact-RGB color assertion passes locally and fails on CI. We set
        // both the standard hint (COLORTERM=truecolor, what a real 24-bit terminal
        // sends) and pi's explicit override (PI_TRUE_COLOR=1) so pi emits 24-bit on
        // every machine regardless of terminal detection. Verified locally: with
        // truecolor the composer border reads exactly 217,154,92; forced off, 215,135,95.
        //
        // COLORTERM/PI_TRUE_COLOR come AFTER `...env`: they are harness invariants
        // (deterministic color is non-negotiable), so a caller's env override cannot
        // silently reintroduce 256-color output. TERM/HOME/USERPROFILE stay before
        // the spread, so callers may still override them (e.g. a per-test HOME).
        env: { TERM: "xterm-256color", HOME: TEST_HOME, USERPROFILE: TEST_HOME, ...env, COLORTERM: "truecolor", PI_TRUE_COLOR: "1" },
      }
    );
    // Two anchors, top and bottom, THEN settle. "pi v" (the logo) proves the
    // top painted; "fake-model" (the footer model id) proves the BOTTOM UI —
    // the footer and the composer border just above it — painted too. Waiting on
    // the top anchor alone is the frame-zero race that flaked CI: on a slower box
    // pi has a quiet gap after the logo, waitForStable returns inside it, and the
    // composer border has not painted yet. waitFor blocks until the text exists
    // regardless of quiet gaps, so the bottom anchor closes that race; the final
    // waitForStable then lets any last paint settle before we capture.
    await term.waitFor("pi v", paintMs);
    await term.waitFor("fake-model", paintMs);
    await term.waitForStable(400, stableMs);
    return term;
  } catch (e) {
    // Startup rejected — close the PTY so the pi child isn't leaked, then rethrow
    // the original error (close()'s own failure must not mask it).
    await term.close().catch(() => {});
    throw e;
  }
}
