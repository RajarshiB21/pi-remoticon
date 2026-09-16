import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sessionTaskFile } from "../lib/sidebar/tasks/paths.js";
import { TaskStore } from "../lib/sidebar/tasks/store.js";
import type { Task } from "../lib/sidebar/tasks/types.js";

// The factory is imported for side effects; the command and the startup rules are
// exercised through a fake pi.
import factory from "../extensions/sidebar.js";

type FakeCommand = { handler: (args: string, ctx: Partial<ExtensionContext>) => Promise<void> };
type FakeHandler = (event: unknown, ctx: unknown) => unknown;
function fakePi() {
  const commands = new Map<string, FakeCommand>();
  const handlers = new Map<string, FakeHandler>();
  const tools = new Map<string, ToolDefinition>();
  return {
    commands,
    handlers,
    tools,
    on: (name: string, fn: FakeHandler) => { handlers.set(name, fn); },
    registerCommand: (name: string, def: FakeCommand) => { commands.set(name, def); },
    registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
  } as unknown as ExtensionAPI & {
    commands: Map<string, FakeCommand>; handlers: Map<string, FakeHandler>; tools: Map<string, ToolDefinition>;
  };
}
const runTool = async (pi: ReturnType<typeof fakePi>, name: string, args: Record<string, unknown>) =>
  (pi.tools.get(name) as ToolDefinition).execute("id", args as never, undefined, undefined, {} as ExtensionContext);
const ctx = (notifies: string[]) => ({
  mode: "print",
  cwd: process.cwd(),
  ui: { notify: (m: string) => notifies.push(m) },
} as unknown as Partial<ExtensionContext>);

const mkTask = (id: string, status: Task["status"]): Task =>
  ({ id, subject: `task ${id}`, description: "", status, metadata: {}, blocks: [], blockedBy: [], createdAt: 0, updatedAt: 0 });

let agentDir: string; let cwd: string; let sessionId: string; let file: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "entry-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "entry-cwd-"));
  sessionId = "sess-1";
  file = sessionTaskFile(agentDir, cwd, sessionId);
  process.env.PI_CODING_AGENT_DIR = agentDir;               // getAgentDir() honours this
});
afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
const seed = (tasks: Task[]) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ nextId: tasks.length + 1, tasks }, null, 2));
};
const sessionCtx = (notifies: string[]) => ({
  mode: "tui",
  cwd,
  isProjectTrusted: () => true,
  sessionManager: { getSessionFile: () => join(cwd, "session.jsonl"), getSessionId: () => sessionId },
  ui: { notify: (m: string) => notifies.push(m), custom: () => new Promise(() => {}) },
} as unknown as ExtensionContext);

type Overlay = { render(width: number): string[]; invalidate(): void };
/** A session whose overlay factory actually runs, so the component can be rendered by hand. */
const sessionCtxWithOverlay = (notifies: string[], theme: unknown, capture: (c: Overlay) => void) => ({
  mode: "tui",
  cwd,
  isProjectTrusted: () => true,
  sessionManager: { getSessionFile: () => join(cwd, "session.jsonl"), getSessionId: () => sessionId },
  ui: {
    notify: (m: string) => notifies.push(m),
    theme,
    custom: (factory: (tui: unknown) => Overlay) => {
      capture(factory({ requestRender: () => {}, terminal: { rows: 30 } }));
      return new Promise(() => {});
    },
  },
} as unknown as ExtensionContext);

describe("/sidebar command", () => {
  it("toggles, persists the flag globally and clamps the width", async () => {
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    const sidebar = pi.commands.get("sidebar")!;
    await sidebar.handler("off", ctx(notifies));
    expect(notifies.join()).toContain("off");
    await sidebar.handler("width 99", ctx(notifies));        // out of range -> usage warning
    expect(notifies.join()).toContain("28..60");
    await sidebar.handler("width 36", ctx(notifies));
    expect(notifies.join()).toContain("36");
    await sidebar.handler("bogus", ctx(notifies));           // unknown argument warns
    expect(notifies.join()).toContain("Usage");
  });
  it("clears the task list on request, and reports what it removed", async () => {
    seed([mkTask("1", "pending"), mkTask("2", "completed")]);
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtx(notifies));
    expect(new TaskStore(file).list()).toHaveLength(2);      // seeded and restored first
    await pi.commands.get("sidebar")!.handler("clear", ctx(notifies));
    expect(notifies.join()).toContain("Cleared 2");
    expect(new TaskStore(file).list()).toEqual([]);          // the user's only way to drop a stray row
    expect(existsSync(file)).toBe(false);                    // and the emptied file is reclaimed
  });
  it("says a project override is active on the on/off and width toasts too", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "remoticon-sidebar.json"), JSON.stringify({ sidebar: { on: false } }));
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtx(notifies));
    notifies.length = 0;
    const sidebar = pi.commands.get("sidebar")!;
    await sidebar.handler("width 36", ctx(notifies));
    await sidebar.handler("on", ctx(notifies));
    await sidebar.handler("", ctx(notifies));
    expect(notifies).toHaveLength(3);
    for (const note of notifies) expect(note).toContain("project override active");
  });
});

describe("session_start restore and startup clear", () => {
  it("retires an all-completed list without claiming it was restored", async () => {
    seed([mkTask("1", "completed"), mkTask("2", "completed")]);
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtx(notifies));
    expect(notifies.join()).not.toContain("Restored");       // nothing survived to restore
    expect(existsSync(file)).toBe(false);                    // cleared, and its empty file reclaimed
  });
  it("restores and reports a list that still has work in it", async () => {
    seed([mkTask("1", "completed"), mkTask("2", "pending")]);
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtx(notifies));
    expect(notifies.join()).toContain("Restored 2 persisted tasks");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).tasks).toHaveLength(2);
  });
  it("keeps an all-completed list on resume, and reports it", async () => {
    seed([mkTask("1", "completed")]);
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "resume" }, sessionCtx(notifies));
    expect(notifies.join()).toContain("Restored 1 persisted task");
    expect(existsSync(file)).toBe(true);
  });
  it("warns once when the config file is not JSON", async () => {
    writeFileSync(join(agentDir, "remoticon-sidebar.json"), "{not json");
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtx(notifies));
    expect(notifies.filter(n => n.includes("invalid sidebar config"))).toHaveLength(1);
  });
});

describe("theme role fallback", () => {
  it("reports an unknown role once, not on every repaint", async () => {
    // Regression: the painter was rebuilt inside render(), so each frame started with an empty
    // "already warned" set and the toast repeated on every repaint — about 6.7 times a second
    // while the spinner runs.
    const pi = fakePi();
    factory(pi);
    const notifies: string[] = [];
    const theme = {
      fg: (role: string, t: string) => { if (role === "customMessageLabel") throw new Error("unknown role"); return t; },
      bold: (t: string) => t,
    };
    let overlay: Overlay | undefined;
    await pi.handlers.get("session_start")!({ reason: "startup" }, sessionCtxWithOverlay(notifies, theme, c => { overlay = c; }));
    await runTool(pi, "TaskCreate", { subject: "a", description: "" });
    await runTool(pi, "TaskUpdate", { task_id: "1", status: "in_progress" });   // a row that uses the missing role
    overlay!.render(44);
    overlay!.render(44);
    overlay!.render(44);
    expect(notifies.filter(n => n.includes("Theme has no"))).toHaveLength(1);
    pi.handlers.get("session_shutdown")!({}, {});                                // stop the spinner clock
  });
});
