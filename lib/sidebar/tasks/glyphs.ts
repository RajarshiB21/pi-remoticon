// Glyph data and safety, adapted from https://github.com/tintinweb/pi-tasks
// (MIT, (c) 2026 tintinweb) src/task-glyphs.ts. Deltas: the defaults are the
// owner's approved set; only the five fields the panel reads exist.
import { visibleWidth } from "@earendil-works/pi-tui";
export interface SlotGlyphs {
  pending: string;
  completed: string;
  spinner: readonly string[];
  summary: string;
  truncation: string;
}
export const DEFAULT_GLYPHS: SlotGlyphs = {
  pending: "\u25CB", completed: "\u25CF", spinner: ["\u2733", "\u273D"], summary: "\u2714", truncation: "...",
};
const UNSAFE_GLYPH = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
/** Present, printable, and not a bidi override. */
const isSafeText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !UNSAFE_GLYPH.test(v);
/** A column glyph must occupy exactly the one cell the row layout reserves for it. A two-cell
 *  or two-character value ("XX", a double-width emoji) would push the row past its fixed
 *  width. The truncation marker is not a column glyph and is allowed to be wider. */
const isGlyph = (v: unknown): v is string => isSafeText(v) && visibleWidth(v) === 1;
/** A spinner needs at least two frames: half a frame sequence is not an animation. */
const isSpinner = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 2 && v.every(isGlyph);

export function resolveGlyphs(config: unknown): SlotGlyphs {
  const c = (config ?? {}) as Record<string, unknown>;
  const g = (v: unknown, fallback: string) => isGlyph(v) ? v : fallback;
  const text = (v: unknown, fallback: string) => isSafeText(v) ? v : fallback;
  return {
    pending: g(c.pending, DEFAULT_GLYPHS.pending),
    completed: g(c.completed, DEFAULT_GLYPHS.completed),
    spinner: isSpinner(c.spinner) ? c.spinner : DEFAULT_GLYPHS.spinner,
    summary: g(c.summary, DEFAULT_GLYPHS.summary),
    truncation: text(c.truncation, DEFAULT_GLYPHS.truncation),
  };
}
