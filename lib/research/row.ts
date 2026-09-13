/**
 * Approved fetch rows for the remoticon transcript
 * (docs/superpowers/specs/2026-09-13-research-port-design.md section 6).
 *
 * Row shape B: a state-coloured ● marker in column 0, └ branches in column 2,
 * branch content in column 4. The tool renders its own shell
 * (`renderShell: "self"`), so no theme background token applies. Attempt
 * chronology is deliberately absent (D4): `details` and the model text keep
 * every attempt record.
 */
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { pageLadder, type AttemptRecord, type PageRecord } from "./protocol.js";

type RowTheme = {
	bold(text: string): string;
	fg(color: "accent" | "dim" | "error" | "muted" | "success" | "warning", text: string): string;
};

/** The slice of pi's render context these rows read (pi 0.85.1 does not export the full type). */
type RenderContext = { state: unknown; isError?: boolean };

export interface FetchRowState { marker?: "running" | "settled" | "failed" | "cancelled" }

export interface RenderableDetails {
	pages?: PageRecord[];
	attempts?: AttemptRecord[];
	autoThrottle?: { enabled: boolean; startDelayMs: number; maxDelayMs: number; blockBackoff: boolean; observedDelays?: Record<string, number> } | null;
	cancelled?: boolean;
	live?: LiveRow[];
	pending?: boolean;
}

export interface LiveRow {
	requestedUrl: string;
	state: string;
	kind: "pending" | "ok" | "warn" | "bad";
}

/** The group's pending literal (spec 6.3): there is no violet theme token. */
const RUNNING_MARKER = "\x1b[38;2;185;165;232m●\x1b[39m";
const BRANCH = "  └ ";
const EVIDENCE_INDENT = "  ";

/** Short display URL: escapes stripped, scheme dropped, long paths middle-ellipsized. */
export function shrinkUrl(url: string, max = 52): string {
	// Model-supplied URLs are untrusted; never let an escape sequence reach the TUI.
	// eslint-disable-next-line no-control-regex
	const stripped = url.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/^[a-z]+:\/\//i, "");
	if (stripped.length <= max) return stripped;
	const slash = stripped.indexOf("/");
	if (slash < 0) return stripped.slice(0, max - 1) + "…";
	const host = stripped.slice(0, slash);
	const path = stripped.slice(slash);
	if (host.length + 2 >= max) return (host + "…" + path.slice(-4)).slice(0, max);
	const budget = max - host.length - 1;
	if (path.length <= budget) return host + path;
	return `${host}${path.slice(0, Math.max(4, budget - 8))}…${path.slice(-6)}`;
}

export function pageStateKind(page: PageRecord): "ok" | "warn" | "bad" {
	if (page.usable) return "ok";
	if (page.error !== null || page.cancelled) return "bad";
	return "warn";
}

function markerFor(theme: RowTheme, state: FetchRowState): string {
	const kind = state.marker ?? "running";
	if (kind === "running") return RUNNING_MARKER;
	return kind === "settled" ? theme.fg("success", "●") : theme.fg("error", "●");
}

function titleLabel(args: { targets?: Array<{ url: string }> } | undefined, theme: RowTheme): string {
	const targets = Array.isArray(args?.targets) ? args.targets : [];
	const name = theme.bold("Fetch");
	if (targets.length === 0) return `${name}${theme.fg("muted", "(…)")}`;
	if (targets.length === 1) {
		return `${name}${theme.fg("muted", "(")}${theme.fg("accent", shrinkUrl(targets[0]!.url ?? ""))}${theme.fg("muted", ")")}`;
	}
	return `${name}${theme.fg("muted", `(${targets.length} URLs concurrently)`)}`;
}

/** Dynamic call row: the marker is read at paint time, so settling repaints it. */
class CallRow implements Component {
	constructor(private readonly state: FetchRowState, private readonly args: unknown, private readonly theme: RowTheme) {}
	render(width: number): string[] {
		const marker = markerFor(this.theme, this.state);
		const title = titleLabel(this.args as { targets?: Array<{ url: string }> }, this.theme);
		return [truncateToWidth(`${marker} ${title}`, width, "")];
	}
	invalidate(): void {}
}

export function renderFetchCall(args: unknown, theme: RowTheme, context: RenderContext): Component {
	return new CallRow(context.state as FetchRowState, args, theme);
}

function shrinkReason(reason: string): string {
	return reason.length > 60 ? `${reason.slice(0, 60)}…` : reason;
}

function finalStatusText(page: PageRecord): string {
	if (page.finalStatus === null) return "no status";
	return `${page.finalStatus}${page.finalReason ? ` ${shrinkReason(page.finalReason)}` : ""}`;
}

/** Ladder-aware status text; every branch names only recorded facts. */
function targetStatus(page: PageRecord, ladder: ReturnType<typeof pageLadder>, theme: RowTheme): string {
	if (ladder !== null) {
		if (ladder.recovered) {
			const first =
				ladder.firstKind === "failed"
					? "failed"
					: ladder.firstKind === "empty"
						? `${ladder.firstStatus ?? "unknown"} → empty`
						: String(ladder.firstStatus ?? "unknown");
			const final = page.usable ? finalStatusText(page) : page.deadEndReason ?? "unusable";
			const text = `${first} → cleared with ${ladder.finalTier} · ${final}`;
			return page.usable ? theme.fg("success", text) : theme.fg("warning", text);
		}
		if (page.error !== null) return theme.fg("error", `failed: ${shrinkReason(page.error)}`);
		const first = String(ladder.firstStatus ?? "unknown");
		if (ladder.firstKind === "empty") return theme.fg("warning", `${first} → ${page.deadEndReason ?? "empty content"}`);
		return theme.fg("warning", `${first} → ${page.deadEndReason ?? "blocked"}`);
	}
	if (page.error !== null) return theme.fg("error", `failed: ${shrinkReason(page.error)}`);
	if (!page.usable) return theme.fg("warning", `${page.finalStatus ?? "no status"} → ${page.deadEndReason ?? "unusable"}`);
	const extracted = page.selectorApplied
		? `selector ${JSON.stringify(page.selector ?? "")} → ${formatSize(page.extractedBytes ?? 0)}`
		: `main content → ${formatSize(page.extractedBytes ?? 0)}`;
	const received = page.receivedBytes !== null ? `${formatSize(page.receivedBytes)} received` : "no bytes recorded";
	return `${theme.fg("success", finalStatusText(page))} · ${theme.fg("muted", `${received} · ${extracted}`)}`;
}

function evidenceRows(page: PageRecord, theme: RowTheme): string[] {
	const rows: string[] = [];
	if (page.truncation?.truncated) {
		rows.push(theme.fg("dim", `${EVIDENCE_INDENT}[truncated for the model: kept ${formatSize(page.truncation.keptBytes)} of ${formatSize(page.truncation.totalBytes)}; full sanitized markdown saved to ${page.truncation.outputPath ?? "(path unavailable)"}]`));
	}
	const captured = page.capturedXhr ?? [];
	if (captured.length > 0) {
		rows.push(theme.fg("dim", `${EVIDENCE_INDENT}captured xhr (${captured.length} response${captured.length === 1 ? "" : "s"}):`));
		for (const entry of captured) {
			rows.push(theme.fg("dim", `${EVIDENCE_INDENT}  [${shrinkUrl(entry.url, 60)}] (${entry.status ?? "no status"}, ${formatSize(entry.bytes)}${entry.truncated ? ", truncated" : ""})`));
		}
	}
	return rows;
}

function throttleLine(details: RenderableDetails, theme: RowTheme): string | null {
	const throttle = details.autoThrottle;
	if (!throttle) return null;
	const observed = Object.entries(throttle.observedDelays ?? {}).filter(([, ms]) => Number.isFinite(ms) && ms > 0);
	if (observed.length === 0) return null;
	const text = `AutoThrottle ${throttle.enabled ? "on" : "off"} (start ${throttle.startDelayMs}ms, max ${throttle.maxDelayMs}ms, block backoff ${throttle.blockBackoff ? "on" : "off"}) · observed: ${observed.map(([domain, ms]) => `${domain} ${Math.round(ms)}ms`).join(", ")}`;
	return theme.fg("muted", text);
}

function liveState(live: LiveRow, theme: RowTheme): string {
	const color = live.kind === "ok" ? "success" : live.kind === "bad" ? "error" : live.kind === "warn" ? "warning" : "muted";
	return theme.fg(color, live.state);
}

function errorHeadline(result: { content?: unknown }): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		const text = content.find((part) => (part as { type?: string })?.type === "text") as { text?: string } | undefined;
		if (text?.text) return text.text.length > 300 ? `${text.text.slice(0, 300)}…` : text.text;
	}
	return "fetch failed.";
}

function linesToComponent(lines: string[]): Component {
	const container = new Container();
	for (const line of lines) container.addChild(new Text(line, 0, 0));
	return container;
}

export function renderFetchResult(
	result: { content?: unknown; details?: unknown },
	options: ToolRenderResultOptions,
	theme: RowTheme,
	context: RenderContext,
): Component {
	const details = (result?.details ?? {}) as RenderableDetails;
	const state = context.state as FetchRowState;

	if (options.isPartial) {
		const live = details.live ?? [];
		const lines = live.length > 0
			? live.map((liveRow) => `${theme.fg("dim", BRANCH)}${theme.fg("accent", shrinkUrl(liveRow.requestedUrl || "fetching…"))}  ${liveState(liveRow, theme)}`)
			: [`${theme.fg("dim", BRANCH)}${theme.fg("warning", "fetching…")}`];
		return linesToComponent(lines);
	}
	if (details.cancelled) {
		state.marker = "cancelled";
		return linesToComponent([`${theme.fg("dim", BRANCH)}${theme.fg("warning", "Cancelled.")}`]);
	}
	if (context.isError === true) {
		state.marker = "failed";
		return linesToComponent([`${theme.fg("dim", BRANCH)}${theme.fg("error", errorHeadline(result))}`]);
	}
	const pages = details.pages ?? [];
	if (pages.length === 0) {
		state.marker = "failed";
		return linesToComponent([`${theme.fg("dim", BRANCH)}${theme.fg("warning", "no target record")}`]);
	}
	state.marker = pages.some((page) => page.usable) ? "settled" : "failed";
	const attempts = details.attempts ?? [];
	const lines: string[] = [];
	for (const page of pages) {
		const final = page.finalUrl !== null && page.finalUrl !== page.requestedUrl ? theme.fg("muted", ` (final ${shrinkUrl(page.finalUrl)})`) : "";
		lines.push(`${theme.fg("dim", BRANCH)}${theme.fg("accent", shrinkUrl(page.requestedUrl))}${final}  ${targetStatus(page, pageLadder(page, attempts), theme)}`);
		lines.push(...evidenceRows(page, theme));
	}
	const throttle = throttleLine(details, theme);
	if (throttle !== null) lines.push(throttle);
	return linesToComponent(lines);
}
