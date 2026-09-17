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
import { injectedAfter, latestHumanMessage, messageText, type HumanMessageLike } from "../injects/scan.js";

/** Turns without a fetch before the reminder is considered due. */
export const REMINDER_AFTER_TURNS = 3;

export const CURRENT_INFO_KEYWORDS: readonly string[] = [
	"latest",
	"news",
	"search",
	"2026",
	"2027",
];

export const RESEARCH_REMINDER_TEXT = [
	"<system-reminder>",
	"This ask needs current-world information and no fetch has run in the last few turns. Run the research flow now: one fetch call with a concurrent search batch (google.com/search, bing.com/search, duckduckgo.com for the same query), then fetch two to four result URLs plainly and follow the trails. Do not answer from memory.",
	"</system-reminder>",
].join("\n");

/** Marker inside the injected text, so a repeat fire for the same ask is
 * detected without stacking. */
const INJECTION_MARKER = "research flow now: one fetch call";

/** Turn counter and last fetch turn, owned by the extension wiring. */
export interface ReminderState {
	turn: number;
	lastFetchTurn: number | null;
}

export function createReminderState(): ReminderState {
	return { turn: 0, lastFetchTurn: null };
}

export function reminderOnTurnStart(state: ReminderState): void {
	state.turn++;
}

export function reminderOnToolResult(state: ReminderState, toolName: string): void {
	if (toolName === "fetch") state.lastFetchTurn = state.turn;
}

/** The reminder to append on this model call, or null. Null while a fetch
 * ran within the last few turns (three to start), when the latest human
 * message carries no current-info keyword, or when this ask already carries
 * one (the hook fires before every model call; it must not stack). */
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
	const lowered = text.toLowerCase();
	if (!CURRENT_INFO_KEYWORDS.some((keyword) => lowered.includes(keyword))) return null;
	if (injectedAfter(messages, INJECTION_MARKER)) return null;
	return RESEARCH_REMINDER_TEXT;
}