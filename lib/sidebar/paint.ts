// Theme-role painting and box drawing for the sidebar column.
// Adapted from https://github.com/mkaz/pi-mkaz-sidebar (MIT, (c) 2026 Michael Kazmierczak):
// the role-paint model of src/palette.ts and the dock/box drawing of src/sidebar.ts.
// No color value is stored here: every element paints by theme role at render time.
import { visibleWidth } from "@earendil-works/pi-tui";

export type Role = "text" | "dim" | "muted" | "accent" | "success" | "customMessageLabel" | "warning" | "error";
export interface ThemeLike { fg(role: string, text: string): string; bold(text: string): string; }

export interface Painter {
  fg(role: Role, text: string): string;
  bold(text: string): string;
}

/** theme.fg throws on an unknown role; fall back to `text` and report once per role. */
export function makePainter(theme: ThemeLike, onUnknownRole?: (role: string) => void): Painter {
  const warned = new Set<string>();
  return {
    fg(role, text) {
      try { return theme.fg(role, text); }
      catch {
        if (!warned.has(role)) { warned.add(role); onUnknownRole?.(role); }
        return theme.fg("text", text);
      }
    },
    bold: text => theme.bold(text),
  };
}

export const GLYPHS = { v: "\u2502", tl: "\u256D", tr: "\u256E", bl: "\u2570", br: "\u256F", h: "\u2500" } as const;

/** Clip PLAIN text (never colored strings) to width with a trailing marker.
 *  Slices by code point so a surrogate pair is never split. */
export function clip(text: string, width: number, marker = "..."): string {
  if (visibleWidth(text) <= width) return text;
  const keep = Math.max(1, width - visibleWidth(marker));
  return Array.from(text).slice(0, keep).join("") + marker;
}
const padTo = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** One sidebar row: dim dock glyph + one space + content padded to the column width. */
export function dockLine(p: Painter, content: string, width: number): string {
  return p.fg("dim", GLYPHS.v) + " " + padTo(content, width - 2);
}
export function boxTop(p: Painter, title: string, boxWidth: number): string {
  const crown = `${GLYPHS.tl}${GLYPHS.h} `;
  const fill = boxWidth - visibleWidth(crown) - visibleWidth(title) - 2;
  return p.fg("accent", crown) + p.bold(p.fg("accent", title)) + p.fg("accent", ` ${GLYPHS.h.repeat(Math.max(0, fill))}${GLYPHS.tr}`);
}
export function boxRow(p: Painter, inner: string, boxWidth: number): string {
  const w = boxWidth - 4;
  const safe = visibleWidth(inner) > w ? inner.slice(0, w) : inner;   // over-wide is a caller bug; keep the frame straight
  return p.fg("dim", GLYPHS.v) + " " + padTo(safe, w) + " " + p.fg("dim", GLYPHS.v);
}
export function boxBottom(p: Painter, boxWidth: number): string {
  return p.fg("dim", `${GLYPHS.bl}${GLYPHS.h.repeat(Math.max(0, boxWidth - 2))}${GLYPHS.br}`);
}
