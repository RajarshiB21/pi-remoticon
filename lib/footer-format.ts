import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { rgb } from "./ui-state.js";
import { posix, win32 } from "node:path";

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
const costText = (cost: number): string => {
  if (!Number.isFinite(cost) || cost < 0) return "";
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  const digits = cost > 0 && cost < 0.01 ? Math.min(4, Math.ceil(-Math.log10(cost))) : 2;
  return `$${cost.toFixed(digits)}`;
};

/** Keep core identity/context visible; discard optional fields before truncating. */
export function buildFooterLines(d: FooterInput, width: number): string[] {
  width = Math.max(0, width);
  const status = muted(d.state);
  const identity = `${rgb(d.dot, "●")} ${rgb([232, 228, 220], d.modelId)}`;
  const room = width - visibleWidth(status) - 1;
  const left = room >= 4 ? fit(identity, room) : identity;
  const first = room >= 4 ? left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(status))) + status : fit(identity + " " + status, width);
  const context = contextColor(`${d.ctxPercent === null ? "?" : `${Number(d.ctxPercent.toFixed(1))}%`} context · auto ${d.auto ? "on" : "off"}`);
  const usage = d.usage;
  const tokens = usage ? muted(`↑${fmtCount(usage.input)} ↓${fmtCount(usage.output)}`) : "";
  const cost = usage ? costText(usage.cost) : "";
  const paths = /^[a-z]:|\\/i.test(d.cwd) ? win32 : posix;
  const root = paths.parse(d.cwd).root;
  const name = paths.normalize(d.cwd) === paths.normalize(root) ? root : paths.basename(d.cwd);
  const directory = muted(d.branch ? `${name} · ${d.branch}` : name);
  const parts = [tokens, cost ? muted(cost) : ""].filter(Boolean);
  const usageLine = () => context + (parts.length ? " / " + parts.join(" ") : "");
  let second = usageLine();
  if (visibleWidth(second) + visibleWidth(directory) + 2 <= width) {
    second += " ".repeat(width - visibleWidth(second) - visibleWidth(directory)) + directory;
  } else {
    while (visibleWidth(second) > width && parts.length) {
      parts.pop();
      second = usageLine();
    }
  }
  return [fit(first, width), fit(second, width)];
}
