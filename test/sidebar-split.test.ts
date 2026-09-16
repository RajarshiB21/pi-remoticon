import { describe, it, expect } from "vitest";
import { HStack, visibleWidth } from "@earendil-works/pi-tui";
import { buildSplitRoot, createSplitController, MIN_MAIN_WIDTH, DEFAULT_SIDEBAR_WIDTH } from "../lib/sidebar/split.js";

const box = (text: string) => ({ render: () => [text], invalidate: () => {} });
const visibleAt = (width: number) => width >= MIN_MAIN_WIDTH + DEFAULT_SIDEBAR_WIDTH;   // 108

describe("buildSplitRoot", () => {
  it("reserves 44 columns for the sidebar and gives main the rest at 120", () => {
    const root = buildSplitRoot(box("main"), 44, () => true) as HStack;
    const lines = root.render(120);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBe(120);          // composite lines carry ANSI; measure cells, not length
    expect(lines[0]).toContain("main");
  });
  it("never renders main wider than the terminal, at or below the visibility threshold", () => {
    // Regression: main's minSize used to be a static 64, which rendered main 64 cells
    // wide on a 60-cell terminal even with the column hidden — the terminal then
    // clipped the right edge of the footer.
    for (const width of [40, 60, 64, 100, 107, 108, 120]) {
      const root = buildSplitRoot(box("main"), 44, visibleAt) as HStack;
      expect(visibleWidth(root.render(width)[0])).toBe(width);
    }
  });
});

describe("controller", () => {
  it("exposes the overlay options the spec fixes", () => {
    const c = createSplitController({ width: 44 });
    c.show();                                          // visibility also requires enabled
    const o = c.overlayOptions() as Record<string, unknown>;
    expect(o.anchor).toBe("top-right");
    expect(o.width).toBe(44);
    expect(o.maxHeight).toBe("100%");
    expect(o.nonCapturing).toBe(true);
    expect((o.visible as (w: number) => boolean)(108)).toBe(true);
    expect((o.visible as (w: number) => boolean)(107)).toBe(false);
  });
  it("stays hidden until show() is called", () => {
    const c = createSplitController({ width: 44 });
    const o = c.overlayOptions() as Record<string, unknown>;
    expect((o.visible as (w: number) => boolean)(200)).toBe(false);   // enabled is still false
    c.show();
    expect((o.visible as (w: number) => boolean)(200)).toBe(true);
  });
  it("show/hide/isEnabled and rebuild track state; dispose is idempotent", () => {
    const c = createSplitController({ width: 44 });
    expect(c.isEnabled()).toBe(false);
    c.show(); expect(c.isEnabled()).toBe(true);
    c.hide(); expect(c.isEnabled()).toBe(false);
    c.rebuild(50);
    expect((c.overlayOptions() as Record<string, unknown>).width).toBe(50);
    c.dispose(); c.dispose();
  });
  it("rebuild while unattached stores the new width for the next attach", () => {
    const c = createSplitController({ width: 44 });
    c.rebuild(28);
    expect((c.overlayOptions() as Record<string, unknown>).width).toBe(28);
  });
});
