// Adapted from https://github.com/tintinweb/pi-tasks (MIT, (c) 2026 tintinweb)
// src/reminder-cadence.ts (the cadence machine below) and the constants and
// `buildSystemReminder` of its src/index.ts (appended at the end of this file).
import type { Task } from "./types.js";

/**
 * Pure cadence logic for the system-reminder injection.
 *
 * Decisions are made here as plain functions so they're easy to unit-test
 * without spinning up the whole extension. The default export of the
 * extension wires these into the `tool_result` and `context` hooks.
 */

/** Internal cadence state. Plain object so it round-trips through tests. */
export interface CadenceState {
  currentTurn: number;
  lastTaskToolUseTurn: number;
  reminderInjectedThisCycle: boolean;
  reminderDue: boolean;
}

export interface CadenceConfig {
  /** Turns without a task-tool call before a reminder is considered due. */
  reminderInterval: number;
  /** Set of tool names that count as "task tool usage" and reset cadence. */
  taskToolNames: ReadonlySet<string>;
}

export function createCadenceState(): CadenceState {
  return {
    currentTurn: 0,
    lastTaskToolUseTurn: 0,
    reminderInjectedThisCycle: false,
    reminderDue: false,
  };
}

export function resetCadenceState(state: CadenceState): void {
  state.currentTurn = 0;
  state.lastTaskToolUseTurn = 0;
  state.reminderInjectedThisCycle = false;
  state.reminderDue = false;
}

/** Increment the turn counter at `turn_start`. */
export function onTurnStart(state: CadenceState): void {
  state.currentTurn++;
}

export interface ToolResultDecision {
  /** True when caller should mark `reminderDue` for the next `context` event. */
  markDue: boolean;
}

/**
 * Decide what cadence change a tool_result implies. Mutates `state` in place
 * (resets the timer when a task tool was used) and returns whether the
 * reminder should be queued for the next LLM call.
 */
export function evaluateToolResult(
  state: CadenceState,
  toolName: string,
  hasTasks: boolean,
  config: CadenceConfig,
): ToolResultDecision {
  // Task tool usage resets cadence and clears any pending reminder.
  if (config.taskToolNames.has(toolName)) {
    state.lastTaskToolUseTurn = state.currentTurn;
    state.reminderInjectedThisCycle = false;
    state.reminderDue = false;
    return { markDue: false };
  }
  // Cheap guards first.
  if (state.currentTurn - state.lastTaskToolUseTurn < config.reminderInterval) {
    return { markDue: false };
  }
  if (state.reminderInjectedThisCycle) return { markDue: false };
  if (!hasTasks) return { markDue: false };
  state.reminderDue = true;
  return { markDue: true };
}

/**
 * Drain the pending reminder when `context` fires. Returns true if the
 * caller should inject the reminder into the upcoming LLM call's messages.
 */
export function drainReminderForContext(state: CadenceState): boolean {
  if (!state.reminderDue) return false;
  state.reminderDue = false;
  state.reminderInjectedThisCycle = true;
  state.lastTaskToolUseTurn = state.currentTurn;
  return true;
}

export const REMINDER_INTERVAL = 4;
export const ACTIVE_REMINDER_INTERVAL = 2;   // while any task is in_progress
export const REMINDER_MAX_TASKS = 10;

const sanitize = (v: string) => v.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, "").trim();

const rank = (t: Task) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);

/** The reminder text, shaped after Claude Code's todo reminders: the empty-list
 *  nudge, or a JSON echo of the most relevant tasks. Taken from pi-tasks' own
 *  `buildSystemReminder`. */
export function buildSystemReminder(tasks: readonly Task[]): string {
  if (tasks.length === 0) {
    return [
      "",
      "This is a reminder that your task list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a task list please use the TaskCreate tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
      "",
    ].join("\n");
  }
  // Bound the echo on large lists. When over the cap, drop completed tasks
  // first (the reminder exists to surface unfinished work); ties keep task
  // order since Array.sort is stable.
  const shown = tasks.length > REMINDER_MAX_TASKS
    ? [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, REMINDER_MAX_TASKS)
    : [...tasks];
  const hidden = tasks.length - shown.length;
  const overflow = hidden > 0 ? ` (${hidden} more task${hidden === 1 ? "" : "s"} not shown — use TaskList for the full list.)` : "";
  const items = shown.map(t => {
    const item: Record<string, unknown> = { id: t.id, content: sanitize(t.subject), status: t.status };
    if (t.activeForm) item.activeForm = sanitize(t.activeForm);
    return item;
  });
  const prefix = "The task tools haven't been used recently. DO NOT mention this explicitly to the user.";
  const header = hidden > 0 ? `${prefix} Here are your most relevant tasks (list truncated):` : `${prefix} Here are the latest contents of your task list:`;
  return ["", header, "", `${JSON.stringify(items)}.${overflow} Continue on with the tasks at hand if applicable.`, ""].join("\n");
}

export { AutoClearManager } from "./autoclear.js";
export type { AutoClearMode } from "./autoclear.js";
