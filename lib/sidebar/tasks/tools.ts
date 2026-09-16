// The four task tools. Descriptions and prompt guidelines are taken from
// https://github.com/tintinweb/pi-tasks (MIT, (c) 2026 tintinweb) src/index.ts.
// Deltas: TaskUpdate drops the `owner` field and the subagent `agentType`; parameters use
// snake_case (`task_id`); the result strings are OURS ("Created #N: subject (pending)",
// "No tasks", "[pending] #N subject", "Error: #N not found", "Updated #N"); output is
// bounded; subjects are whitespace-cleaned. The descriptions also drop the sentences that
// advertised the `owner`/`agentType` fields, the `deleted` status and the TaskExecute tool,
// none of which this product exposes — leaving them would tell the model to use fields and
// a tool that do not exist.
import { Type } from "typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "./store.js";

import type { Task, TaskStatus } from "./types.js";

export const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
/** pi-tasks' own status union shape, without its internal helper. The description is a
 *  parameter, because TaskList and TaskUpdate both take a status and mean different things. */
const statusUnion = (description: string) =>
  Type.Unsafe<"pending" | "in_progress" | "completed">({ type: "string", enum: ["pending", "in_progress", "completed"], description });
/** `TaskUpdate` accepts one value `TaskList` must not: `deleted`, which removes the task. The store
 *  has always taken it (see its `update` signature); keeping it out of the shared union stops
 *  `TaskList({status:"deleted"})` becoming a legal call that can only ever answer "No tasks". */
const updateStatusUnion = (description: string) =>
  Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({ type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description });

const cleanOptional = (v?: string) => v?.trim().replace(/\s+/g, " ") || undefined;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
function bounded(text: string): string {
  const r = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 300, maxLines: DEFAULT_MAX_LINES - 2 });
  return r.truncated && r.content ? `${r.content}\n\n[Output truncated: use TaskList or TaskGet for the rest.]` : text;
}
const formatTask = (t: Task, openBlockers: readonly string[]) =>
  `[${t.status}] #${t.id} ${t.subject}${t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : ""}`
  + (openBlockers.length ? ` [blocked by ${openBlockers.map(id => `#${id}`).join(", ")}]` : "");
/** Spec §8: dependencies are enforced by the tools AND printed in tool output, so the model
 *  can see what is blocked before starting it. Only unfinished blockers are worth showing. */
const openBlockersAmong = (store: TaskStore, ids: readonly string[]): string[] =>
  ids.filter(id => {
    const blocker = store.get(id);
    return blocker !== undefined && blocker.status !== "completed";
  });
const openBlockersOf = (store: TaskStore, task: Task): string[] => openBlockersAmong(store, task.blockedBy);

/** Task ids are the store's sequential numbers. An id that does not parse (a hand-edited
 *  file) counts as EARLIER than everything, not later: an unorderable row must never let
 *  anything jump past it, so the sequence gate fails closed on garbage ids. */
const idOrder = (id: string): number => { const n = Number(id); return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY; };

const CREATE_DESCRIPTION = [
  "Use this tool to create a structured task list for your current coding session. This helps you track progress and organize complex tasks.",
  "It also helps the user understand the progress of the task and overall progress of their requests.",
  "",
  "## What Counts as a Task",
  "",
  "A task is a piece of the user's deliverable: something they would recognize as work on their own project.",
  "Waiting on a person, a bot, a review or a CI run is not a task, and neither is reading a report; those belong in your reply instead. Every unfinished task is visible to the user for as long as it stays unfinished, so a row that is not their deliverable is noise shown as work outstanding.",
  "",
  "## When to Use This Tool",
  "",
  "Use this tool proactively in these scenarios:",
  "",
  "- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions",
  "- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations",
  "- Plan mode - When using plan mode, create a task list to track the work",
  "- User explicitly requests todo list - When the user directly asks you to use the todo list",
  "- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated). Create them all in one response with one TaskCreate call per task",
  "- When you start working on a task - Mark it as in_progress BEFORE beginning work",
  "- After completing a task - Mark it as completed in the same turn, so the list on screen matches reality",
  "- When a task turns out not to be needed - remove it with TaskUpdate `status: \"deleted\"`, rather than leaving it on the list",
  "",
  "## When NOT to Use This Tool",
  "",
  "Skip using this tool when:",
  "",
  "- There is only a single, straightforward task",
  "- The task is trivial and tracking it provides no organizational benefit",
  "- The task can be completed in less than 3 trivial steps",
  "- The task is purely conversational or informational",
  "",
  "NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.",
  "",
  "## Task Fields",
  "",
  '- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")',
  "- **description**: Detailed description of what needs to be done, including context and acceptance criteria",
  '- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.',
  "",
  "All tasks are created with status `pending`.",
  "",
  "## Tips",
  "",
  "- Create tasks with clear, specific subjects that describe the outcome",
  "- Include enough detail in the description for another agent to understand and complete the task",
  "- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed",
  "- Check TaskList first to avoid creating duplicate tasks",
  "- To create several tasks at once, call TaskCreate multiple times in a single response — independent tool calls run in parallel, so the whole batch is created in one turn (one task per call).",
].join("\n");

const LIST_DESCRIPTION = [
  "Use this tool to list all tasks in the task list.",
  "",
  "## When to Use This Tool",
  "",
  "- To see what task to work on next: always the lowest-numbered unfinished task",
  "- To check overall progress on the project",
  "- To see declared dependencies between tasks",
  "- After completing a task, to see what the next task in ID order is",
  "- **Work tasks in ID order** (lowest ID first); the tools refuse out-of-order updates. `blockedBy` edges document dependencies between tasks; ID order governs what can be worked on",
  "",
  "## Output",
  "",
  "Returns a summary of each task:",
  "",
  "- **id**: Task identifier (use with TaskGet, TaskUpdate)",
  "- **subject**: Brief description of the task",
  "- **status**: 'pending', 'in_progress', or 'completed'",
  "- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)",
  "",
  "Use TaskGet with a specific task ID to view full details including description and comments.",
].join("\n");

const GET_DESCRIPTION = [
  "Use this tool to retrieve a task by its ID from the task list.",
  "",
  "## When to Use This Tool",
  "",
  "- When you need the full description and context before starting work on a task",
  "- To understand task dependencies (what it blocks, what blocks it)",
  "- After being assigned a task, to get complete requirements",
  "",
  "## Output",
  "",
  "Returns full task details:",
  "",
  "- **subject**: Task title",
  "- **description**: Detailed requirements and context",
  "- **status**: 'pending', 'in_progress', or 'completed'",
  "- **blocks**: Tasks waiting on this one to complete",
  "- **blockedBy**: Tasks that must complete before this one can start",
  "",
  "## Tips",
  "",
  "- After fetching a task, verify its blockedBy list is empty before beginning work.",
  "- Use TaskList to see all tasks in summary form.",
].join("\n");

const UPDATE_DESCRIPTION = [
  "Use this tool to update a task in the task list.",
  "",
  "## When to Use This Tool",
  "",
  "**Before starting work on a task:**",
  "",
  "- Mark it in_progress BEFORE beginning — do not start work without updating status first",
  "- After resolving, call TaskList to find your next task",
  "",
  "**Mark tasks as resolved:**",
  "",
  "- When you have completed the work described in a task",
  "- When a task is no longer needed or has been superseded",
  "- IMPORTANT: Always mark your assigned tasks as resolved when you finish them",
  "- After resolving, call TaskList to find your next task",
  "- ONLY mark a task as completed when you have FULLY accomplished it",
  "- If you cannot finish a task, leave its status alone and say what stopped it in your reply. Do not mark it completed, and do not leave it in_progress when nobody is working on it",
  "- Never mark a task as completed if:",
  "  - Tests are failing",
  "  - Implementation is partial",
  "  - You encountered unresolved errors",
  "  - You couldn't find necessary files or dependencies",
  "",
  "**Update task details:**",
  "",
  "- When requirements change or become clearer",
  "- When establishing dependencies between tasks",
  "",
  "## Fields You Can Update",
  "",
  "- **status**: The task status (see Status Workflow below)",
  '- **subject**: Change the task title (imperative form, e.g., "Run tests")',
  "- **description**: Change the task description",
  '- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
  "- **metadata**: Merge metadata keys into the task (set a key to null to delete it)",
  "- **addBlocks**: Mark tasks that cannot start until this one completes",
  "- **addBlockedBy**: Mark tasks that must complete before this one can start",
  "",
  "## Status Workflow",
  "",
  "Status progresses: `pending` → `in_progress` → `completed`.",
  "",
  "`deleted` is not a step in that progression: it removes the task. Use it for a task that is no longer needed or has been superseded, so it stops showing on the user's list.",
  "",
  "## Enforced Sequence",
  "",
  "The user reads the task list as the workflow, and the tool enforces that reading:",
  "",
  "- Work tasks in ID order: a task cannot be set `in_progress` or `completed` while an earlier-numbered task is unfinished. If an earlier task will never be done, set it to `deleted` — that is the exit.",
  "- Exactly one task may be `in_progress` at a time: the spinner marks what is happening now. Complete or delete the current task before starting the next.",
  "- A task with an unfinished `blockedBy` entry cannot be started, and an `in_progress` task cannot gain one from either end of a declaration.",
  "- A dependency may only point at an earlier-numbered task: a later task may depend on an earlier one, never the reverse.",
  "",
  "A refused update changes nothing; the error names the task to finish or delete first.",
  "",
  "## Staleness",
  "",
  "Make sure to read a task's latest state using `TaskGet` before updating it.",
  "",
  "## Examples",
  "",
  "Mark task as in progress when starting work:",
  "",
  "```json",
  '{"task_id": "1", "status": "in_progress"}',
  "```",
  "",
  "Mark task as completed after finishing work:",
  "",
  "```json",
  '{"task_id": "1", "status": "completed"}',
  "```",
  "",
  "Set up task dependencies:",
  "",
  "```json",
  '{"task_id": "2", "addBlockedBy": ["1"]}',
  "```",
].join("\n");

const TaskCreateParams = Type.Object({
  subject: Type.String({ description: "Short imperative title" }),
  description: Type.String({ description: "Details and acceptance criteria" }),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in progress" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const TaskUpdateParams = Type.Object({
  task_id: Type.String({ description: "Task id to update" }),
  status: Type.Optional(updateStatusUnion("New status for the task, or `deleted` to remove it")),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
  addBlocks: Type.Optional(Type.Array(Type.String())),
  addBlockedBy: Type.Optional(Type.Array(Type.String())),
});

export interface TaskToolHooks { beforeCreate(): void; afterUpdate(id: string, changed: { status?: TaskStatus }): void; }
export function registerTaskTools(pi: ExtensionAPI, getStore: () => TaskStore, onChange: () => void, hooks: TaskToolHooks): void {
  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: CREATE_DESCRIPTION,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to find the next task in ID order after completing one; the tools refuse out-of-order updates.",
    ],
    parameters: TaskCreateParams,
    async execute(_id, args) {
      const subject = cleanOptional(args.subject);
      if (!subject) return textResult("Error: subject required for create");
      hooks.beforeCreate();                         // auto-clear: a first create after a finished run starts clean
      const task = getStore().create(subject, cleanOptional(args.description) ?? "", cleanOptional(args.activeForm), args.metadata);
      onChange();
      return textResult(`Created #${task.id}: ${task.subject} (pending)`);
    },
  });
  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: LIST_DESCRIPTION,
    parameters: Type.Object({ status: Type.Optional(statusUnion("Only show tasks with this status")) }),
    async execute(_id, args) {
      const store = getStore();
      const tasks = args.status ? store.list().filter(t => t.status === args.status) : store.list();
      return textResult(bounded(tasks.length ? tasks.map(t => formatTask(t, openBlockersOf(store, t))).join("\n") : "No tasks"));
    },
  });
  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: GET_DESCRIPTION,
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_id, args) {
      const store = getStore();
      const t = store.get(args.task_id);
      if (!t) return textResult(`Error: #${args.task_id} not found`);
      const lines = [formatTask(t, openBlockersOf(store, t)), ` ${t.description}`];
      if (t.blocks.length > 0) lines.push(` Blocks: ${t.blocks.map(id => `#${id}`).join(", ")}`);
      return textResult(bounded(lines.join("\n")));
    },
  });
  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: UPDATE_DESCRIPTION,
    promptGuidelines: [
      "Mark a task in_progress before starting work on it, and completed in the same turn the work finishes.",
      "Work tasks in ID order and keep exactly one in_progress; the tool refuses out-of-order updates.",
    ],
    parameters: TaskUpdateParams,
    async execute(_id, args) {
      const store = getStore();
      const current = store.get(args.task_id);
      if (!current) return textResult(`Error: #${args.task_id} not found`);
      // A dependency may only point at an earlier-numbered task. A backward edge is an
      // unrecoverable contradiction of the enforced sequence: the earlier task could never
      // start (its blocker is later and unfinished) and the later could never finish (the
      // earlier is unfinished). Refused at declaration, from either end, before it can
      // deadlock the list.
      for (const id of args.addBlockedBy ?? []) {
        if (id !== args.task_id && idOrder(id) > idOrder(args.task_id)) {
          return textResult(`Error: #${args.task_id} cannot depend on #${id} — dependencies point at earlier-numbered tasks; recreate this task after its prerequisite, or drop the dependency`);
        }
      }
      for (const id of args.addBlocks ?? []) {
        if (id === args.task_id) continue;               // a self-edge is the store's malformed-dependency warning
        const target = store.get(id);
        // Hanging an unfinished task on an in-progress one is the same violation the edge
        // gate refuses on the target's own updates — it must not be creatable from this
        // end either. A finished blocker is not an open one, so it stays allowed.
        if (target?.status === "in_progress" && current.status !== "completed") {
          return textResult(`Error: #${args.task_id} cannot block #${id} — #${id} is in progress and #${args.task_id} is unfinished; complete or delete #${args.task_id} first`);
        }
        if (idOrder(id) < idOrder(args.task_id)) {
          return textResult(`Error: #${args.task_id} cannot block #${id} — dependencies point at earlier-numbered tasks; recreate #${id} after this task, or drop the dependency`);
        }
      }
      // The rule is "in_progress implies no unfinished blockers", checked against the state this
      // update would LEAVE rather than the one it starts from: a single call can both start a
      // task and declare an unfinished blocker on it. A self-edge is a separate malformed-
      // dependency defect the store already warns about, so it is excluded here. Reverting to
      // pending, and edits that touch neither the status nor the edges, are never gated.
      const touchesRule = args.status === "in_progress" || (args.addBlockedBy?.length ?? 0) > 0;
      if (touchesRule && (args.status ?? current.status) === "in_progress") {
        const proposed = [...new Set([...current.blockedBy, ...(args.addBlockedBy ?? [])])]
          .filter(id => id !== args.task_id);
        const open = openBlockersAmong(store, proposed);
        if (open.length > 0) {
          return textResult(`Error: #${args.task_id} is blocked by ${open.map(id => `#${id}`).join(", ")} — finish or unblock those first`);
        }
      }
      // The generalized sequence gate. The blocker gate above is decoration the model walks
      // past by simply not declaring an edge, and the owner's list must read as a workflow
      // with no cooperation required: task number order IS the declared order. No task starts
      // or completes while an earlier-numbered task is unfinished, and exactly one task may
      // be in progress (the spinner marks what is happening now). `deleted` is the only exit
      // for an earlier task that will never be done; edits that claim no work never gate.
      if (args.status === "in_progress" || args.status === "completed") {
        const verb = args.status === "in_progress" ? "started" : "completed";
        const others = store.list().filter(t => t.id !== args.task_id);
        const earlier = others
          .filter(t => idOrder(t.id) < idOrder(args.task_id) && t.status !== "completed")
          .sort((a, b) => idOrder(a.id) - idOrder(b.id));
        if (earlier.length > 0) {
          return textResult(`Error: #${args.task_id} cannot be ${verb} while #${earlier[0].id} is unfinished — work tasks in ID order, or set #${earlier[0].id} to deleted if it is no longer needed`);
        }
        if (args.status === "in_progress") {
          const active = others.find(t => t.status === "in_progress");
          if (active) {
            return textResult(`Error: #${active.id} is already in_progress — complete it or set it to deleted before starting #${args.task_id}`);
          }
        }
      }
      // Snapshot before the update: a memory-only store mutates the live object in place, so
      // `current` and `result.task` are the same object and the transition would never show.
      const previousStatus = current.status;
      const result = store.update(args.task_id, args);
      if (!result.task) {
        // A delete removes the task, so its result is `task: undefined` — the same shape as a
        // missing id, and `changedFields` is the only thing that tells them apart. Without this
        // branch the only way to retire a row reported a false error, skipped the hook and
        // skipped `onChange()`, so the panel kept drawing a row the store had already dropped.
        if (!result.changedFields.includes("deleted")) return textResult(`Error: #${args.task_id} not found`);
        hooks.afterUpdate(args.task_id, {});
        onChange();
        return textResult(`Deleted #${args.task_id}`);
      }
      hooks.afterUpdate(args.task_id, { status: args.status === "deleted" ? undefined : args.status });
      onChange();
      const transition = previousStatus === result.task.status ? "" : ` (${previousStatus} → ${result.task.status})`;
      const warnings = result.warnings.length ? `\nWarnings: ${result.warnings.join("; ")}` : "";
      return textResult(`Updated #${result.task.id}${transition}${warnings}`);
    },
  });
}
