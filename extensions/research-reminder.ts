/**
 * Research demand wiring (v5, owner's design): the owner invokes
 * `/skill:research` in chat; pi's skill system expands the skill's
 * directive into the turn natively. This extension enforces the demand:
 * the raw `input` event arms it (it fires before skill expansion, per the
 * pi docs), and the context hook injects the nag until a fetch tool
 * result disarms it. No keywords, no turn thresholds. Trigger logic is
 * pure in lib/research/reminder.ts (unit-tested in
 * test/research-reminder.test.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createResearchDemandState,
	researchDemandInjection,
	researchDemandOnInput,
	researchDemandOnToolResult,
} from "../lib/research/reminder.js";
import { injectedMessage } from "../lib/injects/scan.js";

export default function (pi: ExtensionAPI): void {
	const state = createResearchDemandState();
	pi.on("input", (event) => {
		// The event sees the raw text before skill expansion (pi docs);
		// pass through unchanged so pi expands the skill command itself.
		if (event.source !== "extension") researchDemandOnInput(state, event.text);
	});
	pi.on("tool_result", (event) => researchDemandOnToolResult(state, event.toolName));
	pi.on("context", (event) => {
		const injection = researchDemandInjection(state, event.messages);
		if (injection === null) return {};
		return {
			messages: [...event.messages, injectedMessage(injection)],
		};
	});
}
