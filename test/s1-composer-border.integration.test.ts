// S1 — Integration lane. Boot pi at fullscreen under the fake model with the
// remoticon theme loaded + selected, and prove the composer border rendered in
// the one static tan. Shape/smoke only: we assert the tan color reached the
// painted frame, not any model text. #d99a5c is unique in the base theme, so a
// tan cell at frame-zero can only be the editor border adopting our override.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const THEME = join(repoRoot, "themes", "remoticon.json");
const themeArgs = ["--theme", THEME, "--use-theme", "remoticon"];

// #d99a5c
const TAN = { r: 0xd9, g: 0x9a, b: 0x5c };

describe("S1: composer border renders in the static tan", () => {
  // Warm the test HOME once (cold boot pays pi's one-time fd/ripgrep download);
  // the measured boot that follows is warm and fast.
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000, themeArgs);
    await warm.close();
  });

  it("has at least one frame-zero cell painted #d99a5c (the border)", async () => {
    const term = await bootPi(15000, 15000, themeArgs);
    try {
      // Read the VIEWPORT, not the absolute scrollback buffer (the pinned rule):
      // getRows() returns the whole buffer with the screen as its last `rows`
      // entries, so slice(-rows) is exactly the visible screen regardless of any
      // scrollback. (term.row(n) indexes absolute buffer rows — row 0 is the
      // oldest scrollback — so it is the trap here, not the fix.)
      const screen = term.getRows().slice(-term.rows);
      let found = false;
      for (const rowCells of screen) {
        for (const cell of rowCells) {
          const fg = cell.fg;
          if (fg && fg.r === TAN.r && fg.g === TAN.g && fg.b === TAN.b) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      expect(found, "no cell painted the static composer tan #d99a5c").toBe(true);
    } finally {
      await term.close();
    }
  });
});
