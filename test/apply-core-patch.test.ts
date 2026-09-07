// P0 — Unit lane for the core-patch apply logic.
// Exercises decideEntry (the pure guard) against fixture chunk maps: the happy
// path, the missing-string failure, idempotency, and the ambiguous-target guard.
// No file I/O, no pi boot (that's the Integration lane's drift guard).
import { describe, it, expect } from "vitest";
import { decideEntry, PATCHES, type PatchEntry } from "../scripts/apply-core-patch.js";

const entry: PatchEntry = {
  name: "test-entry",
  find: `new Box(this.outputPad,1,x)`,
  replace: `new Box(this.outputPad,0,x)`,
};

// A realistic chunk body so the find-string isn't the whole file.
const wrap = (line: string) => `import{Box}from"./chunk-A.js";class U{rebuild(){let b=${line};}}`;

describe("P0: decideEntry (patch guard logic)", () => {
  it("happy path: finds the string once and returns the replaced content", () => {
    const files = new Map([["chunk-A.js", wrap(entry.find)]]);
    const d = decideEntry(files, entry);
    expect(d.kind).toBe("apply");
    if (d.kind !== "apply") throw new Error("unreachable");
    expect(d.file).toBe("chunk-A.js");
    expect(d.next).toContain(entry.replace);
    expect(d.next).not.toContain(entry.find);
  });

  it("finds the target even when it lives in one of several chunks", () => {
    const files = new Map([
      ["chunk-A.js", `noise();`],
      ["chunk-B.js", wrap(entry.find)],
      ["chunk-C.js", `more();`],
    ]);
    const d = decideEntry(files, entry);
    expect(d.kind).toBe("apply");
    if (d.kind !== "apply") throw new Error("unreachable");
    expect(d.file).toBe("chunk-B.js");
  });

  it("missing string: throws loudly, naming the missing string (the drift guard)", () => {
    const files = new Map([["chunk-A.js", `nothing to see here`]]);
    expect(() => decideEntry(files, entry)).toThrow(/not found/);
    expect(() => decideEntry(files, entry)).toThrow(entry.find);
  });

  it("idempotent: replacement already present -> already-applied, no error", () => {
    const files = new Map([["chunk-A.js", wrap(entry.replace)]]);
    const d = decideEntry(files, entry);
    expect(d.kind).toBe("already-applied");
  });

  it("ambiguous: find-string appears more than once -> throws, refuses to patch", () => {
    const files = new Map([["chunk-A.js", wrap(entry.find) + wrap(entry.find)]]);
    expect(() => decideEntry(files, entry)).toThrow(/ambiguous/);
  });

  it("ambiguous across two chunks also throws", () => {
    const files = new Map([
      ["chunk-A.js", wrap(entry.find)],
      ["chunk-B.js", wrap(entry.find)],
    ]);
    expect(() => decideEntry(files, entry)).toThrow(/ambiguous/);
  });

  it("mixed state: replacement in one chunk while an original target still exists elsewhere -> throws, never 'already applied'", () => {
    const files = new Map([
      ["chunk-A.js", wrap(entry.replace)], // already patched
      ["chunk-B.js", wrap(entry.find)], // still original — must not be silently skipped
    ]);
    expect(() => decideEntry(files, entry)).toThrow(/inconsistent/);
  });

  it("mixed state within one chunk also throws", () => {
    const files = new Map([["chunk-A.js", wrap(entry.find) + wrap(entry.replace)]]);
    expect(() => decideEntry(files, entry)).toThrow(/inconsistent/);
  });
});

describe("P0: the shipped patch list", () => {
  it("carries exactly the bar-height entry, in condensed (bundled) form", () => {
    expect(PATCHES).toHaveLength(1);
    const p = PATCHES[0];
    expect(p.name).toBe("user-message-bar-height");
    // Condensed form (no spaces, arrow without parens) — the bundled shape, not
    // the pretty dist/modes source. find and replace differ only in 1 -> 0.
    expect(p.find).toContain("this.outputPad,1,");
    expect(p.replace).toContain("this.outputPad,0,");
    expect(p.find.replace(",1,", ",0,")).toBe(p.replace);
  });
});
