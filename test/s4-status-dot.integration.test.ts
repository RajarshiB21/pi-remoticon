// S4 — Integration lane. The status dot's color tracks agent state, live.
// Frame-zero: the dot is yellow (idle). Drive a fake-model turn: the dot goes
// green (working). Color-only, shape assertions (never model text — Rule 2); the
// exact working-cluster strings are unit-tested. At 100 cols the left cluster
// truncates against the pinned cwd (the S3 floor), so the clusters aren't
// on-frame — but the dot (column 0) always is, so state is read from its color.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import type { TestTerminal } from "termless";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const FOOTER = join(repoRoot, "extensions", "footer.ts");
const footerArgs = ["-e", FOOTER];

const IDLE = { r: 0xe0, g: 0xb3, b: 0x41 }; // #e0b341 yellow
const WORKING = { r: 0x6c, g: 0xc0, b: 0x4a }; // #6cc04a green

// Scan the visible viewport for a cell painted the given fg color.
function hasColorCell(term: TestTerminal, c: { r: number; g: number; b: number }): boolean {
  for (const rowCells of term.getRows().slice(-term.rows)) {
    for (const cell of rowCells) {
      const fg = cell.fg;
      if (fg && fg.r === c.r && fg.g === c.g && fg.b === c.b) return true;
    }
  }
  return false;
}

describe("S4: status dot color tracks agent state", () => {
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000, footerArgs);
    await warm.close();
  });

  it("is yellow at idle frame-zero", async () => {
    const term = await bootPi(15000, 15000, footerArgs);
    try {
      expect(hasColorCell(term, IDLE), "no idle-yellow dot at frame-zero").toBe(true);
    } finally {
      await term.close();
    }
  });

  it("turns green while a turn runs", async () => {
    const term = await bootPi(15000, 15000, footerArgs);
    try {
      expect(hasColorCell(term, IDLE)).toBe(true); // idle before submit
      term.type("hi");
      term.press("Enter"); // named key is case-sensitive — "enter" would type literal text
      // The fake stream holds the working state ~300ms; poll for the green dot.
      let green = false;
      for (let i = 0; i < 40 && !green; i++) {
        await new Promise((r) => setTimeout(r, 100));
        green = hasColorCell(term, WORKING);
      }
      expect(green, "dot never turned working-green during the turn").toBe(true);
    } finally {
      await term.close();
    }
  });
});
