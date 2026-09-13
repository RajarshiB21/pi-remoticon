import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateResearchTools, FETCH_PARAMS } from "../lib/research/tool.js";

describe("fetch tool registration", () => {
  it("keeps the schema bounds the model sees", () => {
    expect(Value.Check(FETCH_PARAMS, { targets: [{ url: "https://example.com/" }] })).toBe(true);
    expect(Value.Check(FETCH_PARAMS, { targets: [] })).toBe(false);
    expect(Value.Check(FETCH_PARAMS, { targets: Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}` })) })).toBe(false);
    expect(Value.Check(FETCH_PARAMS, {
      targets: [{ url: "https://example.com/" }],
      blockedDomains: Array.from({ length: 33 }, (_, i) => `d${i}.example.com`),
    })).toBe(false);
  });

  it("adds fetch to the active set once", () => {
    let active = ["read", "bash"];
    const pi = {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI;
    activateResearchTools(pi);
    activateResearchTools(pi);
    expect(active).toEqual(["read", "bash", "fetch"]);
  });
});
