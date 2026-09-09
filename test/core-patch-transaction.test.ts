import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transact, runCorePatch } from "../scripts/apply-core-patch.js";
import { STATE_DIR, sha256, type Edit } from "../scripts/core-patch-plan.js";
import { makePiCopy } from "./helpers/patch-harness.js";

/** Exercise multi-file replacement on tiny owned files, then remove the fixture. */
function fixture(run: (target: string, edits: Edit[]) => void): void {
  const target = mkdtempSync(join(tmpdir(), "remoticon-transaction-"));
  const edits = ["a.js", "b.js", "c.js"].map((path, index) => ({ path, original: `const value = ${index};\n`, patched: `const value = ${index + 1};\n` }));
  for (const edit of edits) writeFileSync(join(target, edit.path), edit.original);
  try { run(target, edits); } finally { rmSync(target, { recursive: true, force: true }); }
}

describe("S0 filesystem transaction", () => {
  it("detects an interrupted manifest, refuses apply and recovers a disposable audited installation", () => {
    const copy = makePiCopy();
    try {
      expect(runCorePatch("check", copy.pkgDir).state).toBe("pristine");
      expect(existsSync(join(copy.pkgDir, STATE_DIR))).toBe(false);
      expect(runCorePatch("apply", copy.pkgDir).state).toBe("current managed");
      const path = join(copy.pkgDir, STATE_DIR, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.phase = "applying";
      writeFileSync(path, JSON.stringify(manifest));
      expect(runCorePatch("status", copy.pkgDir).state).toBe("interrupted managed");
      expect(() => runCorePatch("apply", copy.pkgDir)).toThrow(/restore/);
      expect(runCorePatch("restore", copy.pkgDir).state).toBe("pristine");
      expect(runCorePatch("apply", copy.pkgDir).state).toBe("current managed");
    } finally { copy.cleanup(); }
  }, 20000);

  it("stages, saves durable originals, applies and restores exact bytes without touching neighboring files", () => fixture((target, edits) => {
    writeFileSync(join(target, "auth.json"), "untouched");
    transact(target, edits, "apply", sha256("source"));
    for (const edit of edits) {
      expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.patched);
      expect(readFileSync(join(target, STATE_DIR, "backups", `${edit.path}.original`), "utf8")).toBe(edit.original);
    }
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("applied");
    transact(target, edits, "restore", sha256("source"));
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("untouched");
  }));

  it("rolls back every replaced file when a later replacement fails", () => fixture((target, edits) => {
    let calls = 0;
    expect(() => transact(target, edits, "apply", sha256("source"), (from, to) => {
      if (++calls === 3) throw new Error("injected third replacement failure");
      renameSync(from, to);
    })).toThrow(/rollback verified/);
    expect(calls).toBe(5);
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("restored");
  }));

  it("reports a failed rollback individually, attempts the others, and leaves a detectable recovery phase", () => fixture((target, edits) => {
    let calls = 0;
    expect(() => transact(target, edits, "apply", sha256("source"), (from, to) => {
      calls++;
      if (calls === 3 || calls === 4) throw new Error("injected failure");
      renameSync(from, to);
    })).toThrow(/rollback failures: a.js/);
    expect(calls).toBe(5);
    expect(readFileSync(join(target, "a.js"), "utf8")).toBe(edits[0].patched);
    expect(readFileSync(join(target, "b.js"), "utf8")).toBe(edits[1].original);
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("rollback-failed");
    transact(target, edits, "restore", sha256("source"));
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
  }));

  it("rejects unknown current/backup bytes and duplicate plans before writes; syntax failure leaves installed files intact", () => fixture((target, edits) => {
    expect(() => transact(target, [edits[0], edits[0]], "apply", sha256("source"))).toThrow(/duplicate/);
    writeFileSync(join(target, "c.js"), "unknown bytes");
    expect(() => transact(target, edits, "restore", sha256("source"))).toThrow(/Unknown edits/);
    expect(existsSync(join(target, STATE_DIR))).toBe(false);
    writeFileSync(join(target, "c.js"), edits[2].original);
    expect(() => transact(target, [{ ...edits[0], patched: "const = ;" }], "apply", sha256("source"))).toThrow(/no installed files replaced/);
    expect(readFileSync(join(target, "a.js"), "utf8")).toBe(edits[0].original);
    const backup = join(target, STATE_DIR, "backups");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "a.js.original"), "unknown backup");
    expect(() => transact(target, edits, "apply", sha256("source"))).toThrow(/Changed backup/);
  }));
});
