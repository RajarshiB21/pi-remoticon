import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makePainter, type Painter } from "../lib/sidebar/paint.js";
import { DEFAULT_GLYPHS } from "../lib/sidebar/tasks/glyphs.js";
import { composeColumn, makeTasksSlot, type Slot } from "../lib/sidebar/panels.js";
import type { Task } from "../lib/sidebar/tasks/types.js";

const p: Painter = makePainter({ fg: (_r, t) => t, bold: t => t });
const mk = (id: string, status: Task["status"]): Task =>
  ({ id, subject: `task ${id}`, description: "", status, metadata: {}, blocks: [], blockedBy: [], createdAt: 0, updatedAt: 0 });
const stub = (id: string, priority: number, required: boolean, rows: number): Slot => ({
  id, title: id.toUpperCase(), priority, required, minRows: 2, maxRows: rows,
  render: (_p, width, budget) => Array.from({ length: Math.min(rows, budget) }, (_, i) => `${id}${i} `.repeat(width / 4 | 0).slice(0, width - 2)),
});

describe("composeColumn", () => {
  it("docks every row and fills the height", () => {
    const tasks = [mk("1", "pending")];
    const column = composeColumn(p, [makeTasksSlot(() => 0, () => tasks, DEFAULT_GLYPHS, () => 44)], 30, 44);
    expect(column).toHaveLength(30);
    column.forEach(l => { expect(visibleWidth(l)).toBe(44); expect(l.startsWith("│")).toBe(true); });
  });
  it("shrinks the lowest-priority slot before dropping anything", () => {
    const a = stub("alpha", 90, false, 6);
    const b = stub("beta", 10, false, 6);
    const column = composeColumn(p, [a, b], 8, 44);       // 12 rows cannot fit in 8: beta shrinks to minRows
    const flat = column.join("\n");
    expect(flat).toContain("alpha0");
    expect(flat).toContain("beta0");
    expect(flat).not.toContain("hidden");
    expect(column).toHaveLength(8);
  });
  it("drops the lowest-priority slot with one notice once shrinking cannot help", () => {
    const a = stub("alpha", 90, true, 20);                // required, alone taller than the column
    const b = stub("beta", 10, false, 6);
    const column = composeColumn(p, [a, b], 14, 44);
    expect(column.join("\n")).toContain("beta hidden \u00B7 sidebar full");
    expect(column.join("\n")).toContain("alpha0");
    expect(column).toHaveLength(14);
  });
  it("never drops the required slot, and names only what it dropped", () => {
    const a = stub("alpha", 90, true, 20);
    const b = stub("beta", 10, false, 6);
    const flat = composeColumn(p, [a, b], 10, 44).join("\n");
    expect(flat).toContain("alpha0");
    expect(flat).toContain("beta hidden \u00B7 sidebar full");
    expect(flat).not.toContain("alpha hidden");
  });
});
