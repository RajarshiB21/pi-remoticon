import { describe, it, expect, beforeAll } from "vitest";
import { realpathSync } from "node:fs";
import { readBundle } from "../scripts/apply-core-patch.js";
import {
  inspectPlan, planEdits, sha256, PATCHES, PI_NAME, PI_VERSION, CLI_PATH,
  ORIGINAL_HASH, THIN_BAR_HASH, affectedProcesses, type Manifest, type ProcessRecord,
} from "../scripts/core-patch-plan.js";
import { PRISTINE_SOURCE } from "./helpers/patch-harness.js";

const target = realpathSync(PRISTINE_SOURCE);
const digest = sha256("test source");
let pristine: Map<string, string>;
let patched: Map<string, string>;
let backups: Map<string, string>;
let manifest: Manifest;
beforeAll(() => {
  // Parse the real audited dependency graph once; pure cases reuse the bytes.
  pristine = readBundle(target);
  const edits = planEdits(pristine);
  patched = new Map(pristine);
  for (const edit of edits) patched.set(edit.path, edit.patched);
  backups = new Map(edits.map(edit => [edit.path, edit.original]));
  manifest = { format: 1, target, version: PI_VERSION, sourceDigest: digest, phase: "applied",
    files: edits.map(edit => ({ path: edit.path, originalHash: ORIGINAL_HASH, patchedHash: THIN_BAR_HASH })) };
});

describe("S0 pure patch plan", () => {
  it("classifies pristine, current, older-source, legacy, interrupted and restored bytes", () => {
    const inspect = (files: Map<string, string>, value?: unknown, interrupted = false) =>
      inspectPlan(target, PI_NAME, PI_VERSION, files, digest, value, backups, interrupted);
    expect(inspect(pristine).state).toBe("pristine");
    expect(inspect(patched).state).toBe("legacy thin-bar-only");
    expect(inspect(patched, manifest).state).toBe("current managed");
    expect(inspect(patched, { ...manifest, sourceDigest: sha256("earlier source, same audited thin-bar transform") }).state).toBe("older managed");
    for (const phase of ["prepared", "applying", "restoring", "rollback-failed"]) {
      expect(inspect(patched, { ...manifest, phase }).state).toBe("interrupted managed");
    }
    expect(inspect(patched, manifest, true).state).toBe("interrupted managed");
    expect(inspect(pristine, undefined, true).state).toBe("interrupted managed");
    expect(inspect(pristine, { ...manifest, phase: "restored" }).state).toBe("pristine");
    expect(inspect(patched, manifest).edits).toEqual(inspect(pristine).edits);
  });

  it("rejects identity, version, missing CLI and whole-file drift even with intact anchors", () => {
    for (const [name, version] of [["another-package", PI_VERSION], [PI_NAME, "0.85.2"]]) {
      expect(() => inspectPlan(target, name, version, pristine, digest)).toThrow(/audited/);
    }
    expect(() => inspectPlan("", PI_NAME, PI_VERSION, pristine, digest)).toThrow(/explicit target/);
    const absent = new Map(pristine); absent.delete(CLI_PATH);
    expect(() => inspectPlan(target, PI_NAME, PI_VERSION, absent, digest)).toThrow(/CLI is absent/);
    const drifted = new Map(pristine);
    drifted.set(CLI_PATH, `${drifted.get(CLI_PATH)}\n// unknown change`);
    expect(() => inspectPlan(target, PI_NAME, PI_VERSION, drifted, digest)).toThrow(/whole-file hash/);
    const path = manifest.files[0].path;
    drifted.set(CLI_PATH, pristine.get(CLI_PATH)!);
    drifted.set(path, `${pristine.get(path)}\n// anchor still matches`);
    expect(() => inspectPlan(target, PI_NAME, PI_VERSION, drifted, digest)).toThrow(/whole-file hash/);
  });

  it("rejects changed backups, unknown fingerprints and manifest paths or duplicate records", () => {
    const invalid = [null, {}, { ...manifest, target: `${target}-other` }, { ...manifest, version: "0.86.0" },
      { ...manifest, files: [...manifest.files, ...manifest.files] },
      { ...manifest, files: [{ ...manifest.files[0], path: "../outside.js" }] },
      { ...manifest, files: [{ ...manifest.files[0], patchedHash: sha256("not a supported revision") }] }];
    for (const value of invalid) expect(() => inspectPlan(target, PI_NAME, PI_VERSION, patched, digest, value, backups)).toThrow(/manifest/i);
    expect(() => inspectPlan(target, PI_NAME, PI_VERSION, patched, digest, manifest, new Map())).toThrow(/backup/);
  });

  it("enforces anchor multiplicity and composes same-file edits without duplicate plans", () => {
    const entry = { name: "example", find: "old()", replace: "newer()" };
    const cases: [string, RegExp][] = [["missing()", /not found/], ["old();old()", /ambiguous/], ["old();newer()", /Inconsistent/]];
    for (const [bytes, error] of cases) expect(() => planEdits(new Map([["a.js", bytes]]), [entry])).toThrow(error);
    expect(() => planEdits(new Map([["a.js", "old()"], ["b.js", "old()"]]), [entry])).toThrow(/ambiguous/);
    expect(planEdits(new Map([["a.js", "old();second()"]]), [entry, { name: "second", find: "second()", replace: "changed()" }]))
      .toEqual([{ path: "a.js", original: "old();second()", patched: "newer();changed()" }]);
    expect(PATCHES).toHaveLength(1);
    expect(PATCHES[0].find.replace(",1,", ",0,")).toBe(PATCHES[0].replace);
  });

  it("matches normalized CLI/launcher tokens and relatives without matching another installation", () => {
    const row = (pid: number, parentPid: number, commandLine: string): ProcessRecord => ({ pid, parentPid, commandLine, executable: "C:\\node.exe", name: "node.exe" });
    const rows = [row(1, 0, "terminal"), row(2, 1, 'node "C:\\PI\\dist\\bundle\\cli.js" --prompt secret'),
      row(3, 2, "helper"), row(4, 1, 'node "C:\\PI-other\\dist\\bundle\\cli.js"'), row(5, 1, "unrelated")];
    expect(affectedProcesses(rows, ["c:/pi/dist/bundle/cli.js"], true)).toEqual([1, 2, 3]);
    expect(affectedProcesses([row(6, 0, 'cmd /c "C:\\npm\\pi.cmd"')], ["c:/npm/pi.cmd"], true)).toEqual([6]);
    expect(() => affectedProcesses(rows, ["c:/pi/dist/bundle/cli.js"], false)).toThrow(/Cannot disambiguate/);
    expect(affectedProcesses([row(9, 0, 'node /opt/pi/dist/other/../bundle/cli.js')], ["/opt/pi/dist/bundle/cli.js"], false)).toEqual([9]);
    expect(affectedProcesses([row(7, 0, 'node "C:\\PI\\dist\\other\\..\\bundle\\cli.js"')], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([7]);
    for (const command of ['node dist/bundle/cli.js', 'node .\\cli.js', 'node C:dist\\bundle\\cli.js', 'cmd /c .\\pi.cmd']) {
      expect(() => affectedProcesses([row(8, 0, command)], ["c:/pi/dist/bundle/cli.js"], true)).toThrow(/Cannot disambiguate.*PID 8/);
    }
  });
});
