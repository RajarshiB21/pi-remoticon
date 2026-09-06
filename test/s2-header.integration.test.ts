// S2 — Integration lane. Boot pi at fullscreen with quietStartup:true and the
// header extension loaded, and prove the end state: the kept header lines are
// present and the [Context]/[Skills]/[Extensions] listing is gone. Shape/smoke
// only (our deterministic renderer, no model text).
//
// quietStartup lives in settings.json (no CLI flag), and S0's shared test home
// must keep the full built-in header, so this slice needs its own home. We copy
// the warm test home (for the cached fd/ripgrep bins) into a temp dir and add
// quietStartup:true — os.tmpdir() is resolved at runtime, no absolute path baked in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const HEADER = join(repoRoot, "extensions", "header.ts");
const headerArgs = ["-e", HEADER];

let quietHome: string;
let quietEnv: Record<string, string>;

describe("S2: custom header (quietStartup + rebuild)", () => {
  beforeAll(async () => {
    quietHome = mkdtempSync(join(tmpdir(), "pi-quiet-home-"));
    cpSync(join(repoRoot, ".pi-test-home"), quietHome, { recursive: true });
    mkdirSync(join(quietHome, ".pi", "agent"), { recursive: true });
    // lastChangelogVersion is stamped by bootPi (live pi VERSION) so an update
    // never hangs the boot behind pi's changelog screen.
    writeFileSync(
      join(quietHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ quietStartup: true }, null, 2)
    );
    quietEnv = { HOME: quietHome, USERPROFILE: quietHome };
    const warm = await bootPi(60000, 30000, headerArgs, quietEnv); // warm paint budget
    await warm.close();
  });

  afterAll(() => {
    if (quietHome) rmSync(quietHome, { recursive: true, force: true });
  });

  it("shows the kept header lines and drops the resource blocks", async () => {
    const term = await bootPi(15000, 15000, headerArgs, quietEnv);
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
