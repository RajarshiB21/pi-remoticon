// S2 — Unit lane for the startup header builder. Deterministic (our renderer,
// not a model), so exact-string assertions are allowed. A stub theme makes
// fg/bold identity so the assertions read the plain text and order.
import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildHeaderLines } from "../lib/header-lines.js";

const stubTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

describe("S2: buildHeaderLines", () => {
  it("returns today's five lines at width 100", () => {
    expect(buildHeaderLines(stubTheme, "0.85.0", 100)).toEqual([
      "pi v0.85.0",
      "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
      "Press ctrl+o to show full startup help and loaded resources.",
      "",
      "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    ]);
  });
  it("wraps the two long lines at the 76-column main width, losing no words", () => {
    expect(buildHeaderLines(stubTheme, "0.85.0", 76)).toEqual([
      "pi v0.85.0",
      "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o",
      "more",
      "Press ctrl+o to show full startup help and loaded resources.",
      "",
      "Pi can explain its own features and look up its docs. Ask it how to use or",
      "extend Pi.",
    ]);
  });
  it("includes none of the loaded-resources blocks", () => {
    expect(buildHeaderLines(stubTheme, "0.85.0", 76).join("\n")).not.toContain("[Context]");
  });
});
