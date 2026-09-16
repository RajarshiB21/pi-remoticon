import { describe, it, expect } from "vitest";
import { resolveGlyphs, DEFAULT_GLYPHS } from "../lib/sidebar/tasks/glyphs.js";

describe("sidebar glyphs", () => {
  it("defaults to the owner's set", () => {
    expect(DEFAULT_GLYPHS).toEqual({ pending: "\u25CB", completed: "\u25CF", spinner: ["\u2733", "\u273D"], summary: "\u2714", truncation: "..." });
  });
  it("overrides per glyph and falls back per glyph", () => {
    const g = resolveGlyphs({ pending: "o", garbage: 1 });
    expect(g.pending).toBe("o");
    expect(g.completed).toBe(DEFAULT_GLYPHS.completed);
  });
  it("rejects control characters and bidi overrides", () => {
    expect(resolveGlyphs({ pending: "a\u0007b" }).pending).toBe(DEFAULT_GLYPHS.pending);
    expect(resolveGlyphs({ pending: "x\u202E" }).pending).toBe(DEFAULT_GLYPHS.pending);
  });
  it("replaces the spinner as a whole only", () => {
    expect(resolveGlyphs({ spinner: ["*", "+"] }).spinner).toEqual(["*", "+"]);
    expect(resolveGlyphs({ spinner: ["*"] }).spinner).toEqual(DEFAULT_GLYPHS.spinner);
    expect(resolveGlyphs({ spinner: ["", ""] }).spinner).toEqual(DEFAULT_GLYPHS.spinner);
  });
});
