// S2 — Unit lane for the startup header builder. Deterministic (our renderer,
// not a model), so exact-string assertions are allowed. A stub theme makes
// fg/bold identity so the assertions read the plain text and order.
import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildHeaderLines } from "../lib/header-lines.js";

const stubTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

describe("S2: buildHeaderLines", () => {
  const lines = buildHeaderLines(stubTheme, "0.85.0");

  it("returns the kept lines in the mockup's order", () => {
    expect(lines).toEqual([
      "pi v0.85.0",
      "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
      "Press ctrl+o to show full startup help and loaded resources.",
      "",
      "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    ]);
  });

  it("includes none of the three loaded-resources blocks", () => {
    const joined = lines.join("\n");
    for (const block of ["[Context]", "[Skills]", "[Extensions]"]) {
      expect(joined).not.toContain(block);
    }
  });
});
