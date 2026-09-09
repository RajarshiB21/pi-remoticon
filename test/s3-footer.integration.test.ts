import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let copy: PiCopy;
describe("fullscreen composer/footer lifecycle", () => {
  beforeAll(() => { copy = makePiCopy(); applyCorePatch(copy.pkgDir); });
  afterAll(() => copy?.cleanup());
  it("streams, edits a draft, changes effort, resizes and settles without losing native controls", async () => {
    const term = await bootPi(30000, 15000, [], { package: true }, undefined, copy.cli);
    try {
      expect(term.viewport.getText()).toContain("auto on");
      const initialEffort = term.viewport.getText().split("\n").find(row => row.includes(" effort "));
      term.press("Shift+Tab");
      await term.waitForStable(100, 3000);
      expect(term.viewport.getText().split("\n").find(row => row.includes(" effort "))).not.toBe(initialEffort);
      term.type("POLISH"); term.press("Enter");
      await term.waitFor("Inspecting the fixture", 5000);
      term.type("draft remains");
      await term.waitFor("A full-width answer", 5000);
      expect(term.viewport.getText()).toContain("● A full-width answer");
      expect(term.viewport.getText()).toContain("draft remains");
      term.resize(60, 30);
      await term.waitFor("Finished", 5000);
      expect(term.viewport.getText()).toContain("draft remains");
      expect(term.viewport.getText()).toContain("Ready");
      expect(term.viewport.getText()).toContain("● fake-model");
      const settled = term.viewport.getText();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(term.viewport.getText()).toBe(settled);
      term.press("Ctrl+U");
      term.type("POLISH"); term.press("Enter");
      await term.waitFor("Reasoning", 5000);
      term.press("Escape");
      await term.waitFor("Stopped", 5000);
      expect(term.viewport.getText()).not.toContain("Finished ·");
      term.resize(100, 30);
      term.type("/reload"); term.press("Enter");
      await term.waitFor("effort", 5000);
      await term.waitForStable(200, 5000);
      expect(term.viewport.getText()).not.toContain("Stopped ·");
      term.type("GROUPTOOLS"); term.press("Enter");
      await term.waitFor("2 reads", 5000);
      await term.waitFor("Finished", 5000);
      term.press("Ctrl+O");
      await term.waitFor("package.json", 5000);
      term.press("Ctrl+O");
      await term.waitFor("▸ 2 reads", 5000);
      term.type("/reload"); term.press("Enter");
      await term.waitForStable(200, 5000);
      await term.waitFor("▸ 2 reads", 5000);
    } finally { await term.close(); }
  });
});
