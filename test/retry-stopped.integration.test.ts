// Regression gate for the three retry-notice anchors: a cancelled retry must
// leave the build reporting a settled Stopped state. Native 0.86.0 and 0.85.1
// show no such state (verified 2026-09-20), so this gate is patch-driven.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let copy: PiCopy;
let term: Awaited<ReturnType<typeof bootPi>>;

describe("retry: a cancelled retry settles the build on Stopped", () => {
  beforeAll(async () => {
    copy = makePiCopy();
    applyCorePatch(copy.pkgDir);
    term = await bootPi(90000, 30000, [],
      { quietStartup: true, package: true, retry: { enabled: true, maxRetries: 3, baseDelayMs: 15000 } },
      undefined, copy.cli);
  });

  afterAll(async () => {
    await term?.close();
    copy?.cleanup();
  });

  it("reports Stopped after Escape cancels the pending retry", async () => {
    try {
      term.type("RETRYFAIL");
      term.press("Enter");
      await term.waitFor("Retrying", 20000);
      term.press("Escape");
      await term.waitForStable(800, 30000);
      const frame = term.viewport.getText();
      expect(frame).toContain("Retry cancelled");   // native transcript line, both versions
      expect(frame).toContain("Stopped");           // settled state: patch-driven
      expect(frame).not.toContain("Retrying");          // review-focus item 4: no double settle
      expect(frame).not.toContain("Remoticon UI patch unavailable"); // review-focus item 2: no silent footer degradation
    } finally {
      await term.close();
    }
  });
}, 180000);
