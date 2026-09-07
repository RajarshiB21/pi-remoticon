// S1 — Static + Unit lane for the remoticon theme.
//   Static:  the theme JSON parses, and defines every token pi requires (pi
//            refuses to load a theme missing a required token).
//   Unit:    the nine editor-border tokens all resolve to the one static tan
//            #d99a5c — guards against a future edit reintroducing a per-level
//            color. No pi boot, no termless (that's the Integration lane).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const theme = JSON.parse(readFileSync(join(repoRoot, "themes", "remoticon.json"), "utf8"));

// The token contract, read from pi's own installed schema so this test can never
// drift from pi's real requirement. `colors.required` is the authoritative
// must-define list (optional fallback tokens are deliberately not in it).
const schema = JSON.parse(
  readFileSync(
    join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "theme-schema.json"),
    "utf8"
  )
);
const requiredTokens: string[] = schema.properties.colors.required;

// Resolve a color value one hop through `vars` (theme values are either a literal
// like "#d99a5c" or a var name like "composer"). One hop is all pi's dark theme
// and ours use; a var pointing at another var would need a loop, which we don't.
const resolve = (v: string): string => (theme.vars && v in theme.vars ? theme.vars[v] : v);

const TAN = "#d99a5c";
const staticBorderTokens = [
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
  "borderMuted",
];

describe("S1: remoticon theme", () => {
  it("defines every token pi requires", () => {
    for (const token of requiredTokens) {
      expect(theme.colors[token], `missing required token: ${token}`).toBeDefined();
    }
  });

  it("sets all nine editor-border tokens to the one static tan", () => {
    for (const token of staticBorderTokens) {
      expect(resolve(theme.colors[token]), `${token} is not the static composer tan`).toBe(TAN);
    }
  });

  it("keeps the tan in one place (a single var), so it swaps by editing one line", () => {
    expect(theme.vars.composer).toBe(TAN);
    for (const token of staticBorderTokens) {
      expect(theme.colors[token]).toBe("composer");
    }
  });
});

// S1 — the calm-UI colour map. Hexes are the appearance authority (mockup.html /
// INTENT palette), not the spec's prose (which has a known dim typo). Each token
// is resolved one hop through vars.
describe("S1: calm-UI colour map", () => {
  const BG = "#1b1b1b";

  it("kills the box — all three tool bg tokens resolve to the terminal ground", () => {
    for (const token of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
      expect(resolve(theme.colors[token]), `${token} is not the terminal ground`).toBe(BG);
    }
  });

  it("sets the locked colour-role hexes", () => {
    const expected: Record<string, string> = {
      text: "#d6d6d6",
      muted: "#8a8a8a",
      dim: "#6f6f6f", // mockup.html + INTENT; spec's #6f8a8a is a typo
      error: "#e5695f",
      success: "#5bc46b",
      userMessageBg: "#3a3a46",
      userMessageText: "#e8e8ea",
      toolDiffAdded: "#8fe0a6",
      toolDiffRemoved: "#e59b95",
    };
    for (const [token, hex] of Object.entries(expected)) {
      expect(resolve(theme.colors[token]), `${token}`).toBe(hex);
    }
  });

  it("holds the command/flag blues as values (S2's renderer consumes them; pi has no flag token)", () => {
    expect(theme.vars.cmdBlue).toBe("#6ea8fe");
    expect(theme.vars.flagBlue).toBe("#a9c9fb");
  });

  it("keeps blue OFF markdown — accent (mdCode/mdListBullet) stays teal, per INTENT 'blue = commands only'", () => {
    expect(resolve(theme.colors.accent)).toBe("#8abeb7");
    expect(theme.colors.mdCode).toBe("accent");
    expect(theme.colors.mdListBullet).toBe("accent");
  });
});
