import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../lib/sidebar/tasks/store.js";
import { sessionTaskFile, projectKey } from "../lib/sidebar/tasks/paths.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sidebar-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sidebar store", () => {
  it("creates, updates, lists and deletes", () => {
    const store = new TaskStore();                       // memory-only
    const t = store.create("Write tests", "all of them");
    expect(t.status).toBe("pending");
    expect(store.update(t.id, { status: "in_progress" }).task?.status).toBe("in_progress");
    expect(store.list()).toHaveLength(1);
    expect(store.delete(t.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
  it("warns on self, dangling and cyclic dependencies", () => {
    const store = new TaskStore();
    const a = store.create("a", ""); const b = store.create("b", "");
    expect(store.update(a.id, { addBlocks: [a.id] }).warnings).toContain("#1 blocks itself");
    expect(store.update(a.id, { addBlocks: ["9"] }).warnings).toContain("#9 does not exist");
    store.update(a.id, { addBlocks: [b.id] });
    expect(store.update(b.id, { addBlocks: [a.id] }).warnings).toContain(`cycle: #2 and #1 block each other`);
  });
  it("saves atomically and restores", () => {
    const file = join(dir, "tasks-1.json");
    const store = new TaskStore(file);
    store.create("persisted", "");
    const reloaded = new TaskStore(file);
    expect(reloaded.list()[0].subject).toBe("persisted");
    expect(existsSync(file + ".tmp")).toBe(false);
  });
  it("seed copies a fork snapshot and no-ops on a non-empty store", () => {
    const parent = new TaskStore(); parent.create("parent task", "");
    const child = new TaskStore(); child.create("child task", "");
    child.seed(parent.snapshot());
    expect(child.list().map(t => t.subject)).toEqual(["child task"]);   // seed no-ops
    const empty = new TaskStore(); empty.seed(parent.snapshot());
    expect(empty.list()[0].subject).toBe("parent task");
  });
  it("deletes its file only when empty", () => {
    const file = join(dir, "tasks-2.json");
    const store = new TaskStore(file);
    const t = store.create("gone", "");
    expect(store.deleteFileIfEmpty()).toBe(false);
    store.delete(t.id);
    expect(store.deleteFileIfEmpty()).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
  it("uses the agent directory only; a workspace .pi/tasks file is not adopted", () => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "tasks", "tasks-abc.json"), JSON.stringify({ nextId: 5, tasks: [] }));
    const file = sessionTaskFile(agentDir, cwd, "abc");
    expect(file).toBe(join(agentDir, "tasks", "sessions", projectKey(cwd), "tasks-abc.json"));
    const store = new TaskStore(file);
    expect(store.list()).toHaveLength(0);               // the workspace file was never read
  });
});
