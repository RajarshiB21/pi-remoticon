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

import type { TaskStatus } from "./types.js";

export const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
/** pi-tasks' own status union shape, without its internal helper: */
const StatusUnion = Type.Unsafe<"pending" | "in_progress" | "completed">({ type: "string", enum: ["pending", "in_progress", "completed"] });

const cleanOptional = (v?: string) => v?.trim().replace(/\s+/g, " ") || undefined;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
function bounded(text: string): string {
  const r = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 300, maxLines: DEFAULT_MAX_LINES - 2 });
  return r.truncated && r.content ? `${r.content}\n\n[Output truncated: use TaskList or TaskGet for the rest.]` : text;
}
const formatTask = (t: { id: string; subject: string; status: string; activeForm?: string }) =>
  `[${t.status}] #${t.id} ${t.subject}${t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : ""}`;

const CREATE_DESCRIPTION = [
  "Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.",
  "It also helps the user understand the progress of the task and overall progress of their requests.",
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
  "- After receiving new instructions - Immediately capture user requirements as tasks",
  "- When you start working on a task - Mark it as in_progress BEFORE beginning work",
  "- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation",
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
  "- To see what tasks are available to work on (status: 'pending', no owner, not blocked)",
  "- To check overall progress on the project",
  "- To find tasks that are blocked and need dependencies resolved",
  "- After completing a task, to check for newly unblocked work or claim the next available task",
  "- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones",
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
  "- If you encounter errors, blockers, or cannot finish, keep the task as in_progress",
  "- When blocked, create a new task describing what needs to be resolved",
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
  "Status progresses: `pending` → `in_progress` → `completed`",
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
  status: Type.Optional(StatusUnion),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
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
      "Use TaskList to check for available work after completing a task.",
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
    parameters: Type.Object({ status: Type.Optional(StatusUnion) }),
    async execute(_id, args) {
      const tasks = args.status ? getStore().list().filter(t => t.status === args.status) : getStore().list();
      return textResult(bounded(tasks.length ? tasks.map(formatTask).join("\n") : "No tasks"));
    },
  });
  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: GET_DESCRIPTION,
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_id, args) {
      const t = getStore().get(args.task_id);
      if (!t) return textResult(`Error: #${args.task_id} not found`);
      return textResult(bounded(`${formatTask(t)}\n ${t.description}`));
    },
  });
  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: UPDATE_DESCRIPTION,
    parameters: TaskUpdateParams,
    async execute(_id, args) {
      const current = getStore().get(args.task_id);
      if (!current) return textResult(`Error: #${args.task_id} not found`);
      const result = getStore().update(args.task_id, args);
      if (!result.task) return textResult(`Error: #${args.task_id} not found`);
      hooks.afterUpdate(args.task_id, { status: args.status });
      onChange();
      const transition = current.status === result.task.status ? "" : ` (${current.status} → ${result.task.status})`;
      const warnings = result.warnings.length ? `\nWarnings: ${result.warnings.join("; ")}` : "";
      return textResult(`Updated #${result.task.id}${transition}${warnings}`);
    },
  });
}
