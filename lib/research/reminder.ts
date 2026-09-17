/**
 * Search-first reminder (v4, locked decision): when an ask needs
 * current-world information (a keyword in the latest human message) and no
 * fetch has run for a few turns, remind the agent of the research flow
 * before it plans from stale memory. Trigger logic is pure here (unit-tested
 * in test/research-reminder.test.ts); the wiring lives in
 * extensions/research-reminder.ts, through the same context hook as the
 * task-list reminders and the distress hail mary. It defers to the hail
 * mary: a distress phrase in the ask outranks a research nudge.
 */

import { matchesDistress } from "../distress/hailmary.js";
import { humanMessageOccurrences, latestHumanMessage, messageText, type HumanMessageLike } from "../injects/scan.js";

/** Turns without a fetch before the reminder is considered due. */
export const REMINDER_AFTER_TURNS = 3;

/** World-asking words only. "search" is excluded on purpose: it fires on
 * local asks like "search the repo for the failing test", and years rot. */
export const CURRENT_INFO_KEYWORDS: readonly string[] = [
	"latest",
	"news",
	"dated",
];

/** The keywords as whole-word matchers: "dated" must not fire on
 * "updated", "news" must not fire on "renews". */
const CURRENT_INFO_MATCHERS: readonly RegExp[] = CURRENT_INFO_KEYWORDS.map(
	(keyword) => new RegExp(`\\b${keyword}\\b`, "i"),
);

export function matchesCurrentInfo(text: string): boolean {
	return CURRENT_INFO_MATCHERS.some((matcher) => matcher.test(text));
}

export const RESEARCH_REMINDER_TEXT = [
	"<system-reminder>",
	"This ask needs current-world information and no fetch has run in the last few turns. Run the research flow now: one fetch call with a concurrent search batch (google.com/search, bing.com/search, duckduckgo.com for the same query), then fetch two to four result URLs plainly and follow the trails. Do not answer from memory.",
	"</system-reminder>",
].join("\n");

/** Turn counter, last fetch turn, and the ask already reminded for,
 * owned by the extension wiring. */
export interface ReminderState {
	turn: number;
	lastFetchTurn: number | null;
	/** The latest human ask seen on the previous call, or null. */
	lastSeenAsk: string | null;
	/** How many unwrapped human messages carried lastSeenAsk on the
	 * previous call: a new ask with the same wording adds an occurrence. */
	lastSeenOccurrences: number;
	/** True once the current ask already received its reminder. */
	injectedThisAsk: boolean;
}

export function createReminderState(): ReminderState {
	return { turn: 0, lastFetchTurn: null, lastSeenAsk: null, lastSeenOccurrences: 0, injectedThisAsk: false };
}

export function reminderOnTurnStart(state: ReminderState): void {
	state.turn++;
}

export function reminderOnToolResult(state: ReminderState, toolName: string): void {
	if (toolName === "fetch") {
		state.lastFetchTurn = state.turn;
		// A fetch serves the current ask's need: the latch re-arms so a
		// later expired cadence on the same ask can remind again.
		state.injectedThisAsk = false;
	}
}

/** The reminder to append on this model call, or null. Null while a fetch
 * ran within the last few turns (three to start), when the latest human
 * message carries no current-world keyword, or when this ask already
 * received one. The context hook fires before every model call of a turn,
 * and its returned messages do not persist into session history (verified
 * against the installed harness), so the only workable dedup is state: the
 * ask is remembered, the reminder fires once per ask, and a different
 * latest ask, a recorded fetch, or the same wording arriving as a new
 * message re-arms it. */
export function researchReminderInjection(
	state: ReminderState,
	messages: readonly HumanMessageLike[],
): string | null {
	const lastFetch = state.lastFetchTurn ?? 0;
	if (state.turn - lastFetch < REMINDER_AFTER_TURNS) return null;
	const latest = latestHumanMessage(messages);
	if (latest === null) return null;
	const text = messageText(latest);
	if (text === null || matchesDistress(text)) return null;
	const occurrences = humanMessageOccurrences(messages, text);
	if (state.lastSeenAsk !== text || state.lastSeenOccurrences !== occurrences) {
		state.lastSeenAsk = text;
		state.lastSeenOccurrences = occurrences;
		state.injectedThisAsk = false;
	}
	if (!matchesCurrentInfo(text)) return null;
	if (state.injectedThisAsk) return null;
	state.injectedThisAsk = true;
	return RESEARCH_REMINDER_TEXT;
}
