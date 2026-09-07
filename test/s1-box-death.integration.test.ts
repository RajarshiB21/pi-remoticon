// S1 — Integration lane: the box is dead. Boot pi at fullscreen with the
// remoticon theme, run one real tool call (the fake provider emits an `ls` call
// when the message carries RUNTOOL), and prove the tool row is painted the
// terminal ground, not one of pi's default green/red/purple boxes.
//
// Three assertions, together non-trivial:
//   1. the user bar is #3a3a46 -> the theme actually loaded (so #2 isn't vacuous);
//   2. the killed tool box is painted the ground #1b1b1b -> positive evidence the
//      tool*Bg tokens resolved to ground and reached the frame;
//   3. NONE of pi's default box colours appear anywhere -> the coloured box is gone.
// Caveat recorded: theme-only box-death paints the box #1b1b1b; it is *invisible*
// only when the user's terminal bg is also #1b1b1b (mockup --bg). In this PTY the
// ground is the vterm default, so the box reads as a #1b1b1b block — which is
// exactly what we assert.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const THEME = join(repoRoot, "themes", "remoticon.json");
const themeArgs = ["--theme", THEME, "--use-theme", "remoticon"];

const GROUND = { r: 0x1b, g: 0x1b, b: 0x1b }; // #1b1b1b — killed tool box
const USERBAR = { r: 0x3a, g: 0x3a, b: 0x46 }; // #3a3a46 — proves theme is live
// pi's shipped default tool-box backgrounds (dark.json): pending/success/error.
const DEFAULT_BOXES = [
  { r: 0x28, g: 0x28, b: 0x32 },
  { r: 0x28, g: 0x32, b: 0x28 },
  { r: 0x3c, g: 0x28, b: 0x28 },
];

const eq = (c: { r: number; g: number; b: number } | null, x: { r: number; g: number; b: number }) =>
  !!c && c.r === x.r && c.g === x.g && c.b === x.b;

describe("S1: the box is dead", () => {
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000, themeArgs);
    await warm.close();
  }, 120000);

  it("renders a tool call on the terminal ground, with no default box colour", async () => {
    const term = await bootPi(60000, 20000, [...themeArgs, "List things RUNTOOL now"]);
    try {
      await term.waitFor("ok", 20000); // turn ran the tool and settled (no infinite loop)
      const screen = term.getRows().slice(-term.rows);
      const cells = screen.flat();

      // 1. theme is live
      expect(cells.some((c) => eq(c.bg, USERBAR)), "user bar not themed — theme did not load").toBe(true);
      // 2. the tool box is painted the ground colour
      expect(cells.some((c) => eq(c.bg, GROUND)), "killed tool box (#1b1b1b) not found in frame").toBe(true);
      // 3. no default coloured box anywhere
      for (const box of DEFAULT_BOXES) {
        expect(cells.some((c) => eq(c.bg, box)), `default box colour ${box.r},${box.g},${box.b} still painted`).toBe(false);
      }
    } finally {
      await term.close();
    }
  }, 120000);
});
