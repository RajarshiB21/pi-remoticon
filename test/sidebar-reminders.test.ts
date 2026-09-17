import { describe, it, expect } from "vitest";
import type { Task } from "../lib/sidebar/tasks/types.js";
import {
  createCadenceState, onTurnStart, evaluateToolResult, drainReminderForContext,
  buildSystemReminder, AutoClearManager, REMINDER_INTERVAL, ACTIVE_REMINDER_INTERVAL, REMINDER_MAX_TASKS, EMPTY_LIST_NUDGE_TURNS,
} from "../lib/sidebar/tasks/reminders.js";
import { TaskStore } from "../lib/sidebar/tasks/store.js";

const cfg = (interval: number, names: ReadonlySet<string>) => ({ reminderInterval: interval, taskToolNames: names, emptyListNudgeTurns: EMPTY_LIST_NUDGE_TURNS });
const task = (id: string, status: Task["status"]): Task =>
  ({ id, subject: `s${id}`, description: "", status, metadata: {}, blocks: [], blockedBy: [], createdAt: 0, updatedAt: 0 });

describe("cadence", () => {
  it("uses 4 turns, 2 while a task is in progress, cap 10", () => {
    expect(REMINDER_INTERVAL).toBe(4);
    expect(ACTIVE_REMINDER_INTERVAL).toBe(2);
    expect(REMINDER_MAX_TASKS).toBe(10);
  });
  it("resets on any task tool and queues after the interval", () => {
    const s = createCadenceState();
    const names = new Set(["TaskCreate"]);
    for (let i = 0; i < 3; i++) onTurnStart(s);
    expect(evaluateToolResult(s, "read", true, cfg(4, names)).markDue).toBe(false);
    onTurnStart(s);                                   // 4 turns since last use
    expect(evaluateToolResult(s, "read", true, cfg(4, names)).markDue).toBe(true);
    expect(evaluateToolResult(s, "TaskCreate", true, cfg(4, names)).markDue).toBe(false);   // task tool resets
  });
  it("drains once per cycle; the empty-list nudge owns the no-list case", () => {
    const s = createCadenceState();
    s.reminderDue = true;
    expect(drainReminderForContext(s)).toBe(true);
    expect(drainReminderForContext(s)).toBe(false);
    const quiet = createCadenceState();
    for (let i = 0; i < 9; i++) onTurnStart(quiet);
    // v4: the revived empty-list nudge fires for a no-list long task (it used
    // to stay silent forever behind the dead gate).
    expect(evaluateToolResult(quiet, "read", false, cfg(4, new Set())).markDue).toBe(true);
    expect(evaluateToolResult(quiet, "read", false, cfg(4, new Set())).markDue).toBe(false);   // once only
  });
  it("nudges at the two-turn threshold and re-arms when a list exists", () => {
    const s = createCadenceState();
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", false, cfg(4, new Set())).markDue).toBe(false);   // one work turn: below threshold
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", false, cfg(4, new Set())).markDue).toBe(true);    // two work turns: fires
    expect(evaluateToolResult(s, "read", false, cfg(4, new Set())).markDue).toBe(false);   // once only
    expect(evaluateToolResult(s, "TaskCreate", true, cfg(4, new Set())).markDue).toBe(false);  // a list exists: normal cadence owns it
    expect(evaluateToolResult(s, "read", true, cfg(4, new Set())).markDue).toBe(false);
  });
  it("an empty TaskList result does not re-arm the nudge", () => {
    const s = createCadenceState();
    const taskNames = new Set(["TaskCreate", "TaskList"]);
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", false, cfg(4, taskNames)).markDue).toBe(false);
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", false, cfg(4, taskNames)).markDue).toBe(true);    // fires at the threshold
    expect(evaluateToolResult(s, "TaskList", false, cfg(4, taskNames)).markDue).toBe(false);   // empty list: latch held
    onTurnStart(s);
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", false, cfg(4, taskNames)).markDue).toBe(false);   // still held, no re-nudge
    expect(evaluateToolResult(s, "TaskCreate", true, cfg(4, taskNames)).markDue).toBe(false);  // a list exists: re-arms
    onTurnStart(s);
    onTurnStart(s);
    expect(evaluateToolResult(s, "read", true, cfg(4, taskNames)).markDue).toBe(false);    // normal cadence owns it now
  });
});

describe("reminder text", () => {
  it("nudges on an empty list", () => {
    expect(buildSystemReminder([])).toContain("task list is currently empty");
  });
  it("echoes at most 10 tasks, dropping completed first", () => {
    const tasks: Task[] = [];
    for (let i = 1; i <= 12; i++) tasks.push(task(String(i), i <= 2 ? "completed" : "pending"));
    const text = buildSystemReminder(tasks);
    expect(text).toContain("2 more tasks not shown");
    expect(text).toContain('"status":"pending"');
  });
});

describe("auto-clear", () => {
  it("retires an all-completed list 4 turns later", () => {
    const store = new TaskStore();
    const t = store.create("a", "");
    store.update(t.id, { status: "completed" });
    const ac = new AutoClearManager(() => store, () => "on_list_complete", 4);
    ac.trackCompletion(t.id, 1);
    for (let turn = 2; turn <= 4; turn++) expect(ac.onTurnStart(turn)).toBe(false);
    expect(ac.onTurnStart(5)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
  it("arms the run boundary and starts a new batch clean", () => {
    const store = new TaskStore();
    const t = store.create("a", "");
    store.update(t.id, { status: "completed" });
    const ac = new AutoClearManager(() => store, () => "on_list_complete", 4);
    ac.trackCompletion(t.id, 1);
    ac.onRunEnded();
    ac.startNewBatch();                                // next batch's first create retires the list
    expect(store.list()).toHaveLength(0);
  });
  it("never mode clears nothing", () => {
    const store = new TaskStore();
    const t = store.create("a", "");
    store.update(t.id, { status: "completed" });
    const ac = new AutoClearManager(() => store, () => "never", 4);
    ac.trackCompletion(t.id, 1);
    expect(ac.onTurnStart(99)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });
  it("still retires the finished rows when a row was abandoned on the previous run", () => {
    const store = new TaskStore();
    const done = store.create("finished", "");
    store.update(done.id, { status: "completed" });
    store.create("abandoned", "");                        // left pending across the run boundary
    const ac = new AutoClearManager(() => store, () => "on_list_complete", 4);
    ac.trackCompletion(done.id, 1);
    ac.onRunEnded();
    ac.startNewBatch();                                    // the next batch's first create
    // The finished row goes. The unfinished one is not auto-clear's to delete: one abandoned
    // row used to hold the gate shut forever, so the next batch was appended to rows the user
    // had already watched finish and nothing ever retired them.
    expect(store.list().map(t => t.subject)).toEqual(["abandoned"]);
  });
});
