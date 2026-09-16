// S4 — Integration lane: the sidebar end to end. Boots the patched pi with the
// package loaded (so extensions/sidebar.ts is active), then resizes wide enough
// for the column to appear. Two boots: normal, and NO_COLOR + motion-off together.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let copy: PiCopy;
afterAll(() => { copy?.cleanup(); });

// The hint line is 79 cells. It stays on one line only while the main column is
// wider than that, so its presence is the cheapest proof of how much width main
// actually got (and its absence, that the sidebar is reserving 44 columns).
const HINT = "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more";

describe("S4: sidebar with TASKS slot", () => {
  beforeAll(() => { copy = makePiCopy(); applyCorePatch(copy.pkgDir); });

  it("boot 1: panel appears, tasks live, /sidebar off and on, typing unaffected", async () => {
    const term = await bootPi(30000, 15000, [], { package: true, skill: true }, undefined, copy.cli);
    try {
      term.resize(120, 36);                                       // 100 columns is below the 108 threshold
      await term.waitFor("TASKS", 5000);
      await term.waitFor("No tasks", 5000);                       // empty TASKS slot
      expect(term.viewport.getText()).not.toContain(HINT);        // main is narrowed to 76, so the hint wraps
      term.type("TASKPLAN"); term.press("Enter");
      await term.waitFor("3 pending", 10000);                     // the summary line: panel-only text
      const created = term.viewport.getText();
      expect(created).toContain("\u25CB 01");
      expect(created).toContain("Sidebar task 1");
      term.type("TASKGO"); term.press("Enter");
      await term.waitFor("1 completed", 10000);
      expect(term.viewport.getText()).toContain("\u2714 1 completed \u00B7 2 pending");
      term.type("draft remains");                                 // typing reaches the editor while the sidebar is up
      await term.waitFor("draft remains", 5000);
      expect(term.viewport.getText()).toContain("TASKS");         // the overlay never stole input
      term.press("Ctrl+U");
      term.type("/sidebar off"); term.press("Enter");
      await term.waitForStable(100, 3000);
      const off = term.viewport.getText();
      expect(off).not.toContain("TASKS");                          // column gone...
      expect(off).toContain(HINT);                                 // ...and main has the full width back
      term.type("/sidebar on"); term.press("Enter");
      await term.waitFor("TASKS", 5000);                           // on shows immediately
      term.resize(100, 30);                                        // below 108: hidden, no artifacts
      await term.waitForStable(100, 3000);
      const narrow = term.viewport.getText();
      expect(narrow).not.toContain("TASKS");
      // The footer rule ends with the effort label, so its exact length is main's width:
      // 100 here. A still-reserved column would leave it at 56, and the label truncated.
      expect(narrow.split("\n").find(row => row.includes(" effort "))!.length).toBe(100);
    } finally { await term.close(); }
  }, 120000);

  it("boot 2: NO_COLOR keeps all text; motion off freezes the spinner", async () => {
    const term = await bootPi(30000, 15000, [], { package: true, skill: true, env: { NO_COLOR: "1", PI_REMOTICON_MOTION: "off" } }, undefined, copy.cli);
    try {
      term.resize(120, 36);
      await term.waitFor("TASKS", 5000);
      term.type("TASKPLAN"); term.press("Enter");
      await term.waitFor("3 pending", 10000);
      term.type("TASKGO"); term.press("Enter");
      await term.waitFor("\u2733", 10000);                        // caught while task 1 is in progress: the panel
      const during = term.viewport.getText();                      // shows only the subject, so the glyph is the signal
      expect(during).toContain("\u2733");                          // frozen spinner frame 0 is still drawn
      expect(during).not.toContain("\u273D");                      // frame 1 never appears
      await term.waitFor("1 completed \u00B7 2 pending", 10000);    // second provider turn marks it done
      const done = term.viewport.getText();
      expect(done).toContain("Sidebar task 1");                    // all text present with no color
      expect(done).toContain("\u25CF 01");                         // completed glyph, plain text
    } finally { await term.close(); }
  }, 120000);
});
