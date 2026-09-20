// Regression gate for the group header click path: one click toggles the group
// exactly once. A double-processing handler nets out to "no change", so the
// assertion is the flip per click, not the absence of a crash.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let copy: PiCopy;
let term: Awaited<ReturnType<typeof bootPi>>;

describe("tool group: one click toggles the group exactly once", () => {
  beforeAll(async () => {
    copy = makePiCopy();
    applyCorePatch(copy.pkgDir);
    term = await bootPi(90000, 30000, [], { quietStartup: true, package: true }, undefined, copy.cli);
  });

  afterAll(async () => {
    await term?.close();
    copy?.cleanup();
  });

  it("flips expansion on every click and never double-toggles", async () => {
    try {
      term.type("GROUPTOOLS");
      term.press("Enter");
      await term.waitForStable(1200, 30000);
      const header = term.findAllText(/Read \d+ file/)[0];
      expect(header).toBeDefined();
      const expanded = () => term.viewport.getText().includes("package.json");
      expect(expanded()).toBe(false);
      const states: boolean[] = [];
      for (let n = 0; n < 3; n++) {
        term.click(header.col + 2, header.row);
        await term.waitForStable(600, 10000);
        states.push(expanded());
      }
      expect(states).toEqual([true, false, true]);
    } finally {
      await term.close();
    }
  });
}, 180000);
