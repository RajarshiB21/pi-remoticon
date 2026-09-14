/**
 * Collapsed-group strings for the fetch tool, and the one duration formatter
 * this tool prints. The patched runtime shows these strings verbatim on the
 * group line, so they are plain text: no ANSI, no control characters, and they
 * are recomputed on every update.
 */
import type { PageRecord } from "./protocol.js";

/** Meter cells (spec §5.2). One cell per page, whole cells only. */
export const FILLED = "█";
export const EMPTY = "▁";

/** One unit rule for every duration this tool prints (spec §5.3). */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Cells equal the page count; filled cells equal settled pages. */
export function meter(total: number, settled: number): string {
  const filled = Math.max(0, Math.min(settled, total));
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, total - filled));
}

/** Running form. No clock: this string cannot update on its own (spec §4.2). */
export function runningSummary(total: number, settled: number): string {
  if (total <= 1) return "Fetching 1 page";
  return `Fetch ${total} pages ${meter(total, settled)} ${settled} of ${total} settled`;
}

/** Settled form. The duration is final here, so it is stated (spec §4.2). */
export function settledSummary(pages: readonly PageRecord[], durationMs: number | null): string {
  const dead = pages.filter((page) => !page.usable && page.error === null && !page.cancelled).length;
  const failed = pages.filter((page) => !page.usable && page.error !== null).length;
  const parts = [`Fetched ${pages.length} page${pages.length === 1 ? "" : "s"}`];
  if (dead > 0) parts.push(`${dead} dead end${dead === 1 ? "" : "s"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (durationMs !== null) parts.push(formatDuration(durationMs));
  return parts.join(" · ");
}

/** Cancelled form. A cancelled batch's duration is final too. */
export function cancelledSummary(durationMs: number | null): string {
  return durationMs === null ? "Fetch cancelled" : `Fetch cancelled after ${formatDuration(durationMs)}`;
}
