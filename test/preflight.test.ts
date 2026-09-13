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
const repoRoot = dirname(testDir);

describe("static: no machine-absolute paths in the harness", () => {
  it("no path-building harness or script file hardcodes an absolute path", () => {
    // Only the files that BUILD filesystem paths at runtime are scanned — test
    // fixtures may legitimately carry absolute paths (footer-format.test.ts's
    // cwd sample), so a blanket scan of test/ would false-positive. Extend this
    // list when a new file constructs paths: boot helper, fake provider, the
    // patch script, and P0's copy harness (adds patch-harness.ts).
    // Any Windows drive path (C:\, D:\work, ...) or a POSIX absolute path rooted
    // at a machine-specific directory (/home, /Users, /tmp, /root, /var, /opt,
    // /mnt, /media, /private). Broad enough to catch /tmp/pi and C:\work\pi, not
    // just the ~/ forms.
    const abs = /[A-Za-z]:\\|\/(?:home|Users|tmp|root|var|opt|mnt|media|private)\//;
    for (const f of [
      join(testDir, "helpers", "boot-pi.ts"),
      join(testDir, "helpers", "patch-harness.ts"),
      join(testDir, "fixtures", "fake-provider.ts"),
      join(repoRoot, "scripts", "apply-core-patch.ts"),
      join(repoRoot, "lib", "research", "process.ts"),
    ]) {
      expect(abs.test(readFileSync(f, "utf8")), `${f} contains an absolute path`).toBe(false);
    }
  });
});
