// S0 — Termless integration spike (Integration lane).
// Proves the harness before any feature depends on it:
//   1. termless boots the real pi CLI at native fullscreen in a PTY;
//   2. it reads the VIEWPORT (not scrollback) of the frame-zero render;
//   3. the read is deterministic — two boots yield the same frame.
// Anchor is a stable, model-independent line (pi's logo), never model output.
// This test is also the behavioral guard for Rule 1: it asserts the selected
// model is the fake one and never a real/metered provider.
import { describe, it, expect, beforeAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";

// Drop pi's volatile version/update banner before comparing two boots — it is
// version-dependent chrome, not part of the UI under test. (The one-time
// fd/ripgrep download notices are already gone: beforeAll warms the cache.)
const stripVolatile = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/version|Update Available|Changelog/i.test(l))
    .join("\n");

describe("S0: termless can boot pi at fullscreen and read frame-zero", () => {
  // Warm the test HOME so fd/ripgrep are cached before the measured boots —
  // otherwise the first boot shows one-time download notices the second does not.
  beforeAll(async () => {
    const warm = await bootPi();
    await warm.close();
  });

  // Both of these inspect the same settled frame, so they share one boot.
  it("renders frame-zero: pi logo, fake model (not a real one), native fullscreen", async () => {
    const term = await bootPi();
    try {
      const frame = term.viewport.getText();
      expect(frame).toContain("pi v"); // stable anchor, model-independent
      expect(frame).toContain("fake-model"); // the fake model was selected, not a real one
      expect(frame.toLowerCase()).not.toContain("openrouter");

      // Fullscreen pins the footer/status line to the bottom row (transcript area
      // fills the middle); the default "regular" mode floats it inline ~row 15 of
      // 30. So the footer's row is the mode's fingerprint: bottom-pinned => fullscreen.
      const footer = term.findText("fake-model");
      expect(footer).not.toBeNull();
      expect(footer!.row).toBeGreaterThanOrEqual(term.rows - 2);
    } finally {
      await term.close();
    }
  });

  // Two boots, so give it headroom past the default 30s test timeout (still well
  // under the suite's 2-minute CI ceiling).
  it("reads the same frame-zero twice (determinism)", async () => {
    const a = await bootPi();
    const frameA = stripVolatile(a.viewport.getText());
    await a.close();

    const b = await bootPi();
    const frameB = stripVolatile(b.viewport.getText());
    await b.close();

    expect(frameA).toBe(frameB);
  }, 60000);
});
