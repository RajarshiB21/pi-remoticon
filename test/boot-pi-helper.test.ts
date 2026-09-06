// Unit lane for the boot-pi harness helper. ackChangelog must survive a
// malformed settings.json (null / array / primitive) — otherwise it throws or
// silently drops the ack, reintroducing the changelog-screen boot hang it exists
// to prevent (CodeRabbit PR #5). No pi boot here; pure filesystem behavior.
import { describe, it, expect } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { ackChangelog } from "./helpers/boot-pi.js";

function homeWithSettings(raw: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "pi-ack-"));
  if (raw !== null) {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), raw);
  }
  return home;
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
}

describe("ackChangelog", () => {
  it("stamps the live VERSION when no settings file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-ack-"));
    ackChangelog(home);
    expect(readSettings(home).lastChangelogVersion).toBe(VERSION);
  });

  it("merges into an existing object, preserving other keys", () => {
    const home = homeWithSettings(JSON.stringify({ quietStartup: true }));
    ackChangelog(home);
    const s = readSettings(home);
    expect(s.lastChangelogVersion).toBe(VERSION);
    expect(s.quietStartup).toBe(true);
  });

  for (const [label, raw] of [
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
    ["garbage (unparseable)", "{not json"],
  ] as const) {
    it(`recovers from ${label} settings and still acks`, () => {
      const home = homeWithSettings(raw);
      expect(() => ackChangelog(home)).not.toThrow();
      expect(readSettings(home).lastChangelogVersion).toBe(VERSION);
    });
  }
});
