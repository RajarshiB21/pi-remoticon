import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { repairPtyPackage, ORIGINAL_CLEANUP, REPAIRED_CLEANUP, ORIGINAL_PTY_HASH, REPAIRED_PTY_HASH } from "../scripts/repair-test-pty.js";

it("repairs a disposable node-pty once, refuses drift/version/links, and preserves unrelated files", () => {
  const root = mkdtempSync(join(tmpdir(), "remoticon-pty-repair-"));
  const pkg = join(root, "node-pty");
  const file = join(pkg, "lib", "windowsPtyAgent.js");
  const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    mkdirSync(join(pkg, "lib"), { recursive: true });
    const installed = readFileSync(fileURLToPath(new URL("../node_modules/node-pty/lib/windowsPtyAgent.js", import.meta.url)), "utf8");
    // test:setup may already have repaired the fixture source. Recover only the
    // literal original bytes, then verify them before testing the repair.
    const original = Buffer.from(installed.replace(REPAIRED_CLEANUP, ORIGINAL_CLEANUP));
    expect(fingerprint(original)).toBe(ORIGINAL_PTY_HASH);
    writeFileSync(file, original);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
    writeFileSync(join(pkg, "unrelated"), "preserve");
    const stage = `${file}.remoticon-next.js`;
    const candidate = original.toString("utf8").replace(ORIGINAL_CLEANUP, REPAIRED_CLEANUP);
    writeFileSync(stage, candidate); // interrupted after staging, before replacement
    expect(repairPtyPackage(pkg)).toBe("applied");
    expect(existsSync(stage)).toBe(false);
    expect(fingerprint(readFileSync(file))).toBe(REPAIRED_PTY_HASH);
    writeFileSync(stage, candidate);
    expect(repairPtyPackage(pkg)).toBe("already applied");
    expect(existsSync(stage)).toBe(false);
    for (const bytes of [original, Buffer.from(candidate)]) {
      writeFileSync(file, bytes);
      writeFileSync(stage, "unknown staged bytes");
      expect(() => repairPtyPackage(pkg)).toThrow(/Unknown.*stage.*npm ci/);
      expect(readFileSync(stage, "utf8")).toBe("unknown staged bytes");
      expect(readFileSync(file)).toEqual(bytes);
      unlinkSync(stage);
    }
    expect(readFileSync(join(pkg, "unrelated"), "utf8")).toBe("preserve");
    writeFileSync(file, "unknown bytes");
    expect(() => repairPtyPackage(pkg)).toThrow(/Unknown node-pty bytes/);
    expect(readFileSync(file, "utf8")).toBe("unknown bytes");
    writeFileSync(file, original);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.1" }));
    expect(() => repairPtyPackage(pkg)).toThrow(/Only audited/);
    const linked = join(root, "linked");
    symlinkSync(pkg, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => repairPtyPackage(linked)).toThrow(/linked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
