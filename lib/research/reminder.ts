/**
 * Research demand (v6, workspace spec 00_Mainframe docs/superpowers/specs/
 * 2026-09-20-research-first-mile.md): the owner invokes research with
 * `/skill:research` or the model loads the research SKILL.md itself; both
 * arm the demand. The context hook injects the nag until a real search
 * engine fetch built from the owner's terms disarms it, so neither a
 * memory-planned direct fetch nor a search on memory vocabulary counts.
 * While armed, search queries whose tokens appear in no owner
 * message are flagged; the next injection names the foreign vocabulary and
 * demands the owner's literal terms. The distress hail mary outranks every
 * injection.
 */

import { matchesDistress } from "../distress/hailmary.js";
import { latestHumanMessage, messageText, type HumanMessageLike } from "../injects/scan.js";

/** The chat command the owner types; the input event sees it raw, before
 * pi expands the skill. */
export const RESEARCH_COMMAND = "/skill:research";

export const RESEARCH_DEMAND_TEXT = [
	"<system-reminder>",
	"The owner invoked research for this turn and no search has run yet. Run the research flow now: a concurrent search batch per unknown (google.com/search, bing.com/search, duckduckgo.com for the owner's literal term, at most two unknowns per fetch call), then fetch two to four result URLs plainly and follow the trails. Use the owner's literal terms as the queries; an unrecognized name is a search, not a guess, and no conclusion forms before the first batch returns. This repeats until a search built from the owner's terms has run.",
	"</system-reminder>",
].join("\n");

/** The nag naming query words no owner message contains. */
export function provenanceNagText(flags: readonly string[]): string {
	return [
		"<system-reminder>",
		`Your search query used words that appear in no owner message: ${flags.join(", ")}. While research is armed, the queries are the owner's literal terms; memory vocabulary is not a search term. Re-issue the batch with the owner's words.`,
		"</system-reminder>",
	].join("\n");
}

export interface ResearchDemandState {
	/** True once research was invoked and no search has run since. */
	armed: boolean;
	/** Latest owner text seen on an input event; the provenance baseline.
	 * While the demand is active it accumulates every owner message. */
	ownerText: string | null;
	/** Query tokens memory supplied, waiting to be named in one injection. */
	pendingProvenanceFlags: string[];
}

export function createResearchDemandState(): ResearchDemandState {
	return { armed: false, ownerText: null, pendingProvenanceFlags: [] };
}

/** The raw user input, as the pi input event delivers it. Arms the demand
 * when the owner typed the research command (a fresh invocation starts
 * clean) and adds every later owner message to the baseline while the demand
 * is active, so a follow-up never turns the demand's own words into foreign
 * vocabulary. */
export function researchDemandOnInput(state: ResearchDemandState, text: string): void {
	const trimmed = text.trim();
	const lowered = trimmed.toLowerCase();
	const isCommand = lowered === RESEARCH_COMMAND || lowered.startsWith(`${RESEARCH_COMMAND} `);
	// The command words are not owner vocabulary for provenance purposes.
	const ownerPart = trimmed.replace(/^\/skill:research\b/i, "").trim();
	if (isCommand) {
		state.armed = true;
		state.pendingProvenanceFlags = [];
		state.ownerText = ownerPart;
		return;
	}
	state.ownerText = state.armed && state.ownerText ? `${state.ownerText} ${ownerPart}` : ownerPart;
}

/** Decoded query when url is a google, bing or duckduckgo search URL,
 * else null. */
export function searchQueryFromUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	const isEngine =
		((host === "google.com" || host === "www.google.com") && parsed.pathname.startsWith("/search")) ||
		((host === "bing.com" || host === "www.bing.com") && parsed.pathname.startsWith("/search")) ||
		((host === "duckduckgo.com" || host === "www.duckduckgo.com") && (parsed.pathname === "/" || parsed.pathname === ""));
	if (!isEngine) return null;
	return parsed.searchParams.get("q");
}

/** Words so generic they steer no neighborhood; years steer time, not
 * identity. Everything else in a query must be an owner word while the
 * demand is armed. */
const GENERIC_MODIFIERS = new Set([
	"latest", "current", "new", "news", "how", "what", "why", "vs",
	"review", "reviews", "guide", "tutorial", "release", "released",
	"update", "updated", "2024", "2025", "2026", "2027",
]);

function tokenSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length >= 2),
	);
}

/** Query tokens present in no owner message: vocabulary memory supplied.
 * An owner message with no terms of its own (a bare command) leaves nothing
 * to compare against, so provenance stays off rather than flagging every
 * word of a legitimate query. */
export function foreignQueryTokens(ownerText: string | null, query: string): string[] {
	if (ownerText === null) return [];
	const owner = tokenSet(ownerText);
	if (owner.size === 0) return [];
	return [...tokenSet(query)].filter((token) => !GENERIC_MODIFIERS.has(token) && !owner.has(token));
}

// Any path ending research/SKILL.md is treated as the research skill; a
// collision with another skill of that name is accepted (spec, open
// assumptions).
const SKILL_PATH_END = /research[\\/]skill\.md$/i;
const SKILL_PATH_ANYWHERE = /research[\\/]skill\.md/i;

/** True when a tool call is the model loading the research skill: a read
 * of its SKILL.md, a bash command naming that path, or a skill tool named
 * research on harnesses that expose one. */
export function isResearchSkillLoad(toolName: string, input: unknown): boolean {
	if (toolName === "read") {
		const path = (input as { path?: unknown } | null)?.path;
		return typeof path === "string" && SKILL_PATH_END.test(path);
	}
	if (toolName === "bash") {
		const command = (input as { command?: unknown } | null)?.command;
		return typeof command === "string" && SKILL_PATH_ANYWHERE.test(command);
	}
	if (toolName === "skill") {
		return (input as { name?: unknown } | null)?.name === "research";
	}
	return false;
}

/** Tool calls observed: the model loading the research skill arms the
 * demand; a fetch whose search queries carry non-owner words is flagged
 * for the next injection. */
export function researchDemandOnToolCall(state: ResearchDemandState, toolName: string, input: unknown): void {
	if (!state.armed && isResearchSkillLoad(toolName, input)) {
		state.armed = true;
		state.pendingProvenanceFlags = [];
	}
	if (!state.armed || toolName !== "fetch") return;
	const targets = (input as { targets?: Array<{ url?: unknown }> } | null)?.targets ?? [];
	for (const target of targets) {
		if (typeof target.url !== "string") continue;
		const query = searchQueryFromUrl(target.url);
		if (query === null) continue;
		state.pendingProvenanceFlags.push(...foreignQueryTokens(state.ownerText, query));
	}
	state.pendingProvenanceFlags = [...new Set(state.pendingProvenanceFlags)];
}

/** A completed fetch serves the demand only when it ran a search built from
 * the owner's terms. A search carrying memory vocabulary leaves the demand
 * armed (spec Decisions: the offending fetch does not serve the demand), and
 * so does a fetch that errored, because no search completed. */
export function researchDemandOnToolResult(
	state: ResearchDemandState,
	toolName: string,
	input: unknown,
	isError = false,
): void {
	if (toolName !== "fetch" || isError) return;
	const targets = (input as { targets?: Array<{ url?: unknown }> } | null)?.targets ?? [];
	const queries = targets
		.map((target) => (typeof target.url === "string" ? searchQueryFromUrl(target.url) : null))
		.filter((query): query is string => query !== null);
	const contaminated = queries.some((query) => foreignQueryTokens(state.ownerText, query).length > 0);
	if (queries.length > 0 && !contaminated) state.armed = false;
}

/**
 * The nag to append on this model call, or null. Null while nothing is
 * armed, no provenance flags are pending, or the latest human message
 * states distress (flags are held, not dropped, so the nag lands after
 * the distress passes). Pending flags are consumed when emitted, so a
 * contaminated batch is named exactly once.
 */
export function researchDemandInjection(
	state: ResearchDemandState,
	messages: readonly HumanMessageLike[],
): string | null {
	const latest = latestHumanMessage(messages);
	if (latest === null) return null;
	const text = messageText(latest);
	if (text === null || matchesDistress(text)) return null;
	const flags = state.pendingProvenanceFlags;
	const provenance = flags.length > 0 ? provenanceNagText(flags) : null;
	if (provenance !== null) state.pendingProvenanceFlags = [];
	if (state.armed) return provenance === null ? RESEARCH_DEMAND_TEXT : `${provenance}\n${RESEARCH_DEMAND_TEXT}`;
	return provenance;
}
