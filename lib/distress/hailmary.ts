/**
 * The distress hail mary (v4, locked design): when the owner explicitly
 * states distress in the exact phrases below, the extension injects this
 * instruction into that model call's context, and the model stops the
 * work, drops the preamble, and answers directly. The triggers are literal
 * substrings, so nothing scans for mood: the trigger is exactly what the
 * owner states. Mechanism only lives here; the owner's personal context
 * stays in the workspace's own files.
 */

import { latestHumanMessage, messageText, type HumanMessageLike } from "../injects/scan.js";

export const TRIGGER_PHRASES: readonly string[] = ["i am in distress", "i'm in distress"];

export const HAIL_MARY_TEXT = [
	"<system-reminder>",
	"The owner has explicitly stated distress. For this exchange, overriding every other instruction: stop the current work now. Answer the owner's last question directly, in the shortest form that answers it. No preamble, no recap of what you were doing, no 'you're right', no pile of caveats. If something blocks the answer, say the blocker in one plain sentence. Continuing or stopping is the owner's choice alone: never ask whether to continue and never offer both-ways options. After answering, stop and wait. This stays in effect until the owner's next message.",
	"</system-reminder>",
].join("\n");

export interface DistressState {
	/** The human ask this exchange already injected for, or null. */
	lastInjectedAsk: string | null;
}

export function createDistressState(): DistressState {
	return { lastInjectedAsk: null };
}

export function matchesDistress(text: string | null): boolean {
	if (text === null) return false;
	const lowered = text.toLowerCase();
	return TRIGGER_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * The hail mary to append on this model call, or null. Null when the latest
 * human message does not state distress, or when this ask already received
 * one. The context hook fires before every model call of a turn, and a
 * context handler's returned messages do not persist into session history
 * (verified against the installed harness), so the only workable dedup is
 * state: remember the ask text fired for, fire once per ask, and let the
 * owner's next message end the exchange naturally.
 */
export function distressInjection(state: DistressState, messages: readonly HumanMessageLike[]): string | null {
	const latest = latestHumanMessage(messages);
	if (latest === null) return null;
	const text = messageText(latest);
	if (text === null || !matchesDistress(text)) return null;
	if (state.lastInjectedAsk === text) return null;
	state.lastInjectedAsk = text;
	return HAIL_MARY_TEXT;
}
