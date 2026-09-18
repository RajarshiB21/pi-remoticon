import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createResearchDemandState,
	RESEARCH_COMMAND,
	RESEARCH_DEMAND_TEXT,
	researchDemandInjection,
	researchDemandOnInput,
	researchDemandOnToolResult,
} from "../lib/research/reminder.js";

const user = (text: string) => ({ role: "user", content: text });

describe("the research skill", () => {
  it("ships with valid frontmatter so pi discovers the /skill:research command", () => {
    const body = readFileSync(join(import.meta.dirname, "..", "skills", "research", "SKILL.md"), "utf8");
    expect(body).toMatch(/^---\nname: research\n/);
    expect(body).toMatch(/description: .+\n/);
    expect(body).toContain("research flow");
  });
});

describe("researchDemandOnInput", () => {
  it("arms on the bare command and with arguments, case-insensitively", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "/skill:research");
    expect(state.armed).toBe(true);
    const uppercaseState = createResearchDemandState();
    researchDemandOnInput(uppercaseState, "   /SKILL:RESEARCH latest release notes  ");
    expect(uppercaseState.armed).toBe(true);
  });
  it("stays silent on ordinary asks, even the words that used to trip the old guard", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "what's the latest state of the repo");
    researchDemandOnInput(state, "any news on the build");
    researchDemandOnInput(state, "search the repo for the failing test");
    expect(state.armed).toBe(false);
  });
  it("does not arm on other skill commands", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "/skill:research-notes");
    expect(state.armed).toBe(false);
  });
});

describe("researchDemandInjection", () => {
  it("stays silent while nothing is armed, however long the ask runs", () => {
    const state = createResearchDemandState();
    expect(researchDemandInjection(state, [user("what's the latest state of the repo")])).toBeNull();
  });
  it("injects the nag once armed, and keeps injecting until a fetch runs", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    const ask = [user("/skill:research the new release notes")];
    expect(researchDemandInjection(state, ask)).toBe(RESEARCH_DEMAND_TEXT);
    expect(researchDemandInjection(state, ask)).toBe(RESEARCH_DEMAND_TEXT);   // no fetch yet
    researchDemandOnToolResult(state, "fetch");
    expect(researchDemandInjection(state, ask)).toBeNull();                   // served
  });
  it("re-arms on each invocation and disarms on each fetch", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    const ask = [user("/skill:research this")];
    expect(researchDemandInjection(state, ask)).not.toBeNull();
    researchDemandOnToolResult(state, "fetch");
    expect(researchDemandInjection(state, ask)).toBeNull();       // served
    researchDemandOnInput(state, "/skill:research this again");
    expect(researchDemandInjection(state, ask)).not.toBeNull();   // a new demand nags again
  });
  it("defers to the distress hail mary", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    expect(researchDemandInjection(state, [user("i am in distress, /skill:research this")])).toBeNull();
  });
});
