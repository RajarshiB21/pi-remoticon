// S3 — Integration lane. Boot pi at fullscreen with the footer extension loaded
// under the fake model, and prove our custom footer replaced pi's default:
// the leftmost state dot (●) is present and `cwd (branch)` is pinned right.
// Shape/smoke only — the exact idle/working strings are unit-tested
// (test/footer-format.test.ts), not asserted against model text here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let fixtureCwd: string;

const FOOTER = join(repoRoot, "extensions", "footer.ts");
const footerArgs = ["-e", FOOTER];

describe("S3: custom footer (idle layout)", () => {
  beforeAll(async () => {
    fixtureCwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
    execFileSync("git", ["init", "-b", "fixture", fixtureCwd], { stdio: "pipe" });
    const warm = await bootPi(60000, 30000, footerArgs, {}, fixtureCwd);
    await warm.close();
  });
  afterAll(() => { if (fixtureCwd) rmSync(fixtureCwd, { recursive: true, force: true }); });

  it("renders our footer: the state dot and the right-pinned cwd", async () => {
    const term = await bootPi(15000, 15000, footerArgs, {}, fixtureCwd);
    try {
      const frame = term.viewport.getText();
      // The ● dot is unique to our footer (pi's default footer has none) — its
      // presence proves setFooter replaced the built-in footer.
      expect(frame).toContain("●");
      // The footer row must END with the live `cwd (branch)` — proving the value
      // wired through extensions/footer.ts is pinned hard right (not just present
      // somewhere). The isolated fixture supplies the same branch locally and in CI.
      const footerRow = frame.split("\n").reverse().find((r) => r.includes(fixtureCwd)) ?? "";
      expect(footerRow, "no footer row contained the fixture cwd").toContain(`${fixtureCwd} (fixture)`);
      expect(footerRow.trimEnd().endsWith(")"), "cwd (branch) is not pinned to the right edge").toBe(true);
    } finally {
      await term.close();
    }
  });
});
