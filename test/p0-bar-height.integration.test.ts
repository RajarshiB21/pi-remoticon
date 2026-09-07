// P0 — Integration lane: the drift guard, both directions.
// Boot pi from a scratch COPY of the installed package (never the devDep in
// place), submit a one-line message so the user-message bar renders, and count
// the rows painted with the bar background. The bar is Box(outputPad, paddingY):
//   pristine (paddingY 1) -> pad + text + pad = 3 bar rows;
//   patched  (paddingY 0) -> text only        = 1 bar row.
// The negative copy is separately, freshly made so patched state can't leak in —
// a guard that only ever checks the patched side would pass even if patching
// silently no-op'd. Default pi theme, so this test is independent of S1's theme:
// the bar bg is pi's own userMessageBg #343541 = (52,53,65).
import { describe, it, expect, beforeAll } from "vitest";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, countBarRows } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

const USERBAR = { r: 0x34, g: 0x35, b: 0x41 }; // #343541, pi's default userMessageBg
const MSG = "P0 drift-guard one-line message";

async function barRows(cli: string): Promise<number> {
  const term = await bootPi(60000, 20000, [MSG], {}, undefined, cli);
  try {
    await term.waitFor("drift-guard", 20000); // the submitted message reached the transcript
    return countBarRows(term.getRows().slice(-term.rows), USERBAR);
  } finally {
    await term.close();
  }
}

describe("P0: patch drift guard (bar height)", () => {
  // Warm pi's one-time fd/ripgrep download into the shared test HOME so the
  // measured boots from scratch copies are fast.
  beforeAll(async () => {
    const warm = await bootPi(60000, 30000);
    await warm.close();
  }, 120000);

  it("PATCHED copy renders the bar thin (1 row)", async () => {
    const copy = makePiCopy();
    try {
      applyCorePatch(copy.pkgDir);
      expect(await barRows(copy.cli)).toBe(1);
    } finally {
      copy.cleanup();
    }
  }, 120000);

  it("PRISTINE copy renders the bar tall (3 rows) — the guard can tell them apart", async () => {
    const copy = makePiCopy(); // distinct, never-patched copy
    try {
      expect(await barRows(copy.cli)).toBe(3);
    } finally {
      copy.cleanup();
    }
  }, 120000);
});
