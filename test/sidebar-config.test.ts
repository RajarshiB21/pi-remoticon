import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveGlobalSideFlag, saveGlobalWidth, DEFAULT_CONFIG, projectOverrideActive } from "../lib/sidebar/config.js";

let agent: string; let cwd: string;
beforeEach(() => { agent = mkdtempSync(join(tmpdir(), "cfg-agent-")); cwd = mkdtempSync(join(tmpdir(), "cfg-cwd-")); });
afterEach(() => { rmSync(agent, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });

describe("sidebar config", () => {
  it("returns defaults when nothing exists", () => {
    expect(loadConfig(agent)).toEqual(DEFAULT_CONFIG);
  });
  it("merges global and project shallowly, glyphs one level deeper, slots wholesale", () => {
    writeFileSync(join(agent, "remoticon-sidebar.json"), JSON.stringify({ sidebar: { width: 50 }, tasks: { glyphs: { pending: "x" } } }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "remoticon-sidebar.json"), JSON.stringify({ tasks: { autoClear: "never", glyphs: { completed: "y" } }, slots: [{ id: "other" }] }));
    const cfg = loadConfig(agent, cwd, true);
    expect(cfg.sidebar.width).toBe(50);
    expect(cfg.sidebar.on).toBe(true);
    expect(cfg.tasks.autoClear).toBe("never");
    expect(cfg.tasks.glyphs).toEqual({ pending: "x", completed: "y" });
    expect(cfg.slots).toEqual([{ id: "other" }]);
    expect(projectOverrideActive(cfg, agent)).toBe(true);
  });
  it("ignores the project file for untrusted projects and broken JSON", () => {
    writeFileSync(join(agent, "remoticon-sidebar.json"), "{not json");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "remoticon-sidebar.json"), JSON.stringify({ sidebar: { width: 33 } }));
    expect(loadConfig(agent, cwd, false).sidebar.width).toBe(44);   // untrusted: project ignored, broken global falls back
    writeFileSync(join(agent, "remoticon-sidebar.json"), JSON.stringify({ sidebar: { width: 50 } }));
    expect(loadConfig(agent, cwd, true).sidebar.width).toBe(33);
  });
  it("writes the on flag and width to the global file only", () => {
    saveGlobalSideFlag(agent, false);
    expect(JSON.parse(readFileSync(join(agent, "remoticon-sidebar.json"), "utf8")).sidebar.on).toBe(false);
    saveGlobalWidth(agent, 36);
    expect(JSON.parse(readFileSync(join(agent, "remoticon-sidebar.json"), "utf8")).sidebar.width).toBe(36);
  });

  const writeProject = (body: unknown) => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "remoticon-sidebar.json"), typeof body === "string" ? body : JSON.stringify(body));
  };

  it("reports an override for any key the project changes, not just width and slots", () => {
    writeProject({ sidebar: { on: false } });                       // the key group the old helper missed
    expect(projectOverrideActive(loadConfig(agent, cwd, true), agent)).toBe(true);
    writeProject({ tasks: { autoClear: "never" } });
    expect(projectOverrideActive(loadConfig(agent, cwd, true), agent)).toBe(true);
    rmSync(join(cwd, ".pi", "remoticon-sidebar.json"));
    expect(projectOverrideActive(loadConfig(agent, cwd, true), agent)).toBe(false);
  });
  it("does not invent an override out of an invalid global width", () => {
    writeFileSync(join(agent, "remoticon-sidebar.json"), JSON.stringify({ sidebar: { width: 99 } }));
    expect(projectOverrideActive(loadConfig(agent, cwd, true), agent)).toBe(false);
  });
  it("reports a config file that exists but holds no JSON object", () => {
    const reported: string[] = [];
    const report = (p: string) => { reported.push(p); };
    const globalFile = join(agent, "remoticon-sidebar.json");
    loadConfig(agent, cwd, true, report);
    expect(reported).toEqual([]);                                  // absent is not an error
    writeFileSync(globalFile, "{not json");
    loadConfig(agent, cwd, true, report);
    expect(reported).toEqual([globalFile]);
    reported.length = 0;
    loadConfig(agent, cwd, false, report);
    expect(reported).toEqual([globalFile]);                        // untrusted project file is never read
    writeProject("[1,2]");
    reported.length = 0;
    loadConfig(agent, cwd, true, report);
    expect(reported).toHaveLength(2);                              // unparseable and wrong-shaped both count
  });
});
