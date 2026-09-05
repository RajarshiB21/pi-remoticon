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

// Repo root = two levels up from test/helpers/.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

// Blank every known provider key so a real model is physically unreachable.
const BLANKED_KEYS = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
];

// Boot pi at native fullscreen under the fake model, settled to frame-zero.
// Returns the live terminal; read it with `term.viewport.getText()` and always
// `await term.close()`.
export async function bootPi(): Promise<TestTerminal> {
  const term = createTerminal({ backend: createVtermBackend(), cols: 100, rows: 30 });

  await term.spawn(
    // --tui-mode fullscreen: pi's default is "regular"; INTENT/AGENTS require the
    // fullscreen mode, so pin it explicitly rather than trusting the default.
    [process.execPath, PI_CLI, "-e", FAKE_PROVIDER, "--provider", "fake", "--model", "fake/fake-model", "--tui-mode", "fullscreen"],
    {
      cwd: repoRoot,
      env: {
        TERM: "xterm-256color",
        HOME: TEST_HOME,
        USERPROFILE: TEST_HOME,
        ...Object.fromEntries(BLANKED_KEYS.map((k) => [k, ""])),
      },
    }
  );

  await term.waitFor("pi v", 20000);
  await term.waitForStable(400, 20000);
  return term;
}
