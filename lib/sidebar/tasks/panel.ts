// The TASKS slot: the owner's approved row design.
// One line per task, fixed columns, no wrapping. Adapted window/summary thinking from
// https://github.com/mkaz/pi-mkaz-sidebar (MIT) and https://github.com/tintinweb/pi-tasks (MIT);
// the layout, glyphs, colors and summary wording are the owner's spec.
import { boxTop, boxRow, boxBottom, clip, type Painter } from "../paint.js";
import type { SlotGlyphs } from "./glyphs.js";
import type { Task } from "./types.js";

export const ROWS_SHOWN = 7;
const byId = (a: Task, b: Task) => Number(a.id) - Number(b.id);

export function numWidthFor(tasks: readonly Task[]): number {
  return Math.max(2, ...tasks.map(t => t.id.length));
}
/** Seven rows in number order, starting at the earliest unfinished task, one row
 *  earlier if that row is completed, so the just-finished work stays visible. */
export function windowTasks(tasks: readonly Task[], count = ROWS_SHOWN): Task[] {
  const ordered = [...tasks].sort(byId);
  if (ordered.length <= count) return ordered;
  let start = ordered.findIndex(t => t.status !== "completed");
  if (start < 0) start = ordered.length - count;
  else if (start > 0 && ordered[start - 1].status === "completed") start -= 1;
  start = Math.max(0, Math.min(start, ordered.length - count));
  return ordered.slice(start, start + count);
}

export function taskRow(p: Painter, task: Task, now: number, glyphs: SlotGlyphs, innerWidth: number, numWidth: number): string {
  const glyph = task.status === "completed" ? p.fg("success", glyphs.completed)
    : task.status === "in_progress" ? p.fg("customMessageLabel", glyphs.spinner[Math.floor(now / 150) % glyphs.spinner.length])
    : p.fg("text", glyphs.pending);
  const color = task.status === "completed" ? "dim" : task.status === "in_progress" ? "customMessageLabel" : "text";
  const num = task.id.padStart(numWidth, "0");
  const room = innerWidth - 2 - numWidth - 2 - 1;
  const subject = clip(task.subject, room, glyphs.truncation);
  return glyph + " " + p.fg("dim", num) + "  " + p.fg(color, subject);
}

export function summaryRow(p: Painter, tasks: readonly Task[], glyphs: SlotGlyphs): string {
  const done = tasks.filter(t => t.status === "completed").length;
  const pending = tasks.length - done;
  return p.fg("success", glyphs.summary) + " " + p.fg("dim", `${done} completed \u00B7 ${pending} pending`);
}

/** Box lines (each exactly sidebarWidth - 2 cells), dock applied by the column. */
export function renderTasksSlot(p: Painter, tasks: readonly Task[], now: number, glyphs: SlotGlyphs, sidebarWidth: number): string[] {
  const boxWidth = sidebarWidth - 2;
  const inner = boxWidth - 4;
  const lines = [boxTop(p, "TASKS", boxWidth)];
  if (tasks.length === 0) {
    lines.push(boxRow(p, p.fg("dim", "No tasks"), boxWidth));
  } else {
    const numWidth = numWidthFor(tasks);
    for (const t of windowTasks(tasks)) lines.push(boxRow(p, taskRow(p, t, now, glyphs, inner, numWidth), boxWidth));
    lines.push(boxRow(p, summaryRow(p, tasks, glyphs), boxWidth));
  }
  lines.push(boxBottom(p, boxWidth));
  lines.push(" ".repeat(boxWidth));                    // one blank row after the box
  return lines;
}
