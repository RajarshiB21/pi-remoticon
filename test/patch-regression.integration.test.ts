// Shared-boot regression gates for the 0.86.0 port. One copy, one boot, two
// assertions: this keeps the CI Lane 2+3 step under its hard 2-minute ceiling.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let copy: PiCopy;
let term: Awaited<ReturnType<typeof bootPi>>;

describe("patch regression gates", () => {
  beforeAll(async () => {
    copy = makePiCopy();
    applyCorePatch(copy.pkgDir);
    term = await bootPi(90000, 30000, [],
      { quietStartup: true, package: true, retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 } },
      undefined, copy.cli);
  });

  afterAll(async () => {
    await term?.close();
    copy?.cleanup();
  });

  it("group header: one click toggles the group exactly once", async () => {
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
  }, 60000);

  it("cancelled retry: settles the build on Stopped", async () => {
    term.type("RETRYFAIL");
    term.press("Enter");
    await term.waitFor("Retrying", 20000);
    term.press("Escape");
    await term.waitForStable(800, 30000);
    const frame = term.viewport.getText();
    expect(frame).toContain("Retry cancelled");
    expect(frame).toContain("Stopped");
    expect(frame).not.toContain("Retrying");
    expect(frame).not.toContain("Remoticon UI patch unavailable");
  }, 60000);

  it("successful retry: completes the turn after one injected 500", async () => {
    term.type("RETRYFAIL");
    term.press("Enter");
    await term.waitFor("Retrying", 20000);
    // Wait for the scheduled retry to actually run and the response to render.
    const retryGoneBy = Date.now() + 35000;
    while (Date.now() < retryGoneBy && term.viewport.getText().includes("Retrying")) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const frame = term.viewport.getText();
    expect(frame).not.toContain("Retrying");
    expect(frame).not.toContain("Stopped");
    expect(frame).not.toContain("Remoticon UI patch unavailable");
    // The normal canned response should have arrived. (The group test leaves
    // earlier text in the scrollback, so we assert the retry finished rather
    // than a specific string.)
    expect(frame).toContain("fake-model");
  }, 60000);
}, 180000);
