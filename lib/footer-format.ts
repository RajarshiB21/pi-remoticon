import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { rgb } from "./ui-state.js";

export function fmtCount(n: number): string {
  return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}
export interface FooterUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface FooterInput {
  modelId: string; state: string; dot: number[]; ctxPercent: number | null; ctxWindow: number;
  usage: FooterUsage | null; cwd: string; branch: string | null; auto: boolean;
}
const muted = (text: string) => rgb([164, 165, 174], text);
const contextColor = (text: string) => rgb([146, 148, 158], text);
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "");

/** Keep core identity/context visible; discard optional fields before truncating. */
export function buildFooterLines(d: FooterInput, width: number): string[] {
  width = Math.max(0, width);
  const status = muted(d.state);
  const identity = `${rgb(d.dot, "●")} ${rgb([232, 228, 220], d.modelId)}`;
  const room = width - visibleWidth(status) - 1;
  const left = room >= 4 ? fit(identity, room) : identity;
  const first = room >= 4 ? left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(status))) + status : fit(identity + " " + status, width);
  const context = contextColor(`${d.ctxPercent === null ? "?" : `${d.ctxPercent.toFixed(1)}%`}/${fmtCount(d.ctxWindow)} · auto ${d.auto ? "on" : "off"}`);
  const usage = d.usage;
  const tokens = usage ? muted(`↑${fmtCount(usage.input)} ↓${fmtCount(usage.output)} R${fmtCount(usage.cacheRead)} W${fmtCount(usage.cacheWrite)}`) : "";
  const cost = usage ? muted(`$${usage.cost.toFixed(3)}`) : "";
  const directory = muted(d.branch ? `${d.cwd} (${d.branch})` : d.cwd);
  const parts = [context, tokens, cost].filter(Boolean);
  let second = parts.join(" · ");
  if (visibleWidth(second) + visibleWidth(directory) + 2 <= width) {
    second += " ".repeat(width - visibleWidth(second) - visibleWidth(directory)) + directory;
  } else {
    while (visibleWidth(second) > width && parts.length > 1) {
      parts.pop();
      second = parts.join(" · ");
    }
  }
  return [fit(first, width), fit(second, width)];
}
