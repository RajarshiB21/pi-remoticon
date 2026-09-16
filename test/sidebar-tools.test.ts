import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TaskStore } from "../lib/sidebar/tasks/store.js";
import { registerTaskTools, TASK_TOOL_NAMES } from "../lib/sidebar/tasks/tools.js";

function fakePi() {
  const tools = new Map<string, ToolDefinition>();
  return {
    tools,
    registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
  } as unknown as ExtensionAPI & { tools: Map<string, ToolDefinition> };
}
const run = async (pi: ReturnType<typeof fakePi>, name: string, args: Record<string, unknown>) =>
  (pi.tools.get(name) as ToolDefinition).execute("id", args as never, undefined, undefined, {} as ExtensionContext);

describe("sidebar tools", () => {
  it("registers exactly the four tools", () => {
    const pi = fakePi();
    registerTaskTools(pi, () => new TaskStore(), () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    expect([...pi.tools.keys()].sort()).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
    expect([...TASK_TOOL_NAMES].sort()).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
  });
  it("creates with a whitespace-cleaned subject and notifies on change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidebar-tools-"));
    try {
      const store = new TaskStore(join(dir, "t.json"));
      let changes = 0; const hookCalls: string[] = [];
      const pi = fakePi();
      registerTaskTools(pi, () => store, () => { changes += 1; },
        { beforeCreate: () => hookCalls.push("create"), afterUpdate: id => hookCalls.push(`update:${id}`) });
      const result = await run(pi, "TaskCreate", { subject: "  Write   tests ", description: "done means green" });
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Created #1: Write tests (pending)") });
      expect(store.list()[0].subject).toBe("Write tests");
      expect(changes).toBe(1);
      expect(hookCalls).toEqual(["create"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("updates status and reports the transition", async () => {
    const store = new TaskStore(); const hookCalls: string[] = [];
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {},
      { beforeCreate: () => {}, afterUpdate: (id, changed) => hookCalls.push(`${id}:${changed.status}`) });
    await run(pi, "TaskCreate", { subject: "a", description: "" });
    const result = await run(pi, "TaskUpdate", { task_id: "1", status: "in_progress" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Updated #1") });
    expect(store.get("1")?.status).toBe("in_progress");
    expect(hookCalls).toEqual(["1:in_progress"]);
  });
  it("lists and gets, and errors name the missing task", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    await run(pi, "TaskCreate", { subject: "a", description: "d" });
    expect((await run(pi, "TaskList", {})).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[pending] #1 a") });
    expect((await run(pi, "TaskGet", { task_id: "1" })).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("#1 a") });
    expect((await run(pi, "TaskGet", { task_id: "9" })).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("#9 not found") });
  });
  it("filters the list by the documented status parameter", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    await run(pi, "TaskCreate", { subject: "a", description: "" });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    expect(textOf(await run(pi, "TaskList", { status: "pending" }))).toContain("#1 a");
    expect(textOf(await run(pi, "TaskList", { status: "completed" }))).toBe("No tasks");
  });
  it("prints dependency edges, so blocked work is visible before it is started", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "first", description: "" });
    await run(pi, "TaskCreate", { subject: "second", description: "" });
    await run(pi, "TaskUpdate", { task_id: "2", addBlockedBy: ["1"] });
    expect(textOf(await run(pi, "TaskList", {}))).toContain("#2 second [blocked by #1]");
    expect(textOf(await run(pi, "TaskGet", { task_id: "2" }))).toContain("[blocked by #1]");
    expect(textOf(await run(pi, "TaskGet", { task_id: "1" }))).toContain("Blocks: #2");
    await run(pi, "TaskUpdate", { task_id: "1", status: "completed" });
    expect(textOf(await run(pi, "TaskList", {}))).not.toContain("blocked by");   // a finished blocker stops blocking
  });
  it("refuses to start a task whose blockers are unfinished, and names them", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "first", description: "" });
    await run(pi, "TaskCreate", { subject: "second", description: "" });
    await run(pi, "TaskUpdate", { task_id: "2", addBlockedBy: ["1"] });
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" }))).toContain("#2 is blocked by #1");
    expect(store.get("2")?.status).toBe("pending");                     // refused, nothing changed
    await run(pi, "TaskUpdate", { task_id: "1", status: "completed" }); // finish the blocker
    // The transition also proves the status is snapshotted before the update: a memory-only
    // store mutates the live object, so reading it afterwards always saw "no change".
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" }))).toContain("Updated #2 (pending → in_progress)");
    expect(store.get("2")?.status).toBe("in_progress");
  });
  it("refuses in_progress when the same update is what adds an unfinished blocker", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "blocker", description: "" });
    await run(pi, "TaskCreate", { subject: "dependent", description: "" });
    // One call that would both start #2 and hang an unfinished blocker on it.
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress", addBlockedBy: ["1"] }))).toContain("#2 is blocked by #1");
    expect(store.get("2")?.status).toBe("pending");           // the update was refused whole
    expect(store.get("2")?.blockedBy).toEqual([]);            // so neither the status nor the edge landed
    expect(store.get("1")?.blocks).toEqual([]);               // nor the reverse edge
  });
  it("refuses adding an unfinished blocker to a task already in progress", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "done first", description: "" });      // #1
    await run(pi, "TaskCreate", { subject: "dependent", description: "" });        // #2
    await run(pi, "TaskCreate", { subject: "later blocker", description: "" });    // #3
    await run(pi, "TaskUpdate", { task_id: "1", status: "completed" });
    await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" });   // legitimately started
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", addBlockedBy: ["3"] }))).toContain("#2 is blocked by #3");
    expect(store.get("2")?.blockedBy).toEqual([]);                          // refused
    // An edit that touches neither the status nor the edges is still allowed.
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", subject: "renamed" }))).toContain("Updated #2");
    expect(store.get("2")?.subject).toBe("renamed");
  });
  it("refuses out-of-order work with no declared edges at all", async () => {
    // The owner's dishonesty complaint: a model leaving #1 unfinished while starting or
    // completing a task after it. Declared edges were trivially bypassed by not declaring
    // them, so task number order is now the declared order and the tool enforces it.
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "first", description: "" });
    await run(pi, "TaskCreate", { subject: "second", description: "" });
    await run(pi, "TaskCreate", { subject: "third", description: "" });
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" })))
      .toContain("#2 cannot be started while #1 is unfinished");
    expect(store.get("2")?.status).toBe("pending");                     // refused, nothing changed
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "3", status: "completed" })))
      .toContain("#3 cannot be completed while #1 is unfinished");       // the exact dishonest pattern
    expect(store.get("3")?.status).toBe("pending");
    await run(pi, "TaskUpdate", { task_id: "1", status: "in_progress" });   // in order: allowed
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" })))
      .toContain("#2 cannot be started while #1 is unfinished");        // ID order names the earlier task
    expect(store.get("2")?.status).toBe("pending");
    await run(pi, "TaskUpdate", { task_id: "1", status: "completed" });
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" }))).toContain("Updated #2");
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "2", status: "deleted" }))).toBe("Deleted #2");   // the exit
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "3", status: "in_progress" }))).toContain("Updated #3");
  });
  it("refuses a second in_progress task, including after a revert", async () => {
    // One spinner marks what is happening now. A revert can leave a later task active, so
    // this gate has its own message even though ID order usually fires first.
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "first", description: "" });
    await run(pi, "TaskCreate", { subject: "second", description: "" });
    await run(pi, "TaskUpdate", { task_id: "1", status: "completed" });
    await run(pi, "TaskUpdate", { task_id: "2", status: "in_progress" });
    await run(pi, "TaskUpdate", { task_id: "1", status: "pending" });     // reopened, allowed
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "1", status: "in_progress" })))
      .toContain("#2 is already in_progress — complete it or set it to deleted before starting #1");
    expect(store.get("1")?.status).toBe("pending");                     // refused, nothing changed
  });
  it("accepts metadata on update, including a null value that deletes the key", async () => {
    const store = new TaskStore();
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    await run(pi, "TaskCreate", { subject: "a", description: "" });
    await run(pi, "TaskUpdate", { task_id: "1", metadata: { file: "a.ts", drop: null } });
    expect(store.get("1")?.metadata).toEqual({ file: "a.ts" });
    await run(pi, "TaskUpdate", { task_id: "1", metadata: { file: null } });
    expect(store.get("1")?.metadata).toEqual({});
  });
  it("removes a task when asked, instead of reporting it missing", async () => {
    const store = new TaskStore();
    let changes = 0;
    const pi = fakePi();
    registerTaskTools(pi, () => store, () => { changes += 1; },
      { beforeCreate: () => {}, afterUpdate: () => {} });
    const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content[0] as { text: string }).text;
    await run(pi, "TaskCreate", { subject: "abandoned row", description: "" });
    const beforeDelete = changes;
    // The store has always supported this; the tool never exposed it, so a row the agent no
    // longer wanted had no way off the user's list and the description's "no longer needed"
    // path was unreachable.
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "1", status: "deleted" }))).toBe("Deleted #1");
    expect(store.get("1")).toBeUndefined();
    expect(changes).toBe(beforeDelete + 1);          // without the repaint the row stays on screen
    expect(textOf(await run(pi, "TaskUpdate", { task_id: "1", status: "deleted" }))).toContain("#1 not found");
  });
  it("offers `deleted` on TaskUpdate only, never as a TaskList filter", () => {
    const pi = fakePi();
    registerTaskTools(pi, () => new TaskStore(), () => {}, { beforeCreate: () => {}, afterUpdate: () => {} });
    const enumOf = (name: string) => {
      const def = pi.tools.get(name) as unknown as { parameters: { properties: { status: { enum: string[] } } } };
      return def.parameters.properties.status.enum;
    };
    expect(enumOf("TaskList")).toEqual(["pending", "in_progress", "completed"]);
    expect(enumOf("TaskUpdate")).toEqual(["pending", "in_progress", "completed", "deleted"]);
  });
});
