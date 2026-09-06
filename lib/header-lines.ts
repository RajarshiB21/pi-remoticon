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
export function buildHeaderLines(theme: Theme, version: string): string[] {
  return [
    theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${version}`),
    theme.fg("dim", "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more"),
    theme.fg("dim", "Press ctrl+o to show full startup help and loaded resources."),
    "",
    theme.fg("dim", "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi."),
  ];
}
