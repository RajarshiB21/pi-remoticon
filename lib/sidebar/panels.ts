// The column is a list of slots, not one panel. Adapted from the group/drop model of
// https://github.com/mkaz/pi-mkaz-sidebar (MIT, (c) 2026 Michael Kazmierczak) src/sidebar.ts;
// deltas: slots are budget-bounded and shrink before they drop, and a drop is announced.
import { dockLine, type Painter } from "./paint.js";
import { renderTasksSlot } from "./tasks/panel.js";
import type { SlotGlyphs } from "./tasks/glyphs.js";
import type { Task } from "./tasks/types.js";

export interface Slot {
  id: string;
  title: string;
  priority: number;          // higher wins space; the lowest drops first
  required: boolean;        // never shrunk below content, never dropped
  minRows: number;
  maxRows: number;           // the row budget the slot may occupy
  /** Box lines for the slot, capped at `rowBudget` content rows. */
  render(p: Painter, sidebarWidth: number, rowBudget: number): string[];
}

export function makeTasksSlot(now: () => number, tasks: () => readonly Task[], glyphs: SlotGlyphs, sidebarWidth: () => number): Slot {
  return {
    id: "tasks", title: "TASKS", priority: 90, required: true, minRows: 4, maxRows: 6,
    render: (p, _width, rowBudget) => renderTasksSlot(p, tasks(), now(), glyphs, sidebarWidth()).slice(0, rowBudget + 2),
  };
}

/** Compose the full column: slots stacked from the top, dock on every row,
 *  exactly `sidebarWidth` cells per line, filled to `height`. */
export function composeColumn(p: Painter, slots: Slot[], height: number, sidebarWidth: number): string[] {
  const budgets = new Map(slots.map(s => [s.id, s.maxRows]));
  const rendered = () => slots.map(s => ({ slot: s, lines: s.render(p, sidebarWidth, budgets.get(s.id) ?? s.maxRows) }));
  let lines = rendered().flatMap(e => e.lines);
  const fits = () => lines.length <= height;
  // 1. shrink non-required slots toward minRows, lowest priority first
  while (!fits()) {
    const victim = slots.filter(s => !s.required && (budgets.get(s.id) ?? 0) > s.minRows)
      .sort((a, b) => a.priority - b.priority)[0];
    if (!victim) break;
    budgets.set(victim.id, (budgets.get(victim.id) ?? victim.maxRows) - 1);
    lines = rendered().flatMap(e => e.lines);
  }
  // 2. drop the lowest-priority non-required slot entirely, announced once
  const dropped: string[] = [];
  while (!fits()) {
    const victim = slots.filter(s => !s.required && !dropped.includes(s.id))
      .sort((a, b) => a.priority - b.priority)[0];
    if (!victim) break;
    dropped.push(victim.id);
    lines = rendered().filter(e => !dropped.includes(e.slot.id)).flatMap(e => e.lines);
  }
  const out = lines.slice(0, height).map(l => dockLine(p, l, sidebarWidth));
  while (out.length < height) out.push(dockLine(p, "", sidebarWidth));
  if (dropped.length) {
    const notice = `${dropped.join(", ")} hidden \u00B7 sidebar full`;
    out[out.length - 1] = dockLine(p, p.fg("dim", notice), sidebarWidth);
  }
  return out;
}
