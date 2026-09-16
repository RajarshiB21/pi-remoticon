// Adapted from https://github.com/tintinweb/pi-tasks (MIT, (c) 2026 tintinweb) src/types.ts.
// Delta: the subagent-only `owner` field is dropped (subagents are out of scope).
export type TaskStatus = "pending" | "in_progress" | "completed";
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  metadata: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}
export interface TaskStoreData { nextId: number; tasks: Task[]; }
