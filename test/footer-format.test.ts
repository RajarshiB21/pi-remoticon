import { describe, it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildFooterLines, type FooterInput } from "../lib/footer-format.js";
import { RunState, effortRank, topRule, dotColor, ruleColor } from "../lib/ui-state.js";
import { Composer } from "../lib/composer.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { TUI } from "@earendil-works/pi-tui";
import { initTheme, getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const input: FooterInput = { modelId: "model界", state: "Reasoning", dot: [185,165,232], ctxPercent: null, ctxWindow: 1000000,
  usage: { input: 127, output: 97, cacheRead: 6700, cacheWrite: 0, cost: 0 }, cwd: "D:/workspace", branch: "main", auto: false };
const plain = (s: string) => stripVTControlCharacters(s);

describe("two-row footer and decoration", () => {
  it("formats roots, small costs and the approved compact fields", () => {
    for (const [cost, expected] of [[0, "$0.00"], [0.04, "$0.04"], [0.002, "$0.002"], [0.001234, "$0.001"], [0.0001, "$0.0001"], [0.00001, "<$0.0001"]] as const) {
      const line = plain(buildFooterLines({ ...input, ctxPercent: 18, usage: { ...input.usage!, cost } }, 120)[1]);
      expect(line).toContain(`18% context · auto off / ↑127 ↓97 ${expected}`);
      expect(line.split(/\s+/)).toContain(expected);
    }
    for (const cwd of ["D:\\", "C:/", "/", "\\\\server\\share\\"]) {
      expect(plain(buildFooterLines({ ...input, cwd, branch: null }, 120)[1]).trimEnd()).toMatch(new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
    }
  });
  it("adds a display-only prompt while native cursor, paste, wrapping and submission remain intact", () => {
    initTheme("dark", false);
    const editor = new Composer({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, getEditorTheme(), new KeybindingsManager());
    editor.focused = true;
    editor.setPaddingX(0);
    expect(plain(editor.render(80)[1])).toMatch(/^› /);
    expect(editor.getText()).toBe("");
    editor.setText("界ab"); editor.render(40);
    editor.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 40, height: 3, screenX: 4, screenY: 1, shift: false, alt: false, ctrl: false });
    editor.handleInput("X");
    expect(editor.getText()).toBe("界Xab");
    editor.handleInput("\x1b[200~\nsecond\x1b[201~");
    expect(editor.getText()).toContain("\nsecond");
    const rows = editor.render(80).map(plain);
    expect(rows[1]).toMatch(/^› /);
    expect(rows[2]).toMatch(/^ {2}/);
    expect(rows.filter(row => row.includes("›"))).toHaveLength(1);
    let submitted = "";
    editor.onSubmit = text => { submitted = text; };
    const text = editor.getText(); editor.handleInput("\r");
    expect(submitted).toBe(text);
    editor.setText("line\n".repeat(20));
    expect(plain(editor.render(80)[0])).toContain("↑");
    for (const width of [1, 2, 4, 5, 60, 80, 120]) for (const row of editor.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    editor.setText("!echo hello");
    expect(editor.getText()).toBe("!echo hello");
    expect(plain(editor.render(80)[1])).toContain("!echo hello");
  });
  it("keeps honest context, auto state and known zero cost, then drops optional fields first", () => {
    const wide = buildFooterLines(input, 150).map(plain);
    expect(wide[0]).toMatch(/^● model界.*Reasoning$/);
    expect(wide[1]).toContain("? context · auto off / ↑127 ↓97 $0.00");
    expect(wide[1]).toMatch(/workspace · main$/);
    expect(wide[1]).not.toMatch(/1.0M|R6.7k|W0/);
    const narrow = buildFooterLines(input, 35).map(plain);
    expect(narrow[0]).toContain("model界");
    expect(narrow[0]).toContain("Reasoning");
    expect(narrow[1]).toContain("auto off");
    expect(narrow[1]).not.toContain("workspace");
    expect(narrow[1]).not.toContain("$0.00");
    expect(buildFooterLines({ ...input, usage: null, auto: true, ctxPercent: 0 }, 100).map(plain)[1]).toContain("0% context · auto on");
    expect(buildFooterLines({ ...input, usage: null }, 100).map(plain)[1]).not.toContain("$");
  });
  it("bounds styled wide and combining characters at every narrow width", () => {
    for (let width = 0; width <= 100; width++) {
      const rows = buildFooterLines({ ...input, modelId: "界é🙂".repeat(20) }, width);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      if (width >= 1) expect(plain(rows[0])).toContain("●");
    }
  });
  it("ranks supported choices without assuming missing levels exist", () => {
    expect(effortRank(["off", "low", "high"], "low")).toBe(0.5);
    expect(effortRank(["off"], "off")).toBe(0);
    expect(effortRank(["low", "high"], "unknown")).toBe(0);
    expect(effortRank(["low", "high"], "high")).toBe(1);
    expect(ruleColor(0)).toEqual([75,67,95]);
    expect(ruleColor(1)).toEqual([130,112,160]);
  });
  it("draws fixed-width rules and deterministic motion, with no movement when disabled", () => {
    for (const width of [0,1,2,30,100]) for (const rank of [0,0.5,1]) {
      expect(visibleWidth(topRule(width, rank, 2, "Reasoning", true))).toBe(width);
      expect(topRule(width, rank, 2, "Reasoning", false)).toBe(topRule(width, rank, 20, "Reasoning", false));
    }
    expect(dotColor(0, "Reasoning", true)).not.toEqual(dotColor(1, "Reasoning", true));
    expect(dotColor(0, "Writing", false)).toEqual(dotColor(3, "Writing", false));
    expect(dotColor(0, "Writing", false)).toEqual([220,211,236]);
  });
  it("keeps one run across retries, freezes prompt phase and clears unfinished tools on settlement", () => {
    const run = new RunState();
    run.start(1000);
    run.tools.add("one");
    run.start(2000);
    expect(run.started).toBe(1000);
    run.pause(3000); run.pause(4000);
    expect(run.seconds(6000)).toBe(2);
    run.resume(7000); run.resume(8000);
    expect(run.seconds(8000)).toBe(3);
    run.settle();
    expect(run.active).toBe(false);
    expect(run.tools.size).toBe(0);
    run.start(9000);
    expect(run.seconds(9000)).toBe(0);
  });
});
