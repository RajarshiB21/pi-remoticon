// Integration lane — the REAL load path. Earlier S1/S2 integration tests loaded
// the extension by explicit file (`-e extensions/header.ts`), which bypasses how
// pi actually loads the product: it enables the pi-remoticon PACKAGE (in
// settings) and discovers every file in the extensions/ directory. pi throws if
// any .ts there is not a valid factory — so a pure helper left in extensions/
// breaks `pi` at boot while the file-path tests stay green. This test boots pi
// the real way (package discovery + a neutral cwd, as a user runs it) so that
// class of failure fails the gate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { bootPi, repoRoot } from "./helpers/boot-pi.js";

let home: string;
let env: Record<string, string>;

describe("package load: pi boots with the pi-remoticon package enabled", () => {
  beforeAll(async () => {
    // A home that enables the package the way the user's settings do, and selects
    // the theme + quietStartup so the full product (theme + header) is exercised.
    home = mkdtempSync(join(tmpdir(), "pi-pkg-home-"));
    cpSync(join(repoRoot, ".pi-test-home"), home, { recursive: true });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    // lastChangelogVersion is stamped by bootPi (live pi VERSION) so an update
    // never hangs the boot behind pi's changelog screen.
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ quietStartup: true, theme: "remoticon", packages: [repoRoot] }, null, 2)
    );
    env = { HOME: home, USERPROFILE: home };
    // cwd = the home (a neutral dir that is NOT the package), matching the real
    // scenario. Generous warm budget for any first-boot package reconciliation.
    const warm = await bootPi(90000, 30000, [], env, home);
    await warm.close();
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("boots with no extension-load error and rebuilds the header", async () => {
    const term = await bootPi(30000, 15000, [], env, home);
    try {
      const frame = term.viewport.getText();
      // The exact failure this guards: a non-factory file in extensions/ aborts load.
      expect(frame).not.toMatch(/Failed to load extension|valid factory/i);
      // pi actually painted (boot succeeded) and the header extension ran.
      expect(frame).toContain("pi v");
      expect(frame).toContain("Pi can explain its own features");
      // The package's quietStartup took effect (blocks gone).
      expect(frame).not.toContain("[Extensions]");
    } finally {
      await term.close();
    }
  });
});
