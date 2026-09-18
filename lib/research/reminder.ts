/**
 * Research demand (v5, owner's design): no keywords, no turn thresholds.
 * The owner invokes research explicitly with pi's native skill command
 * `/skill:research`; pi expands the skill's content into the turn. This
 * extension enforces it: the raw `input` event (fired before skill
 * expansion, per the pi docs) arms the demand, the context hook injects
 * the nag until a fetch tool result disarms it. A fetch silences the ask;
 * without one, the nag repeats on every model call. The distress hail
 * mary outranks it.
 */

import { matchesDistress } from "../distress/hailmary.js";
import { latestHumanMessage, messageText, type HumanMessageLike } from "../injects/scan.js";

/** The chat command the owner types; the input event sees it raw, before
 * pi expands the skill. */
export const RESEARCH_COMMAND = "/skill:research";

export const RESEARCH_DEMAND_TEXT = [
	"<system-reminder>",
	"The owner invoked research for this turn and no fetch has run yet. Run the research flow now: one fetch call with a concurrent search batch (google.com/search, bing.com/search, duckduckgo.com for the same query), then fetch two to four result URLs plainly and follow the trails. Do not answer from memory. This repeats until a fetch has run.",
	"</system-reminder>",
].join("\n");

export interface ResearchDemandState {
	/** True once the owner invoked research and no fetch has run since. */
	armed: boolean;
}

export function createResearchDemandState(): ResearchDemandState {
	return { armed: false };
}

/** The raw user input, as the pi input event delivers it. Arms the demand
 * when the owner typed the research command; anything else leaves the
 * state alone. */
export function researchDemandOnInput(state: ResearchDemandState, text: string): void {
	const trimmed = text.trim().toLowerCase();
	const isCommand =
		trimmed === RESEARCH_COMMAND ||
		trimmed.startsWith(`${RESEARCH_COMMAND} `);
	if (isCommand) state.armed = true;
}

/** A completed fetch serves the demand: disarm. */
export function researchDemandOnToolResult(state: ResearchDemandState, toolName: string): void {
	if (toolName === "fetch") state.armed = false;
}

/**
 * The nag to append on this model call, or null. Null while no research
 * demand is armed, while the latest human message states distress, or
 * once a fetch disarmed the demand. While armed, the nag repeats on every
 * model call until the fetch runs.
 */
export function researchDemandInjection(
	state: ResearchDemandState,
	messages: readonly HumanMessageLike[],
): string | null {
	if (!state.armed) return null;
	const latest = latestHumanMessage(messages);
	if (latest === null) return null;
	const text = messageText(latest);
	if (text === null || matchesDistress(text)) return null;
	return RESEARCH_DEMAND_TEXT;
}
