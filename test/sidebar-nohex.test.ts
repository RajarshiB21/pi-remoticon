// Guard: nothing under lib/sidebar may pin a colour. Every element paints through a theme
// role, read at render time, so a theme change repaints the panel with no code change.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Every CSS hex form: #fff, #ffff, #ffffff, #ffffffff. The trailing \b is what makes the
// long forms matter — after six digits a seventh hex digit is still a word character, so a
// six-digit-only pattern silently ignores #ffffffff.
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : (full.endsWith(".ts") ? [full] : []);
  });
}
const offendersIn = (dir: string): string[] =>
  tsFiles(dir).filter(f => HEX_COLOR.test(readFileSync(f, "utf8")));

describe("sidebar: no hardcoded colors", () => {
  it("has no hex color literal under lib/sidebar", () => {
    expect(offendersIn(join(import.meta.dirname, "..", "lib", "sidebar"))).toEqual([]);
  });
  it("catches all four hex forms, and leaves clean files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "nohex-"));
    try {
      const samples: [string, string][] = [
        ["short3.ts", 'const c = "#fff";'],
        ["short4.ts", 'const c = "#ffff";'],
        ["long6.ts", 'const c = "#a1b2c3";'],
        ["long8.ts", 'const c = "#a1b2c3d4";'],
        ["clean.ts", 'const label = "#12 not a color";\nconst id = `#${n} task`;'],
      ];
      for (const [name, text] of samples) writeFileSync(join(dir, name), text);
      expect(offendersIn(dir).map(p => basename(p)).sort()).toEqual(["long6.ts", "long8.ts", "short3.ts", "short4.ts"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
