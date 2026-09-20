import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createResearchDemandState,
	foreignQueryTokens,
	isResearchSkillLoad,
	provenanceNagText,
	RESEARCH_COMMAND,
	RESEARCH_DEMAND_TEXT,
	researchDemandInjection,
	researchDemandOnInput,
	researchDemandOnToolCall,
	researchDemandOnToolResult,
	searchQueryFromUrl,
} from "../lib/research/reminder.js";

const user = (text: string) => ({ role: "user", content: text });
const fetchTargets = (urls: string[]) => ({ targets: urls.map((url) => ({ url })) });
const SEARCH_BATCH = fetchTargets([
	"https://www.google.com/search?q=jev",
	"https://www.bing.com/search?q=jev",
	"https://duckduckgo.com/?q=jev",
]);
const OWNER_JEV = "jev - a highly accurate, low latency classification model";
const OWNER_FLY = "a fly brain by google";

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
  it("caches owner text as the provenance baseline, command words stripped", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "/skill:research compare jev and inkling");
    expect(state.ownerText).toBe("compare jev and inkling");
  });
  it("keeps the demand's own terms when a later owner message arrives", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "/skill:research compare jev and inkling");
    researchDemandOnInput(state, "and also the Fatima framework");
    researchDemandOnToolCall(state, "fetch", fetchTargets(["https://www.google.com/search?q=inkling"]));
    expect(state.pendingProvenanceFlags).toEqual([]);        // inkling is still the owner's word
    researchDemandOnToolCall(state, "fetch", fetchTargets(["https://www.google.com/search?q=hugging"]));
    expect(state.pendingProvenanceFlags).toEqual(["hugging"]);
  });
  it("drops the previous baseline when a fresh demand starts", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "/skill:research compare jev and inkling");
    researchDemandOnInput(state, "/skill:research now the Fatima framework");
    expect(state.ownerText).toBe("now the Fatima framework");
  });
  it("a fresh invocation clears pending flags", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    state.pendingProvenanceFlags.push("hugging", "face");
    researchDemandOnInput(state, `/skill:research ${OWNER_FLY}`);
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
});

describe("searchQueryFromUrl", () => {
  it("reads the query from all three engines' search URLs", () => {
    expect(searchQueryFromUrl("https://www.google.com/search?q=jev")).toBe("jev");
    expect(searchQueryFromUrl("https://www.bing.com/search?q=inkling+model")).toBe("inkling model");
    expect(searchQueryFromUrl("https://duckduckgo.com/?q=fatima")).toBe("fatima");
  });
  it("is null for non-search pages, non-engines, and malformed URLs", () => {
    expect(searchQueryFromUrl("https://www.google.com/about")).toBeNull();
    expect(searchQueryFromUrl("https://www.bing.com/")).toBeNull();
    expect(searchQueryFromUrl("https://huggingface.co/jinaai/jina-embeddings-v4")).toBeNull();
    expect(searchQueryFromUrl("not a url")).toBeNull();
  });
});

describe("isResearchSkillLoad", () => {
  it("sees a read of the research SKILL.md on windows and posix paths", () => {
    expect(isResearchSkillLoad("read", { path: "D:\\Workspace\\01_Active\\pi-remoticon\\skills\\research\\SKILL.md" })).toBe(true);
    expect(isResearchSkillLoad("read", { path: "/home/dev/pi-remoticon/skills/research/SKILL.md" })).toBe(true);
  });
  it("sees a bash command naming the skill file and a skill tool invocation", () => {
    expect(isResearchSkillLoad("bash", { command: "cat .\\skills\\research\\SKILL.md" })).toBe(true);
    expect(isResearchSkillLoad("skill", { name: "research" })).toBe(true);
  });
  it("ignores other reads, other skills, and edits of the skill file", () => {
    expect(isResearchSkillLoad("read", { path: "D:\\Workspace\\00_Mainframe\\AGENTS.md" })).toBe(false);
    expect(isResearchSkillLoad("skill", { name: "research-notes" })).toBe(false);
    expect(isResearchSkillLoad("edit", { path: ".\\skills\\research\\SKILL.md" })).toBe(false);
  });
});

describe("researchDemandOnToolCall", () => {
  it("arms when the model loads the research skill itself", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, "help me with this repo");
    researchDemandOnToolCall(state, "read", { path: "D:\\Workspace\\01_Active\\pi-remoticon\\skills\\research\\SKILL.md" });
    expect(state.armed).toBe(true);
  });
  it("clears pending flags when the model-path invocation starts a fresh demand", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets(["https://www.google.com/search?q=jev+hugging"]));
    researchDemandOnToolResult(state, "fetch", fetchTargets(["https://www.google.com/search?q=jev+hugging"]));
    researchDemandOnToolResult(state, "fetch", SEARCH_BATCH);   // a clean search serves it; flags still pending
    expect(state.armed).toBe(false);
    researchDemandOnToolCall(state, "read", { path: "D:\\Workspace\\01_Active\\pi-remoticon\\skills\\research\\SKILL.md" });
    expect(state.armed).toBe(true);
    expect(state.pendingProvenanceFlags).toEqual([]);           // stale flags never bleed into a fresh demand
  });
  it("flags query words no owner message contains (the audit's hugging-face fixture)", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=jev+model+low+latency+classification+hugging+face",
    ]));
    expect(state.pendingProvenanceFlags).toEqual(["hugging", "face"]);
  });
  it("flags era vocabulary (the audit's FlyWire fixture)", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_FLY}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.bing.com/search?q=Google+fly+brain+connectome+FlyWire+applications",
    ]));
    expect(state.pendingProvenanceFlags).toEqual(["connectome", "flywire", "applications"]);
  });
  it("passes queries built from the owner's literal terms", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    researchDemandOnToolCall(state, "fetch", SEARCH_BATCH);
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
  it("passes generic modifiers and years", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_FLY}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://duckduckgo.com/?q=google+fly+brain+latest+2026",
    ]));
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
  it("multi-word owner phrases permit recombined queries", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, '/skill:research have you seen the "System One" models');
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=system+one+models+release",
    ]));
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
  it("provenance window is closed while unarmed", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, OWNER_JEV);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=jev+hugging+face",
    ]));
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
  it("records nothing when no owner text exists yet", () => {
    const state = createResearchDemandState();
    state.armed = true;
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=jev+hugging+face",
    ]));
    expect(state.pendingProvenanceFlags).toEqual([]);
  });
});

describe("foreignQueryTokens", () => {
  it("returns owner-absent tokens outside the generic allowlist", () => {
    expect(foreignQueryTokens(OWNER_JEV, "jev model low latency classification hugging face")).toEqual(["hugging", "face"]);
  });
  it("returns empty with a null baseline", () => {
    expect(foreignQueryTokens(null, "anything at all")).toEqual([]);
  });
  it("returns empty when the owner message carries no terms of its own (bare command)", () => {
    expect(foreignQueryTokens("", "jev hugging face")).toEqual([]);
  });
});

describe("researchDemandOnToolResult", () => {
  it("a plain fetch does not serve the demand", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    researchDemandOnToolResult(state, "fetch", fetchTargets(["https://huggingface.co/jinaai/jina-embeddings-v4"]));
    expect(state.armed).toBe(true);
  });
  it("a search on any one engine serves the demand", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    researchDemandOnToolResult(state, "fetch", fetchTargets(["https://www.bing.com/search?q=jev"]));
    expect(state.armed).toBe(false);
  });
  it("a failed search result does not serve the demand", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    researchDemandOnToolResult(state, "fetch", fetchTargets(["https://www.bing.com/search?q=jev"]), true);
    expect(state.armed).toBe(true);
  });
  it("ignores non-fetch tools", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    researchDemandOnToolResult(state, "bash", { command: "echo hi" });
    expect(state.armed).toBe(true);
  });
});

describe("researchDemandInjection", () => {
  it("stays silent while nothing is armed, however long the ask runs", () => {
    const state = createResearchDemandState();
    expect(researchDemandInjection(state, [user("what's the latest state of the repo")])).toBeNull();
  });
  it("injects the nag once armed, until a search runs", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    const ask = [user("/skill:research the new release notes")];
    expect(researchDemandInjection(state, ask)).toBe(RESEARCH_DEMAND_TEXT);
    researchDemandOnToolResult(state, "fetch", fetchTargets(["https://example.com/some-docs"]));
    expect(researchDemandInjection(state, ask)).toBe(RESEARCH_DEMAND_TEXT);   // plain fetch did not serve it
    researchDemandOnToolResult(state, "fetch", SEARCH_BATCH);
    expect(researchDemandInjection(state, ask)).toBeNull();                   // search served it
  });
  it("re-arms on each invocation and disarms on each search", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    const ask = [user("/skill:research this")];
    expect(researchDemandInjection(state, ask)).not.toBeNull();
    researchDemandOnToolResult(state, "fetch", SEARCH_BATCH);
    expect(researchDemandInjection(state, ask)).toBeNull();
    researchDemandOnInput(state, "/skill:research this again");
    expect(researchDemandInjection(state, ask)).not.toBeNull();
  });
  it("names foreign tokens once and keeps the demand armed until a clean search (the audit scenario)", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=jev+model+hugging+face",
    ]));
    researchDemandOnToolResult(state, "fetch", fetchTargets([
      "https://www.google.com/search?q=jev+model+hugging+face",
    ])); // a contaminated search does not serve the demand
    const ask = [user(`/skill:research ${OWNER_JEV}`)];
    const nag = researchDemandInjection(state, ask);
    expect(nag).toContain("hugging, face");
    expect(nag).toContain("literal terms");
    expect(nag).toContain(RESEARCH_DEMAND_TEXT);                              // measured against the demand too
    expect(state.armed).toBe(true);                                           // the pressure persists
    expect(researchDemandInjection(state, ask)).toBe(RESEARCH_DEMAND_TEXT);   // flags consumed once, demand stays
    researchDemandOnToolCall(state, "fetch", SEARCH_BATCH);
    researchDemandOnToolResult(state, "fetch", SEARCH_BATCH);
    expect(researchDemandInjection(state, ask)).toBeNull();                   // the owner's own terms served it
  });
  it("combines the provenance nag with the demand while still armed", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, `/skill:research ${OWNER_JEV}`);
    researchDemandOnToolCall(state, "fetch", fetchTargets([
      "https://www.bing.com/search?q=jev+nvidia",
    ]));
    const injection = researchDemandInjection(state, [user(`/skill:research ${OWNER_JEV}`)]);
    expect(injection).toContain("nvidia");
    expect(injection).toContain(RESEARCH_DEMAND_TEXT);
  });
  it("defers to the distress hail mary and holds flags for afterwards", () => {
    const state = createResearchDemandState();
    researchDemandOnInput(state, RESEARCH_COMMAND);
    state.pendingProvenanceFlags.push("hugging");
    expect(researchDemandInjection(state, [user("i am in distress, /skill:research this")])).toBeNull();
    expect(researchDemandInjection(state, [user("ok, continue the search")])).toContain("hugging");
    expect(state.pendingProvenanceFlags).toEqual([]);                          // consumed once emitted
  });
});

describe("provenanceNagText", () => {
  it("wraps the tokens in a reminder naming the rule", () => {
    const text = provenanceNagText(["flywire"]);
    expect(text).toMatch(/^<system-reminder>/);
    expect(text).toContain("flywire");
    expect(text).toContain("owner's literal terms");
  });
});
