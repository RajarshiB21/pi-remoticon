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
  it("keeps a column glyph to the single cell the row reserves for it", () => {
    expect(resolveGlyphs({ pending: ">>" }).pending).toBe(DEFAULT_GLYPHS.pending);        // two cells
    expect(resolveGlyphs({ completed: "\u4e2d" }).completed).toBe(DEFAULT_GLYPHS.completed); // wide
    expect(resolveGlyphs({ pending: "\u2705" }).pending).toBe(DEFAULT_GLYPHS.pending);      // wide emoji
    expect(resolveGlyphs({ spinner: ["ok", "+"] }).spinner).toEqual(DEFAULT_GLYPHS.spinner);
    expect(resolveGlyphs({ pending: "o" }).pending).toBe("o");                              // one cell is fine
  });
  it("lets the truncation marker be wider than one cell, since it is not a column glyph", () => {
    expect(resolveGlyphs({ truncation: ".." }).truncation).toBe("..");
    expect(resolveGlyphs({ truncation: "..." }).truncation).toBe("...");
    expect(resolveGlyphs({ truncation: "" }).truncation).toBe(DEFAULT_GLYPHS.truncation);
  });
});
