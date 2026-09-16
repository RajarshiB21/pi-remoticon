import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makePainter, dockLine, boxTop, boxRow, boxBottom, clip, type Painter } from "../lib/sidebar/paint.js";

const p: Painter = makePainter({ fg: (_r, t) => t, bold: t => t });

describe("paint: role fallback", () => {
  it("falls back to the text role once when the theme throws for a role", () => {
    const calls: string[] = [];
    let seen = false;
    const theme = { fg(role: string, t: string) { if (role === "customMessageLabel" && seen) throw new Error("unknown"); if (role === "customMessageLabel") { seen = true; throw new Error("unknown"); } return t; }, bold: (t: string) => t };
    const q = makePainter(theme, r => calls.push(r));
    q.fg("customMessageLabel", "x"); q.fg("customMessageLabel", "y");
    expect(calls).toEqual(["customMessageLabel"]);       // reported once
  });
});

describe("paint: box geometry", () => {
  it("boxTop is exactly boxWidth cells and contains the title", () => {
    const line = boxTop(p, "TASKS", 42);
    expect(visibleWidth(line)).toBe(42);
    expect(line).toContain("TASKS");
  });
  it("boxRow pads inner content to the 38-cell field at boxWidth 42", () => {
    expect(visibleWidth(boxRow(p, "hello", 42))).toBe(42);
    expect(visibleWidth(boxRow(p, "x".repeat(60), 42))).toBe(42);   // over-wide never exceeds
  });
  it("boxBottom closes at exactly boxWidth cells", () => {
    expect(visibleWidth(boxBottom(p, 42))).toBe(42);
  });
  it("dockLine puts the dock glyph first and pads to the column width", () => {
    const line = dockLine(p, boxTop(p, "TASKS", 42), 44);
    expect(visibleWidth(line)).toBe(44);
    expect(line[0]).toBe("│");
  });
  it("clip appends the three-dot marker and lands exactly on the width", () => {
    expect(clip("Write the sidebar compose tests", 31)).toBe("Write the sidebar compose tests");
    const clipped = clip("Write the sidebar compose tests now", 31);
    expect(clipped).toBe("Write the sidebar compose te...");
    expect(visibleWidth(clipped)).toBe(31);
  });
  it("clips by display cells, so a wide-character subject still fits the field", () => {
    // Counting code points let a CJK subject run past the 31-cell field and break the box.
    const cjk = clip("\u4e2d".repeat(20), 31);
    expect(visibleWidth(cjk)).toBe(31);
    expect(cjk.endsWith("...")).toBe(true);
    const mixed = clip("ab\u4e2d".repeat(12), 31);
    expect(visibleWidth(mixed)).toBeLessThanOrEqual(31);
    expect(visibleWidth(clip("\u4e2d".repeat(5), 31))).toBe(10);   // already fits: untouched
  });
});
