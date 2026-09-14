// Integration lane — the real package boot with the core patch applied. The
// fake provider emits one `fetch` call with an ftp:// target when the prompt
// carries FETCHBAD. The scheme is rejected in TypeScript before any Python
// spawn, so this proves, offline: the extension loads from the package, the
// tool is registered and active, validation runs, and the default view names
// the failure — the error line and the group line, with no keypress at all.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { bootPi } from "./helpers/boot-pi.js";
import { makePiCopy, type PiCopy } from "./helpers/patch-harness.js";
import { applyCorePatch } from "../scripts/apply-core-patch.js";

let home: string;
let copy: PiCopy;
let term: Awaited<ReturnType<typeof bootPi>>;

describe("fetch registration: an invalid target fails offline", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pi-fetch-home-"));
    copy = makePiCopy();
    applyCorePatch(copy.pkgDir);
    term = await bootPi(90000, 30000, ["FETCHBAD"], { quietStartup: true, package: true }, home, copy.cli);
  });
  afterAll(async () => {
    await term?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    copy?.cleanup();
  });

  it("shows the validation error and the group line in the default view", async () => {
    try {
      await term.waitFor("! fetch:", 30000);
      expect(term.viewport.getText()).toContain("not public http(s)");
      expect(term.viewport.getText()).toContain("1 fetch call failed");
      expect(term.viewport.getText()).toContain("fetch");
    } finally {
      await term.close();
    }
  }, 120000);
});
