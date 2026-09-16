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
  // Mirrors the TASKS slot's budget in lib/sidebar/panels.ts. The panel is built from code, not
  // from this file, so nothing reads this; it is kept equal so the documented default is not a
  // lie. `maxRows` must stay at or above ROWS_SHOWN + 2 or the panel loses its summary line.
  slots: [{ id: "tasks", priority: 90, required: true, minRows: 4, maxRows: 9 }],
  tasks: { autoClear: "on_list_complete", glyphs: {} },
};
/** Read a config file. An absent file is normal and silent; a file that exists but does not
 *  hold a JSON object is reported, because otherwise it silently does nothing. */
const readJson = (path: string, onInvalid?: (path: string) => void): Record<string, unknown> => {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return {}; }                                  // absent: not an error
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* not JSON — reported below */ }
  onInvalid?.(path);
  return {};
};
const asObject = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

const AUTO_CLEAR_MODES = ["never", "on_list_complete", "on_task_complete"] as const;
const isAutoClearMode = (v: unknown): v is SidebarConfig["tasks"]["autoClear"] =>
  typeof v === "string" && (AUTO_CLEAR_MODES as readonly string[]).includes(v);
/** The first VALID value wins, so a typo in the project file falls through to the global value
 *  rather than silently disabling auto-clear. Config is external data: validated, not cast. */
const pickAutoClear = (...candidates: unknown[]): SidebarConfig["tasks"]["autoClear"] =>
  candidates.find(isAutoClearMode) ?? DEFAULT_CONFIG.tasks.autoClear;

export function loadConfig(agentDir: string, cwd?: string, trusted = true, onInvalidJson?: (path: string) => void): SidebarConfig {
  const globalFile = asObject(readJson(join(agentDir, "remoticon-sidebar.json"), onInvalidJson));
  const projectFile = trusted && cwd ? asObject(readJson(join(cwd, ".pi", "remoticon-sidebar.json"), onInvalidJson)) : {};
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
      autoClear: pickAutoClear(projectTasks.autoClear, globalTasks.autoClear),
      glyphs: { ...asObject(globalTasks.glyphs), ...asObject(projectTasks.glyphs) },
    },
  };
}
/** True when the trusted project file changes anything the global file alone would give.
 *  Comparing the whole config covers every key group — including `sidebar.on` and `tasks`,
 *  which a key-by-key comparison here used to miss — and it cannot report an override for an
 *  invalid global value, because the same validation runs on both sides. */
export function projectOverrideActive(cfg: SidebarConfig, agentDir: string): boolean {
  return JSON.stringify(cfg) !== JSON.stringify(loadConfig(agentDir));
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
