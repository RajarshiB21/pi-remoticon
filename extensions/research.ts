/**
 * Research extension entry point. This is the only file the package manifest
 * loads for fetch: every file in extensions/ must be a valid pi factory, so
 * the wiring lives in lib/research/tool.ts and this file only connects it.
 * No global settings, no APPEND_SYSTEM.md, no file copy.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateResearchTools, registerFetchTool } from "../lib/research/tool.js";

export default function research(pi: ExtensionAPI): void {
	registerFetchTool(pi);
	// Idempotent, additive: keeps fetch active if another extension replaces
	// the active-tool set during a session.
	pi.on("session_start", () => activateResearchTools(pi));
}
