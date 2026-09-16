import { describe, it, expect } from "vitest";
import { HStack, visibleWidth } from "@earendil-works/pi-tui";
import { buildSplitRoot, createSplitController } from "../lib/sidebar/split.js";

const box = (text: string) => ({ render: () => [text], invalidate: () => {} });

describe("buildSplitRoot", () => {
  it("keeps 64 columns for main and reserves the rest at 120", () => {
    const root = buildSplitRoot(box("main"), 44, 64, () => true) as HStack;
    const lines = root.render(120);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBe(120);          // composite lines carry ANSI; measure cells, not length
    expect(lines[0]).toContain("main");
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
