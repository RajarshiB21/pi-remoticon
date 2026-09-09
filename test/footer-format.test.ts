import { describe, it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildFooterLines, type FooterInput } from "../lib/footer-format.js";
import { RunState, effortRank, topRule, dotColor, ruleColor } from "../lib/ui-state.js";

const input: FooterInput = { modelId: "model界", state: "Reasoning", dot: [185,165,232], ctxPercent: null, ctxWindow: 1000000,
  usage: { input: 127, output: 97, cacheRead: 6700, cacheWrite: 0, cost: 0 }, cwd: "D:/workspace", branch: "main", auto: false };
const plain = (s: string) => stripVTControlCharacters(s);

describe("two-row footer and decoration", () => {
  it("keeps honest context, auto state and known zero cost, then drops optional fields first", () => {
    const wide = buildFooterLines(input, 150).map(plain);
    expect(wide[0]).toMatch(/^● model界.*Reasoning$/);
    expect(wide[1]).toContain("?/1.0M · auto off");
    expect(wide[1]).toContain("$0.000");
    expect(wide[1]).toMatch(/D:\/workspace \(main\)$/);
    const narrow = buildFooterLines(input, 35).map(plain);
    expect(narrow[0]).toContain("model界");
    expect(narrow[0]).toContain("Reasoning");
    expect(narrow[1]).toContain("auto off");
    expect(narrow[1]).not.toContain("workspace");
    expect(narrow[1]).not.toContain("$0.000");
    expect(buildFooterLines({ ...input, usage: null, auto: true, ctxPercent: 0 }, 100).map(plain)[1]).toContain("0.0%/1.0M · auto on");
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
