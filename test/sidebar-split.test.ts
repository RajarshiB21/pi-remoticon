import { describe, it, expect } from "vitest";
import { HStack, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { buildSplitRoot, createSplitController, MIN_MAIN_WIDTH, DEFAULT_SIDEBAR_WIDTH } from "../lib/sidebar/split.js";

const box = (text: string) => ({ render: () => [text], invalidate: () => {} });
const visibleAt = (width: number) => width >= MIN_MAIN_WIDTH + DEFAULT_SIDEBAR_WIDTH;   // 108

// `isViewportTUI` tests for a global symbol pi-tui does not re-export. If that ever changes,
// the first test below fails on its `onError` assertion rather than passing vacuously.
const VIEWPORT = Symbol.for("@earendil-works/pi-tui/viewport");
function fakeViewport(layoutRoot: unknown) {
  const state = { root: layoutRoot };
  const fake = {
    mode: "fullscreen",
    [VIEWPORT]: true,
    get layoutRoot() { return state.root; },
    setLayoutRoot(component: unknown) { state.root = component; },
    requestRender() {},
  };
  return { fake: fake as unknown as TUI, state };
}

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
    const { fake } = fakeViewport(box("main"));
    const c = createSplitController({ width: 44 });
    c.attach(fake);
    c.show();                                          // visibility also requires enabled + reserved
    const o = c.overlayOptions() as Record<string, unknown>;
    expect(o.anchor).toBe("top-right");
    expect(o.width).toBe(44);
    expect(o.maxHeight).toBe("100%");
    expect(o.nonCapturing).toBe(true);
    expect((o.visible as (w: number) => boolean)(108)).toBe(true);
    expect((o.visible as (w: number) => boolean)(107)).toBe(false);
  });
  it("needs show() as well as a reserved column to be visible", () => {
    const { fake } = fakeViewport(box("main"));
    const c = createSplitController({ width: 44 });
    const visible = (c.overlayOptions() as Record<string, unknown>).visible as (w: number) => boolean;
    c.attach(fake);
    expect(visible(200)).toBe(false);                  // reserved, but not enabled
    c.show();
    expect(visible(200)).toBe(true);
    c.hide();
    expect(visible(200)).toBe(false);
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

describe("the column must be reserved before the overlay paints", () => {
  it("reports once and stays hidden when the layout root is unavailable", () => {
    const errors: unknown[] = [];
    const { fake, state } = fakeViewport(undefined);
    const c = createSplitController({ width: 44, onError: e => errors.push(e) });
    c.attach(fake);
    c.show();
    expect(errors).toHaveLength(1);            // one warning, naming the real cause
    expect(state.root).toBeUndefined();        // the native layout was left untouched
    // Regression: show() alone used to make this true, painting 44 columns over live main content.
    expect((c.overlayOptions().visible as (w: number) => boolean)(200)).toBe(false);
  });
  it("reserves the column, paints, and gives the width back on dispose", () => {
    const original = box("main");
    const errors: unknown[] = [];
    const { fake, state } = fakeViewport(original);
    const c = createSplitController({ width: 44, onError: e => errors.push(e) });
    c.attach(fake);
    c.show();
    expect(errors).toEqual([]);
    expect(state.root).not.toBe(original);                          // wrapped in the split root
    expect((c.overlayOptions().visible as (w: number) => boolean)(200)).toBe(true);
    expect((c.overlayOptions().visible as (w: number) => boolean)(107)).toBe(false);
    c.dispose();
    expect(state.root).toBe(original);                              // restored
    expect((c.overlayOptions().visible as (w: number) => boolean)(200)).toBe(false);
  });
});
