// S3 — Integration lane. Boot pi at fullscreen with the footer extension loaded
// under the fake model, and prove our custom footer replaced pi's default:
// the leftmost state dot (●) is present and `cwd (branch)` is pinned right.
// Shape/smoke only — the exact idle/working strings are unit-tested
// (test/footer-format.test.ts), not asserted against model text here.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

const FOOTER = join(repoRoot, "extensions", "footer.ts");
const footerArgs = ["-e", FOOTER];

describe("S3: custom footer (idle layout)", () => {
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000, footerArgs);
    await warm.close();
  });

  it("renders our footer: the state dot and the right-pinned cwd", async () => {
    const term = await bootPi(15000, 15000, footerArgs);
    try {
      const frame = term.viewport.getText();
      // The ● dot is unique to our footer (pi's default footer has none) — its
      // presence proves setFooter replaced the built-in footer.
      expect(frame).toContain("●");
      // The footer row must END with the live `cwd (branch)` — proving the value
      // wired through extensions/footer.ts is pinned hard right (not just present
      // somewhere). Branch name is not hardcoded: repoRoot is a git repo so a
      // parenthesized branch always follows the cwd, but the exact name varies
      // (CI checks out a detached HEAD → "detached"), so we assert the shape.
      const footerRow = frame.split("\n").reverse().find((r) => r.includes(repoRoot)) ?? "";
      expect(footerRow, "no footer row contained the cwd").toContain(`${repoRoot} (`);
      expect(footerRow.trimEnd().endsWith(")"), "cwd (branch) is not pinned to the right edge").toBe(true);
    } finally {
      await term.close();
    }
  });
});
