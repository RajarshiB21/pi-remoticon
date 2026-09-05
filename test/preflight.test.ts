// Static lane — the one guard the behavioral tests can't cover: no
// machine-absolute path in the harness. Absolute paths (C:\Users\..., /home,
// /Users) are what kill a suite on a clean CI machine; everything must resolve
// at runtime (import.meta.url). Rule 1 ("no real model in the gate") is enforced
// behaviorally by the spike test (asserts fake-model selected, no openrouter)
// and by CI running with no credentials — not re-checked here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("static: no machine-absolute paths in the harness", () => {
  it("neither the boot helper nor the fixture hardcodes an absolute path", () => {
    const abs = /(?:[A-Za-z]:\\Users|\/home\/|\/Users\/)/;
    for (const f of [join(testDir, "helpers", "boot-pi.ts"), join(testDir, "fixtures", "fake-provider.ts")]) {
      expect(abs.test(readFileSync(f, "utf8")), `${f} contains an absolute path`).toBe(false);
    }
  });
});
