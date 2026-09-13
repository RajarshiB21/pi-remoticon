/**
 * Collapsed-group strings for the fetch tool (design D5, 2026-09-13).
 * The patched runtime shows these verbatim on the group line, so they are
 * plain text: no ANSI, no control characters, recomputed on every update.
 */
import type { PageRecord } from "./protocol.js";

export const CANCELLED_SUMMARY = "Fetch cancelled";

export function runningSummary(targetCount: number): string {
  return `Fetching ${targetCount} page${targetCount === 1 ? "" : "s"}…`;
}

export function settledSummary(pages: readonly PageRecord[]): string {
  const dead = pages.filter((page) => !page.usable && page.error === null && !page.cancelled).length;
  const failed = pages.filter((page) => !page.usable && page.error !== null).length;
  const parts = [`Fetched ${pages.length} page${pages.length === 1 ? "" : "s"}`];
  if (dead > 0) parts.push(`${dead} dead end${dead === 1 ? "" : "s"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}
