// S3/S4 — Unit lane for the footer builder. Deterministic (our renderer, not a
// model), so exact-string assertions are allowed. A stub theme makes fg identity
// so assertions read plain text; the dot's raw truecolor escape is stripped for
// the layout assertions and checked separately for color.
import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildFooterLine, fmtCount, cacheHitPct, hexFg, DOT_IDLE, DOT_WORKING, type FooterLineInput } from "../lib/footer-format.js";

const stubTheme = { fg: (_c: string, t: string) => t } as unknown as Theme;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Fixture inputs chosen to reproduce mockup.html exactly — NOT the live model.
// buildFooterLine is pure: it renders whatever modelId it is handed. The live
// name comes from ctx.model.id at runtime (footer.ts); switching your model
// changes the footer, never this test.
const base: FooterLineInput = {
  working: false,
  modelId: "deepseek-v4-flash", // mockup's example model (a constant, not your config)
  provider: "deepseek",
  effort: "high",
  ctxPercent: 0,
  ctxWindow: 1_000_000,
  usage: null,
  cwd: "D:\\Workspace\\00_Mainframe",
  branch: "main",
  showAuto: true,
};

describe("fmtCount", () => {
  it("formats counts by magnitude", () => {
    expect(fmtCount(127)).toBe("127");
    expect(fmtCount(6700)).toBe("6.7k");
    expect(fmtCount(1_000_000)).toBe("1.0M");
    expect(fmtCount(0)).toBe("0");
  });
});

describe("cacheHitPct", () => {
  it("computes cache-hit ratio and matches the mockup", () => {
    expect(cacheHitPct(127, 6700).toFixed(1)).toBe("98.1");
  });
  it("is 0 when both inputs are 0 (no div-by-zero)", () => {
    expect(cacheHitPct(0, 0)).toBe(0);
  });
});

describe("hexFg", () => {
  it("emits a truecolor foreground escape for a hex", () => {
    expect(hexFg("#e0b341", "●")).toBe("\x1b[38;2;224;179;65m●\x1b[39m");
  });
});

describe("buildFooterLine — idle", () => {
  const line = buildFooterLine(stubTheme, base, 100);
  const plain = stripAnsi(line);

  it("matches the mockup idle row (left cluster, from the dot rightward)", () => {
    expect(plain.startsWith("● deepseek-v4-flash • high │ 0.0%/1.0M (auto) │ deepseek")).toBe(true);
  });
  it("pins cwd (branch) hard right", () => {
    expect(plain).toContain("D:\\Workspace\\00_Mainframe (main)");
    expect(plain.endsWith("D:\\Workspace\\00_Mainframe (main)")).toBe(true);
  });
  it("dot is yellow when idle", () => {
    expect(line).toContain(hexFg(DOT_IDLE, "●"));
  });
});

describe("buildFooterLine — working", () => {
  const working: FooterLineInput = {
    ...base,
    working: true,
    usage: { input: 127, output: 97, cacheRead: 6700, cost: 0 },
  };
  const line = buildFooterLine(stubTheme, working, 160); // wide enough that nothing truncates
  const plain = stripAnsi(line);

  it("matches the mockup working row (left cluster, from the dot rightward)", () => {
    expect(plain.startsWith(
      "● deepseek-v4-flash • high │ 0.0%/1.0M (auto) │ ↑127 • ↓97 • R6.7k │ CH98.1% • $0.000 │ deepseek",
    )).toBe(true);
  });
  it("dot is green when working", () => {
    expect(line).toContain(hexFg(DOT_WORKING, "●"));
  });
});

describe("buildFooterLine — (auto) flag", () => {
  it("omits (auto) when the flag is off", () => {
    const plain = stripAnsi(buildFooterLine(stubTheme, { ...base, showAuto: false }, 100));
    expect(plain).toContain("0.0%/1.0M ");
    expect(plain).not.toContain("(auto)");
  });
});

describe("buildFooterLine — narrow-width floor", () => {
  it("truncates the left cluster, never wrapping, keeping cwd pinned (80 cols)", () => {
    const line = buildFooterLine(stubTheme, base, 80);
    const plain = stripAnsi(line);
    expect(plain).not.toContain("\n");
    expect(plain.length).toBeLessThanOrEqual(80);
    expect(plain.endsWith("(main)")).toBe(true);
  });
  it("still keeps cwd at 60 cols", () => {
    const line = buildFooterLine(stubTheme, base, 60);
    const plain = stripAnsi(line);
    expect(plain).not.toContain("\n");
    expect(plain.length).toBeLessThanOrEqual(60);
    expect(plain.endsWith("(main)")).toBe(true);
  });
  it("degenerate: cwd alone wider than width truncates, never wraps", () => {
    const line = buildFooterLine(stubTheme, base, 20);
    const plain = stripAnsi(line);
    expect(plain).not.toContain("\n");
    expect(plain.length).toBeLessThanOrEqual(20);
  });
});

describe("buildFooterLine — no branch", () => {
  it("shows cwd alone when not in a repo", () => {
    const plain = stripAnsi(buildFooterLine(stubTheme, { ...base, branch: null }, 100));
    expect(plain).toContain("D:\\Workspace\\00_Mainframe");
    expect(plain).not.toContain("(main)");
  });
});
