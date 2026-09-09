// S2 — Integration lane. Boot pi at fullscreen with quietStartup:true and the
// header extension loaded, and prove the end state: the kept header lines are
// present and the [Context]/[Skills]/[Extensions] listing is gone. Shape/smoke
// only (our deterministic renderer, no model text).
//
// The helper writes quietStartup into fresh settings for each boot.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const HEADER = join(repoRoot, "extensions", "header.ts");
const headerArgs = ["-e", HEADER];

const settings = { quietStartup: true };
let term: Awaited<ReturnType<typeof bootPi>>;

describe("S2: custom header (quietStartup + rebuild)", () => {
  beforeAll(async () => {
    term = await bootPi(60000, 30000, headerArgs, settings);
  });
  afterAll(async () => { await term?.close(); });

  it("shows the kept header lines and drops the resource blocks", async () => {
    try {
      const frame = term.viewport.getText();
      // Kept lines (proves the header was rebuilt under quietStartup).
      expect(frame).toContain("pi v"); // logo
      expect(frame).toContain("Press ctrl+o to show full startup help and loaded resources.");
      expect(frame).toContain("Pi can explain its own features");
      // The three loaded-resources blocks are gone.
      for (const block of ["[Context]", "[Skills]", "[Extensions]"]) {
        expect(frame).not.toContain(block);
      }
    } finally {
      await term.close();
    }
  });
});
