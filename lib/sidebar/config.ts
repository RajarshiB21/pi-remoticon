// Config as data, adapted from the merge model of https://github.com/tintinweb/pi-tasks
// (MIT, (c) 2026 tintinweb) src/tasks-config.ts. Deltas: our file pair is
// remoticon-sidebar.json; /sidebar writes the GLOBAL file; slots replace wholesale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SidebarConfig {
  sidebar: { width: number; on: boolean };
  slots: { id: string; priority: number; required: boolean; minRows: number; maxRows: number }[];
  tasks: { autoClear: "never" | "on_list_complete" | "on_task_complete"; glyphs: Record<string, unknown> };
}
export const DEFAULT_CONFIG: SidebarConfig = {
  sidebar: { width: 44, on: true },
  slots: [{ id: "tasks", priority: 90, required: true, minRows: 4, maxRows: 6 }],
  tasks: { autoClear: "on_list_complete", glyphs: {} },
};
const readJson = (path: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};
const asObject = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function loadConfig(agentDir: string, cwd?: string, trusted = true): SidebarConfig {
  const globalFile = asObject(readJson(join(agentDir, "remoticon-sidebar.json")));
  const projectFile = trusted && cwd ? asObject(readJson(join(cwd, ".pi", "remoticon-sidebar.json"))) : {};
  const globalSidebar = asObject(globalFile.sidebar);
  const projectSidebar = asObject(projectFile.sidebar);
  const globalTasks = asObject(globalFile.tasks);
  const projectTasks = asObject(projectFile.tasks);
  const width = Number(projectSidebar.width ?? globalSidebar.width ?? DEFAULT_CONFIG.sidebar.width);
  const on = projectSidebar.on ?? globalSidebar.on ?? DEFAULT_CONFIG.sidebar.on;
  return {
    sidebar: { width: Number.isInteger(width) && width >= 28 && width <= 60 ? width : DEFAULT_CONFIG.sidebar.width, on: on !== false },
    slots: Array.isArray(projectFile.slots) ? projectFile.slots as SidebarConfig["slots"] : Array.isArray(globalFile.slots) ? globalFile.slots as SidebarConfig["slots"] : DEFAULT_CONFIG.slots,
    tasks: {
      autoClear: (projectTasks.autoClear ?? globalTasks.autoClear ?? DEFAULT_CONFIG.tasks.autoClear) as SidebarConfig["tasks"]["autoClear"],
      glyphs: { ...asObject(globalTasks.glyphs), ...asObject(projectTasks.glyphs) },
    },
  };
}
export function projectOverrideActive(cfg: SidebarConfig, agentDir: string): boolean {
  const globalFile = asObject(readJson(join(agentDir, "remoticon-sidebar.json")));
  return cfg.sidebar.width !== (Number(asObject(globalFile.sidebar).width) || DEFAULT_CONFIG.sidebar.width)
    || JSON.stringify(cfg.slots) !== JSON.stringify(Array.isArray(globalFile.slots) ? globalFile.slots : DEFAULT_CONFIG.slots);
}
function writeGlobal(agentDir: string, mutate: (g: Record<string, unknown>) => void): void {
  const global = asObject(readJson(join(agentDir, "remoticon-sidebar.json")));
  mutate(global);
  const path = join(agentDir, "remoticon-sidebar.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(global, null, 2));
}
export function saveGlobalSideFlag(agentDir: string, on: boolean): void {
  writeGlobal(agentDir, g => { g.sidebar = { ...asObject(g.sidebar), on }; });
}
export function saveGlobalWidth(agentDir: string, width: number): void {
  writeGlobal(agentDir, g => { g.sidebar = { ...asObject(g.sidebar), width }; });
}
