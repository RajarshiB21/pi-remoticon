// Pure footer-line builder — type-only pi import (erased), so the Unit lane can
// import and test it without pi's runtime. extensions/footer.ts wires it to
// ctx.ui.setFooter and reads the live data off ctx/footerData.
//
// The footer is one line: a left cluster that grows left->right as data arrives,
// and `cwd (branch)` pinned hard right (mockup.html, idle row ~102 / working
// row ~114). The leftmost glyph is the agent-state dot.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// Dot state colors — locked in INTENT.md:88-89. Off-palette (the theme's
// warning=#ffff00 / success=#b5bd68 don't match), so the dot is emitted as a
// raw truecolor escape rather than a theme token; every other footer color is a
// theme token.
export const DOT_IDLE = "#e0b341"; // yellow, idle
export const DOT_WORKING = "#6cc04a"; // green, working

// Wrap text in a truecolor foreground SGR escape.
// ponytail: assumes a truecolor terminal (pinned in the test harness; real pi
// detects it, same as the composer border). In a 256-color terminal this is not
// downgraded — if that ever matters, fall back to theme warning/success tokens.
export function hexFg(hex: string, text: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[39m`;
}

// 127 -> "127", 6700 -> "6.7k", 1_000_000 -> "1.0M".
export function fmtCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Cache-hit % = cacheRead / (input + cacheRead) * 100; 0 when both are 0
// (guards div-by-zero). Verified vs mockup: 6700/(127+6700) = 98.1%.
export function cacheHitPct(input: number, cacheRead: number): number {
  const denom = input + cacheRead;
  return denom === 0 ? 0 : (cacheRead / denom) * 100;
}

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export interface FooterData {
  working: boolean;
  modelId: string;
  provider: string;
  effort: string;
  ctxPercent: number; // null coerced to 0 by the caller (frame-zero has no usage yet)
  ctxWindow: number;
  usage: FooterUsage | null; // null = idle (no working clusters)
  cwd: string;
  branch: string | null;
  showAuto: boolean; // v1 always true; the one flag INTENT reserves to us
}

// Build the single footer line, sized to `width`. Right side (`cwd (branch)`) is
// pinned hard right; when the two sides collide the LEFT cluster is truncated so
// the cwd stays put (never wrap, never push cwd off-screen — the S3 floor).
export function buildFooterLine(theme: Theme, d: FooterData, width: number): string {
  const dim = (t: string) => theme.fg("dim", t);
  const muted = (t: string) => theme.fg("muted", t);
  const dot = hexFg(d.working ? DOT_WORKING : DOT_IDLE, "●");

  const context = `${d.ctxPercent.toFixed(1)}%/${fmtCount(d.ctxWindow)}${d.showAuto ? " (auto)" : ""}`;

  // Left groups, joined by " │ ". The state dot leads the first group.
  const groups: string[] = [
    `${dot} ${muted(d.modelId)}${dim(" • ")}${muted(d.effort)}`,
    dim(context),
  ];
  if (d.usage) {
    groups.push(dim(`↑${fmtCount(d.usage.input)} • ↓${fmtCount(d.usage.output)} • R${fmtCount(d.usage.cacheRead)}`));
    groups.push(dim(`CH${cacheHitPct(d.usage.input, d.usage.cacheRead).toFixed(1)}% • $${d.usage.cost.toFixed(3)}`));
  }
  groups.push(dim(d.provider));
  const left = groups.join(dim(" │ "));

  const right = dim(d.branch ? `${d.cwd} (${d.branch})` : d.cwd);

  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  const gap = width - lw - rw;
  if (gap >= 1) return left + " ".repeat(gap) + right;

  // Collision: keep the right pinned, truncate the left (empty ellipsis — pi-tui
  // defaults to "..."). One space between the truncated left and the cwd.
  const avail = width - rw - 1;
  if (avail <= 0) {
    // Degenerate: the right side alone overflows — truncate it so we never wrap.
    return truncateToWidth(right, width, "");
  }
  return truncateToWidth(left, avail, "") + " " + right;
}
