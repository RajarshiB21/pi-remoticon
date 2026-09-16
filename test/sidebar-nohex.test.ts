import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : (full.endsWith(".ts") ? [full] : []);
  });
}

describe("sidebar: no hardcoded colors", () => {
  it("has no hex color literal under lib/sidebar", () => {
    const offenders = tsFiles(join(import.meta.dirname, "..", "lib", "sidebar"))
      .filter(f => /#[0-9a-fA-F]{6}\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
