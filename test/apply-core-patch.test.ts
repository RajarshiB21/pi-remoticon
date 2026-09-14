import { describe, it, expect, beforeAll } from "vitest";
import { realpathSync } from "node:fs";
import { readBundle } from "../scripts/apply-core-patch.js";
import {
  inspectPlan as inspectPlanPure, planEdits, sha256, PATCHES, PI_NAME, PI_VERSION, CLI_PATH,
  ORIGINAL_HASH, THIN_BAR_HASH, UI_HASH, affectedProcesses, runningProcesses, type Manifest, type ProcessRecord,
} from "../scripts/core-patch-plan.js";
import { PRISTINE_SOURCE } from "./helpers/patch-harness.js";
import { runtimePatches } from "../scripts/runtime-patches.js";

const target = realpathSync(PRISTINE_SOURCE);
const digest = sha256("test source");
let pristine: Map<string, string>;
let patched: Map<string, string>;
let backups: Map<string, string>;
let manifest: Manifest;
let definitions: typeof PATCHES;
const inspectPlan: typeof inspectPlanPure = (target, name, version, files, digest, manifest, backups, interrupted) =>
  inspectPlanPure(target, name, version, files, digest, manifest, backups, interrupted, definitions);
beforeAll(() => {
  // Parse the real audited dependency graph once; pure cases reuse the bytes.
  pristine = readBundle(target);
  definitions = [...PATCHES, ...runtimePatches(pristine)];
  const edits = planEdits(pristine, definitions);
  patched = new Map(pristine);
  for (const edit of edits) patched.set(edit.path, edit.patched);
  backups = new Map(edits.map(edit => [edit.path, edit.original]));
  manifest = { format: 1, target, version: PI_VERSION, sourceDigest: digest, phase: "applied",
    files: edits.map(edit => ({ path: edit.path, originalHash: ORIGINAL_HASH, patchedHash: UI_HASH })) };
});

describe("S0 pure patch plan", () => {
  it("inserts replacement source literally", () => {
    const replacement = "$& $$ $` $' $1";
    expect(planEdits(new Map([["a.js", "before old() after"]]), [{ name: "literal", find: "old()", replace: replacement }])[0].patched)
      .toBe(`before ${replacement} after`);
  });

  it("classifies pristine, current, older-source, legacy, interrupted and restored bytes", () => {
    const inspect = (files: Map<string, string>, value?: unknown, interrupted = false) =>
      inspectPlan(target, PI_NAME, PI_VERSION, files, digest, value, backups, interrupted);
    expect(inspect(pristine).state).toBe("pristine");
    const legacy = new Map(pristine);
    const legacyEdit = planEdits(pristine, [PATCHES[0]])[0];
    legacy.set(legacyEdit.path, legacyEdit.patched);
    expect(sha256(legacyEdit.patched)).toBe(THIN_BAR_HASH);
    expect(inspect(legacy).state).toBe("legacy thin-bar-only");
    const legacyManifest = { ...manifest, files: [{ ...manifest.files[0], patchedHash: THIN_BAR_HASH }] };
    expect(inspect(legacy, legacyManifest).state).toBe("older managed");
    expect(inspect(legacy, legacyManifest).edits[0].previous).toBe(legacyEdit.patched);
    expect(inspect(legacy, { ...manifest, files: [{ ...manifest.files[0], previousHash: THIN_BAR_HASH }] }).state).toBe("interrupted managed");
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
    expect(PATCHES).toHaveLength(5);
    expect(PATCHES[0].find.replace(",1,", ",0,")).toBe(PATCHES[0].replace);
    const nativeProvider = { value: "main", getGitBranch() { return this.value; }, getExtensionStatuses() { return this.value; },
      getAvailableProviderCount() { return this.value; }, onBranchChange(callback: () => void) { callback(); return this.value; } };
    const owner = { footerDataProvider: nativeProvider, session: { autoCompactionEnabled: false } };
    const bridge = new Function("factory", "theme", `${PATCHES[1].replace};return this.customFooter;`)
      .call(owner, (_ui: unknown, _theme: unknown, data: unknown) => data, {});
    expect(bridge.getGitBranch()).toBe("main");
    expect(bridge.getExtensionStatuses()).toBe("main");
    expect(bridge.getAvailableProviderCount()).toBe("main");
    let notified = false;
    expect(bridge.onBranchChange(() => { notified = true; })).toBe("main");
    expect(notified).toBe(true);
    expect(bridge.remoticon.getState()).toEqual({ autoCompactionEnabled: false });
    owner.session.autoCompactionEnabled = true;
    expect(bridge.remoticon.getState()).toEqual({ autoCompactionEnabled: true });
  });

  it("matches normalized CLI/launcher tokens and relatives without matching another installation", () => {
    const row = (pid: number, parentPid: number, commandLine: string): ProcessRecord => {
      const name = commandLine.split(" ")[0];
      return { pid, parentPid, commandLine, executable: `C:\\${name}.exe`, name: `${name}.exe` };
    };
    const rows = [row(1, 0, "terminal"), row(2, 1, 'node "C:\\PI\\dist\\bundle\\cli.js" --prompt secret'),
      row(3, 2, "helper"), row(4, 1, 'node "C:\\PI-other\\dist\\bundle\\cli.js"'), row(5, 1, "unrelated")];
    expect(affectedProcesses(rows, ["c:/pi/dist/bundle/cli.js"], true)).toEqual([1, 2, 3]);
    // Only the pi process itself (and its children) may block a patch: the
    // terminal, the editor and Explorer merely launched it.
    expect(runningProcesses(rows, ["c:/pi/dist/bundle/cli.js"], true)).toEqual([2, 3]);
    expect(affectedProcesses([row(6, 0, 'cmd /c "C:\\npm\\pi.cmd"')], ["c:/npm/pi.cmd"], true)).toEqual([6]);
    expect(() => affectedProcesses(rows, ["c:/pi/dist/bundle/cli.js"], false)).toThrow(/Cannot disambiguate/);
    expect(affectedProcesses([row(9, 0, 'node /opt/pi/dist/other/../bundle/cli.js')], ["/opt/pi/dist/bundle/cli.js"], false)).toEqual([9]);
    expect(affectedProcesses([row(7, 0, 'node "C:\\PI\\dist\\other\\..\\bundle\\cli.js"')], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([7]);
    for (const command of ['node dist/bundle/cli.js', 'node .\\cli.js', 'node C:dist\\bundle\\cli.js', 'cmd /c .\\pi.cmd']) {
      expect(() => affectedProcesses([row(8, 0, command)], ["c:/pi/dist/bundle/cli.js"], true)).toThrow(/Cannot disambiguate.*PID 8/);
    }
    for (const prompt of ["pi", "fix/pi", "C:/PI/dist/bundle/cli.js"]) {
      expect(affectedProcesses([row(10, 0, `node other.js --prompt "${prompt}"`)], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([]);
    }
    const launchers = [
      ['node --require preflight.cjs --import loader.mjs --conditions development --no-warnings C:/PI/dist/bundle/cli.js --prompt pi', "c:/pi/dist/bundle/cli.js"],
      ['node -- C:/PI/dist/bundle/cli.js --prompt pi', "c:/pi/dist/bundle/cli.js"],
      ['cmd /d /s /c ""C:\\Program Files\\npm\\pi.cmd" --prompt pi"', "c:/program files/npm/pi.cmd"],
      ['cmd /c "C:\\Program Files\\npm\\pi.cmd"', "c:/program files/npm/pi.cmd"],
      ['powershell -NoProfile -File "C:\\Program Files\\npm\\pi.ps1" --prompt pi', "c:/program files/npm/pi.ps1"],
      ['pwsh -NoProfile -Command "& \'C:\\Program Files\\npm\\pi.ps1\' --prompt pi"', "c:/program files/npm/pi.ps1"],
    ];
    for (const [command, launcher] of launchers) expect(affectedProcesses([row(11, 0, command)], [launcher], true)).toEqual([11]);
    for (const preload of ["--import", "--require", "-r", "--loader", "--experimental-loader"]) {
      const options = [`${preload} C:/PI/dist/bundle/cli.js`, preload === "-r" ? "-rC:/PI/dist/bundle/cli.js" : `${preload}=C:/PI/dist/bundle/cli.js`];
      for (const option of options) {
        for (const script of ["", " other.js"]) expect(affectedProcesses([row(14, 0, `node ${option}${script}`)], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([14]);
      }
      expect(() => affectedProcesses([row(15, 0, `node ${preload} ./dist/bundle/cli.js`)], ["c:/pi/dist/bundle/cli.js"], true)).toThrow(/Cannot disambiguate.*PID 15/);
    }
    expect(affectedProcesses([row(16, 0, 'node --import="file:///C:/PI/dist/bundle/cli.js" other.js')], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([16]);
    expect(affectedProcesses([row(17, 0, 'node other.js --import C:/PI/dist/bundle/cli.js')], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([]);
    for (const command of ['node -e "console.log(1)" pi', 'node --require setup.cjs other.js --prompt pi',
      'cmd /c other.cmd --prompt C:/PI/dist/bundle/cli.js', 'powershell -File other.ps1 --prompt pi',
      'pwsh -Command & other.ps1 --prompt -File C:/PI/dist/bundle/cli.js',
      'pwsh -Command "& other.ps1 --prompt pi"']) {
      expect(affectedProcesses([row(12, 0, command)], ["c:/pi/dist/bundle/cli.js"], true)).toEqual([]);
    }
    for (const command of ['node --require setup.cjs dist/bundle/cli.js', 'pwsh -Command "& .\\pi.ps1 --prompt words"',
      'node --unknown-option value dist/bundle/cli.js']) {
      expect(() => affectedProcesses([row(13, 0, command)], ["c:/pi/dist/bundle/cli.js"], true)).toThrow(/Cannot disambiguate.*PID 13/);
    }
  });
});
