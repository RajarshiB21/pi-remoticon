// Unit lane for the boot-pi harness helper. ackChangelog must survive a
// malformed settings.json (null / array / primitive) — otherwise it throws or
// silently drops the ack, reintroducing the changelog-screen boot hang it exists
// to prevent (CodeRabbit PR #5). No pi boot here; pure filesystem behavior.
import { describe, it, expect, afterEach } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ackChangelog, validateTestArgs, repoRoot } from "./helpers/boot-pi.js";
import { testEnvironment } from "./helpers/test-environment.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function homeWithSettings(raw: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "pi-ack-"));
  homes.push(home);
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
    const home = homeWithSettings(null);
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

describe("offline helper boundary", () => {
  it("clears inherited credentials/options in a real child and preserves only allowed OS values", () => {
    const home = homeWithSettings(null);
    const inherited = { ...process.env, S0_DUMMY_CREDENTIAL: "must-not-reach-child", NODE_OPTIONS: "--trace-warnings", LC_SECRET: "hidden" };
    const env = testEnvironment(home, inherited);
    const child = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      assert.equal(process.env.S0_DUMMY_CREDENTIAL, '');
      assert.equal(process.env.NODE_OPTIONS, '');
      assert.equal(process.env.LC_SECRET, '');
      assert.equal(process.env.HOME, process.env.USERPROFILE);
      assert.ok(process.env.PI_CODING_AGENT_SESSION_DIR.startsWith(process.env.HOME));
    `], { env: { ...inherited, ...env }, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(inherited.S0_DUMMY_CREDENTIAL).toBe("must-not-reach-child");
    const windows = testEnvironment(home, { Path: "tools", SystemRoot: "system", Lang: "C", node_options: "bad", appdata: "personal" }, true);
    expect(windows).toMatchObject({ Path: "tools", SystemRoot: "system", Lang: "C", node_options: "", appdata: join(home, "appdata") });
    expect(windows).not.toHaveProperty("PATH");
    expect(windows).not.toHaveProperty("APPDATA");
    expect(() => testEnvironment(home, { Path: "one", PATH: "two" }, true)).toThrow(/aliases/);
  });

  it("rejects provider/config/auth overrides and accepts only fixture UI inputs", () => {
    for (const args of [["--provider", "real"], ["--model=x"], ["--api-key", "dummy"], ["--session", "personal"], ["--", "--provider", "real"], ["@auth.json"], ["update"], ["-e", "unknown.ts"], ["--theme"], ["--use-theme", "other"]]) {
      expect(() => validateTestArgs(args), args[0]).toThrow();
    }
    expect(() => validateTestArgs(["-e", join(repoRoot, "extensions", "footer.ts"), "--theme", join(repoRoot, "themes", "remoticon.json"), "--use-theme", "remoticon", "RUNTOOL"])).not.toThrow();
  });
});
