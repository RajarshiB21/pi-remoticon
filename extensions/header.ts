// S2 — Custom startup header.
//
// The three loaded-resources blocks ([Context]/[Skills]/[Extensions]) are pi's
// built-in listing, not the header component and not extension output, with no
// per-block hide. The only switch is `quietStartup` — and it is all-or-nothing:
// setting it true removes pi's ENTIRE built-in header (logo, hints, intro) AND
// the listing (verified by booting pi with quietStartup:true — nothing but the
// composer + footer paints). So the product is `quietStartup: true` (a user
// setting) + this extension, which rebuilds only the lines the mockup keeps.
//
// The `Ponytail loaded: full` line is NOT rebuilt here: it is a ctx.ui.notify
// toast emitted by the ponytail package's own extension, independent of the
// header, so it already appears on its own.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { buildHeaderLines } from "./header-lines.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number): string[] {
          return buildHeaderLines(theme, VERSION);
        },
        invalidate() {},
      }));
    }
  });
}
