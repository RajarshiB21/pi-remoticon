import { describe, it, expect } from "vitest";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { makePainter, type Painter } from "../lib/sidebar/paint.js";
import { DEFAULT_GLYPHS } from "../lib/sidebar/tasks/glyphs.js";
import { windowTasks, numWidthFor, taskRow, summaryRow, renderTasksSlot } from "../lib/sidebar/tasks/panel.js";
import type { Task } from "../lib/sidebar/tasks/types.js";

const p: Painter = makePainter({ fg: (_r, t) => t, bold: t => t });
const strip = (s: string) => stripTerminalSequences(s);
const mk = (id: string, status: Task["status"], subject = `task ${id}`): Task =>
  ({ id, subject, description: "", status, metadata: {}, blocks: [], blockedBy: [], createdAt: 0, updatedAt: 0 });

describe("window", () => {
  it("shows everything for short lists", () => {
    expect(windowTasks([mk("1", "pending"), mk("2", "pending")])).toHaveLength(2);
  });
  it("starts at the earliest unfinished task, keeping the just-finished row", () => {
    const tasks = [mk("1", "completed"), mk("2", "completed"), mk("3", "in_progress"),
      ...[4, 5, 6, 7].map(i => mk(String(i), "pending"))];
    expect(windowTasks(tasks).map(t => t.id)).toEqual(["2", "3", "4", "5", "6"]);
  });
  it("shows the last five when everything is done", () => {
    const tasks = [1, 2, 3, 4, 5, 6, 7].map(i => mk(String(i), "completed"));
    expect(windowTasks(tasks).map(t => t.id)).toEqual(["3", "4", "5", "6", "7"]);
  });
});

describe("rows", () => {
  it("formats one line: glyph, padded number, subject", () => {
    const row = strip(taskRow(p, mk("3", "pending"), 0, DEFAULT_GLYPHS, 38, 2));
    expect(row).toBe("\u25CB 03  task 3");
  });
  it("clips the subject with the three-dot marker at 31 cells", () => {
    const row = strip(taskRow(p, mk("4", "pending", "Write the sidebar compose tests now please"), 0, DEFAULT_GLYPHS, 38, 2));
    expect(row.endsWith("...")).toBe(true);
    expect(row).not.toContain("#");
  });
  it("pads the number column for three-digit ids", () => {
    expect(strip(taskRow(p, mk("100", "pending"), 0, DEFAULT_GLYPHS, 38, 3)).startsWith("\u25CB 100")).toBe(true);
    expect(numWidthFor([mk("99", "pending"), mk("100", "pending")])).toBe(3);
    expect(numWidthFor([mk("1", "pending")])).toBe(2);
  });
  it("spins for in_progress and dims completed", () => {
    expect(strip(taskRow(p, mk("1", "in_progress", "work"), 0, DEFAULT_GLYPHS, 38, 2)).startsWith("\u2733")).toBe(true);
    expect(strip(taskRow(p, mk("1", "completed", "work"), 0, DEFAULT_GLYPHS, 38, 2)).startsWith("\u25CF")).toBe(true);
  });
  it("summarizes the whole truth", () => {
    expect(strip(summaryRow(p, [mk("1", "completed"), mk("2", "in_progress"), mk("3", "pending")], DEFAULT_GLYPHS)))
      .toBe("\u2714 1 completed \u00B7 2 pending");
  });
});

describe("slot frames (golden)", () => {
  const frame = (tasks: Task[]) => renderTasksSlot(p, tasks, 0, DEFAULT_GLYPHS, 44).map(strip);
  it("empty: compact box with No tasks", () => {
    const lines = frame([]);
    expect(lines).toHaveLength(4);                     // top, No tasks, bottom, one blank row
    expect(lines[1]).toContain("No tasks");
    lines.forEach(l => expect(visibleWidth(l)).toBe(42));
  });
  it("three tasks: list plus summary, summary tells the truth", () => {
    const lines = frame([mk("1", "completed"), mk("2", "in_progress", "working"), mk("3", "pending")]);
    expect(lines).toHaveLength(7);                    // top + 3 rows + summary + bottom + blank
    expect(lines[1]).toContain("\u25CF 01");
    expect(lines[2]).toContain("\u2733 02");
    expect(lines[3]).toContain("\u25CB 03");
    expect(lines[4]).toContain("1 completed \u00B7 2 pending");
    lines.forEach(l => expect(visibleWidth(l)).toBe(42));
  });
  it("sixty tasks: exactly five rows plus the summary, no wrapping", () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(String(i + 1), i < 10 ? "completed" : "pending"));
    const lines = frame(many);
    const rows = lines.filter(l => /(\u25CB|\u25CF|\u2733) \d\d /.test(l));
    expect(rows).toHaveLength(5);
    expect(lines.some(l => l.includes("hidden"))).toBe(false);
    lines.forEach(l => expect(l.split("\n")).toHaveLength(1));
  });
});
