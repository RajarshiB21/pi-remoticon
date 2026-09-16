// Where per-session task files live.
// Adapted from https://github.com/tintinweb/pi-tasks (MIT, (c) 2026 tintinweb) src/task-paths.ts.
// Delta: agent-dir scope ONLY. The workspace `.pi/tasks` location is never read or
// written, so nothing ever lands inside a project repository.
import { rmdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function projectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
export function sessionTaskFile(agentDir: string, cwd: string, sessionId: string): string {
  return join(agentDir, "tasks", "sessions", projectKey(cwd), `tasks-${sessionId}.json`);
}
/** Remove the workspace's session directory once it holds nothing. */
export function reclaimSessionTasksDir(agentDir: string, cwd: string): void {
  try { rmdirSync(join(agentDir, "tasks", "sessions", projectKey(cwd))); } catch { /* other sessions still stored */ }
}
