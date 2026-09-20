/**
 * Research demand wiring (v6, workspace spec 00_Mainframe docs/superpowers/
 * specs/2026-09-20-research-first-mile.md): the owner invokes
 * `/skill:research` in chat or the model loads the research skill itself;
 * both arm the demand. The context hook injects the nag until a real
 * search engine fetch disarms it; while armed, search queries carrying
 * non-owner vocabulary are flagged for the next injection. No keywords,
 * no turn thresholds. Trigger logic is pure in lib/research/reminder.ts
 * (unit-tested in test/research-reminder.test.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createResearchDemandState,
	researchDemandInjection,
	researchDemandOnInput,
	researchDemandOnToolCall,
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
	pi.on("tool_call", (event) => {
		// Observes skill loads and pre-fetch query provenance. Advisory only;
		// this handler never blocks.
		researchDemandOnToolCall(state, event.toolName, event.input);
	});
	pi.on("tool_result", (event) => researchDemandOnToolResult(state, event.toolName, event.input, event.isError));
	pi.on("context", (event) => {
		const injection = researchDemandInjection(state, event.messages);
		if (injection === null) return {};
		return {
			messages: [...event.messages, injectedMessage(injection)],
		};
	});
}
