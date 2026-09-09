// S1 — Integration lane: the box is dead. Boot pi at fullscreen with the
// remoticon theme, run one real tool call (the fake provider emits a `read`
// call — a registered pi tool, read-only, deterministic — when the message
// carries RUNTOOL), and prove the tool row paints NO background at all.
//
// Mechanism: toolPendingBg/toolSuccessBg/toolErrorBg are the empty string —
// pi's schema-sanctioned "terminal default". The theme engine's bgAnsi("")
// emits only a background reset, so the tool Box wrapper paints nothing; the
// row sits directly on whatever background the user's terminal has. No color
// literal could do that (a #1b1b1b box only blends on a #1b1b1b terminal).
//
// Three assertions, together non-trivial:
//   1. the user-message bar is #24262c -> the theme actually loaded (so the
//      rest isn't vacuous);
//   2. the settled frame shows the tool row ("read package.json" — our own
//      deterministic call text, not model output) -> a real tool call rendered
//      through ToolExecutionComponent;
//   3. the ONLY painted background in the whole frame is the user bar's #24262c
//      -> the tool box (and anything else) paints nothing: no ground block, no
//      pi default green/red/purple box, no other fill.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const THEME = join(repoRoot, "themes", "remoticon.json");
const themeArgs = ["--theme", THEME, "--use-theme", "remoticon"];

const USERBAR = { r: 0x24, g: 0x26, b: 0x2c }; // #24262c — the user message bar
const eq = (c: { r: number; g: number; b: number } | null, x: { r: number; g: number; b: number }) =>
  !!c && c.r === x.r && c.g === x.g && c.b === x.b;

describe("S1: the box is dead", () => {
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000, themeArgs);
    await warm.close();
  }, 120000);

  it("renders a tool call with no painted box — only the user bar carries a background", async () => {
    const term = await bootPi(60000, 20000, [...themeArgs, "List things RUNTOOL now"]);
    try {
      await term.waitFor("ok", 20000); // turn ran the tool and settled (no infinite loop)
      const frame = term.viewport.getText();
      const cells = term.getRows().slice(-term.rows).flat();

      // 1. theme is live
      expect(cells.some((c) => eq(c.bg, USERBAR)), "user bar not themed — theme did not load").toBe(true);
      // 2. the tool row itself is on screen (deterministic call text from our fixture)
      expect(frame, "tool row 'read package.json' not in frame").toContain("read package.json");
      // 3. every painted background cell is the user bar's — the tool box paints nothing
      for (const cell of cells) {
        if (cell.bg) {
          expect(eq(cell.bg, USERBAR), `unexpected painted background ${cell.bg.r},${cell.bg.g},${cell.bg.b} — the tool box should paint nothing`).toBe(true);
        }
      }
    } finally {
      await term.close();
    }
  }, 120000);
});
