/**
 * Search-first reminder wiring (v4, locked): tracks turns and fetch tool
 * results, and injects the research-flow reminder through the context hook
 * when an ask needs current-world information and no fetch has run. Trigger
 * logic is pure in lib/research/reminder.ts (unit-tested in
 * test/research-reminder.test.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReminderState,
	reminderOnToolResult,
	reminderOnTurnStart,
	researchReminderInjection,
} from "../lib/research/reminder.js";
import { injectedMessage } from "../lib/injects/scan.js";

export default function (pi: ExtensionAPI): void {
	const state = createReminderState();
	pi.on("turn_start", () => reminderOnTurnStart(state));
	pi.on("tool_result", (event) => reminderOnToolResult(state, event.toolName));
	pi.on("context", (event) => {
		const injection = researchReminderInjection(state, event.messages);
		if (injection === null) return {};
		return {
			messages: [...event.messages, injectedMessage(injection)],
		};
	});
}
