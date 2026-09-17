/**
 * Distress hail mary wiring (v4, locked): scans the latest human message
 * for an explicit distress phrase and injects the approved instruction
 * into that model call's context. Pure trigger logic lives in
 * lib/distress/hailmary.ts (unit-tested in test/distress-injection.test.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectedMessage } from "../lib/injects/scan.js";
import { distressInjection } from "../lib/distress/hailmary.js";

export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const injection = distressInjection(event.messages);
		if (injection === null) return {};
		return {
			messages: [...event.messages, injectedMessage(injection)],
		};
	});
}