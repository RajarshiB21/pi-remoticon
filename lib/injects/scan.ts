/**
 * Message-list scanning shared by the injection extensions (v4): find the
 * latest message a human typed, skipping the injections themselves (their
 * texts open with <system-reminder>) and every non-user role (toolResult,
 * bashExecution, custom, compaction summaries are not human speech).
 */

export interface HumanMessageLike {
	role: string;
	content?: unknown;
	timestamp?: number;
}

/** True when a content value opens with the reminder tag the injection
 * extensions wrap their texts in, so callers that want what the human
 * typed can skip the injections. */
export function isReminderWrapped(content: unknown): boolean {
	if (typeof content === "string") return content.startsWith("<system-reminder>");
	if (Array.isArray(content)) {
		const first = (content as Array<{ type?: unknown; text?: unknown }>)[0];
		return first?.type === "text" && typeof first.text === "string" && first.text.startsWith("<system-reminder>");
	}
	return false;
}

/** Readable text of a message, or null when it carries none. */
export function messageText(message: HumanMessageLike): string | null {
	const content = message.content;
	if (typeof content === "string") {
		return content.trim() === "" ? null : content;
	}
	if (!Array.isArray(content)) return null;
	const joined = (content as Array<{ type?: unknown; text?: unknown }>)
		.map((part) => part.text)
		.filter((text): text is string => typeof text === "string")
		.join(" ");
	return joined.trim() === "" ? null : joined;
}

/** Latest message a human typed, else null. */
export function latestHumanMessage(messages: readonly HumanMessageLike[]): HumanMessageLike | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		const text = messageText(message);
		if (text === null) continue;
		if (isReminderWrapped(text)) continue;
		return message;
	}
	return null;
}

/** How many unwrapped human messages in `messages` carry exactly `text`.
 * Message objects are not guaranteed stable across context calls, but the
 * occurrence count is: a new ask with the same wording adds an occurrence,
 * while repeated calls on the same ask keep the count flat. */
export function humanMessageOccurrences(messages: readonly HumanMessageLike[], text: string): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user" || isReminderWrapped(message)) continue;
		if (messageText(message) === text) count++;
	}
	return count;
}

/** The user-role message shape the injection extensions append: the text
 * wrapped in a single text block, timestamped now. */
export function injectedMessage(text: string): { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number } {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
