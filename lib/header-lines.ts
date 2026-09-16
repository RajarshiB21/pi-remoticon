// Pure header-line builder — no runtime import of the pi package (only a
// type-only import, which is erased), so the Unit lane can import and test it
// without loading pi's full runtime. The extension (header.ts) wires it to
// ctx.ui.setHeader and pi's VERSION.
import type { Theme } from "@earendil-works/pi-coding-agent";

// The kept startup lines, in the mockup's order: logo, keybinding hints, the
// ctrl+o help line, a blank line, then the intro. The three text lines render in
// `dim` per the mockup's visual contract.
//
// ponytail: the keybinding text (escape / ctrl+c / ctrl+d / ctrl+o) is hardcoded
// to pi's defaults — it goes stale if the user rebinds those keys. Re-source it
// from pi's keybindings manager if that ever matters.
//
// D7: with the sidebar on, the main column narrows and pi truncates over-wide
// lines, which used to cut off the two long lines' tails. The two long strings
// wrap to the width the caller passes in; the short ones already fit.
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out;
}

export function buildHeaderLines(theme: Theme, version: string, width: number): string[] {
  return [
    theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${version}`),
    ...wrapText("escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more", width).map(l => theme.fg("dim", l)),
    theme.fg("dim", "Press ctrl+o to show full startup help and loaded resources."),
    "",
    ...wrapText("Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.", width).map(l => theme.fg("dim", l)),
  ];
}
