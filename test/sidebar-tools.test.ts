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
});
