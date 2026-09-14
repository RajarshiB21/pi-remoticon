/**
 * The fetch tree (docs/superpowers/specs/2026-09-14-research-tree-design.md §4–§5).
 *
 * A state-coloured ● marker at column 0, ├─/└─ lanes at column 2 whose content
 * starts at column 5, rung/detail/evidence lines at column 7, and one receipt
 * rule at column 5. The row paints its own shell (`renderShell: "self"`), so no
 * theme background applies, and it is painted whether or not its group is
 * expanded: the tree has no collapsed form (spec §3).
 *
 * Lines are built inside render(width) from `details`, so the breathing dot and
 * the live clock move on the repaint the footer clock already drives.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { stripControlSequences, type AttemptRecord, type PageRecord } from "./protocol.js";
import { formatDuration } from "./summary.js";
import { dotColor, rgb } from "../ui-state.js";

type RowTheme = {
	bold(text: string): string;
	fg(color: "accent" | "dim" | "error" | "muted" | "success" | "warning", text: string): string;
};

/** The slice of pi's render context these rows read (pi 0.85.1 does not export the full type). */
type RenderContext = { state: unknown; isError?: boolean };

export interface FetchRowState { marker?: "running" | "settled" | "failed" | "cancelled" }

export interface LiveRow {
	targetId: string;
	requestedUrl: string;
	settled: boolean;
	kind: "pending" | "ok" | "warn" | "bad";
}

export interface RenderableDetails {
	pages?: PageRecord[];
	attempts?: AttemptRecord[];
	autoThrottle?: { enabled: boolean; startDelayMs: number; maxDelayMs: number; blockBackoff: boolean; observedDelays?: Record<string, number> } | null;
	browserMode?: "none" | "local" | "remote-cdp";
	cancelled?: boolean;
	live?: LiveRow[];
	pending?: boolean;
	startedAt?: number | null;
	completedAt?: number | null;
	maxBlockedRetries?: number | null;
	inlineBody?: boolean;
}

/** The group's running violet is a 24-bit literal, not a theme token (spec §4.8). */
const RUNNING_COLOR: number[] = [185, 165, 232];
const LANE_PREFIX = "  ";
const LANE_MID = "  │    ";
const LANE_LAST = "       ";
const RECEIPT_PREFIX = "  ── ";
/** Below this width a lane's state moves onto its own line (spec §4.9). */
const NARROW = 64;

/** Short display URL: escapes stripped, scheme dropped, long paths middle-ellipsized. */
export function shrinkUrl(url: string, max = 52): string {
	// Model-supplied URLs are untrusted; never let an escape sequence reach the TUI.
	const stripped = stripControlSequences(url).replace(/^[a-z]+:\/\//i, "");
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

function motionEnabled(): boolean {
	return process.env.PI_REMOTICON_MOTION !== "off";
}

function shorten(value: string, max: number): string {
	const visible = stripControlSequences(value);
	return visible.length <= max ? visible : `${visible.slice(0, max)}…`;
}

/** One blocked-signal rule: the label up to its first hyphen, capped (spec §5.3). */
function blockedLabel(signal: string): string {
	const visible = stripControlSequences(signal);
	const cut = visible.indexOf("-");
	return shorten(cut > 0 ? visible.slice(0, cut) : visible, 24);
}

function fit(candidates: string[], width: number): string {
	for (const candidate of candidates) if (visibleWidth(candidate) <= width) return candidate;
	const leanest = candidates[candidates.length - 1] ?? "";
	return truncateToWidth(leanest, width, "");
}

function markerFor(theme: RowTheme, state: FetchRowState): string {
	const kind = state.marker ?? "running";
	if (kind === "running") return rgb(RUNNING_COLOR, "●");
	return kind === "settled" ? theme.fg("success", "●") : theme.fg("error", "●");
}

function titleLabel(args: { targets?: Array<{ url: string }>; captureXhr?: string } | undefined, theme: RowTheme): string {
	const targets = Array.isArray(args?.targets) ? args.targets : [];
	const name = theme.bold("Fetch");
	if (targets.length === 0) return `${name}${theme.fg("muted", "(…)")}`;
	if (targets.length === 1) return `${name}${theme.fg("muted", "(")}${theme.fg("accent", shrinkUrl(targets[0]!.url ?? ""))}${theme.fg("muted", ")")}`;
	// The ladder named here is the helper's own: captureXhr starts on the browser
	// rung, and every batch that climbs ends on stealth (spec §4.3).
	const ladder = typeof args?.captureXhr === "string" && args.captureXhr.trim() !== ""
		? "dynamic → stealth"
		: "http → dynamic → stealth";
	return `${name}${theme.fg("muted", `(${targets.length} URLs concurrently · ${ladder})`)}`;
}

/** Dynamic call row: the marker is read at paint time, so settling repaints it. */
class CallRow implements Component {
	constructor(private readonly state: FetchRowState, private readonly args: unknown, private readonly theme: RowTheme) {}
	render(width: number): string[] {
		return [truncateToWidth(`${markerFor(this.theme, this.state)} ${titleLabel(this.args as { targets?: Array<{ url: string }> }, this.theme)}`, width, "")];
	}
	invalidate(): void {}
}

export function renderFetchCall(args: unknown, theme: RowTheme, context: RenderContext): Component {
	return new CallRow(context.state as FetchRowState, args, theme);
}

interface Lane {
	targetId: string;
	requestedUrl: string;
	page: PageRecord | undefined;
	settled: boolean;
	kind: "pending" | "ok" | "warn" | "bad";
	attempts: AttemptRecord[];
}

function collectLanes(details: RenderableDetails): Lane[] {
	const attempts = details.attempts ?? [];
	const pages = new Map((details.pages ?? []).map((page) => [page.targetId, page]));
	const live = details.live ?? [];
	// A live payload orders the lanes; the settled payload is its own order.
	const ordered = live.length > 0
		? live.map((row) => ({ targetId: row.targetId, requestedUrl: row.requestedUrl, settled: row.settled, kind: row.kind as Lane["kind"] }))
		: (details.pages ?? []).map((page) => ({ targetId: page.targetId, requestedUrl: page.requestedUrl, settled: true, kind: pageStateKind(page) as Lane["kind"] }));
	return ordered.map((row) => ({ ...row, page: pages.get(row.targetId), attempts: attempts.filter((attempt) => attempt.targetId === row.targetId) }));
}

/** The state of a settled lane whose page record never arrived: named, never invented. */
function kindWord(kind: Lane["kind"]): string {
	return kind === "ok" ? "received" : kind === "bad" ? "failed" : "unusable";
}

/** A page's own duration: first attempt start to last attempt end (spec §6.2). */
function laneDurationMs(attempts: AttemptRecord[]): number | null {
	if (attempts.length === 0) return null;
	const started = Math.min(...attempts.map((entry) => entry.startedAt));
	const completed = Math.max(...attempts.map((entry) => entry.completedAt));
	return completed >= started ? completed - started : null;
}

function laneGlyph(kind: Lane["kind"], settled: boolean, theme: RowTheme, elapsedSeconds: number): string {
	if (!settled) return rgb([...dotColor(elapsedSeconds, "Working", motionEnabled())], "◐");
	if (kind === "ok") return theme.fg("success", "✓");
	return theme.fg(kind === "bad" ? "error" : "warning", "✗");
}

function laneOutcome(page: PageRecord, theme: RowTheme): string {
	if (page.error !== null) return theme.fg("error", `failed: ${shorten(page.error, 60)}`);
	const status = page.finalStatus !== null ? String(page.finalStatus) : "no status";
	if (page.usable) return theme.fg("success", `${status}${page.finalReason ? ` ${shorten(page.finalReason, 40)}` : ""}`);
	return theme.fg("warning", `${status} → ${shorten(page.deadEndReason ?? "unusable", 60)}`);
}

function laneSizes(page: PageRecord, theme: RowTheme): string | null {
	if (page.receivedBytes === null) return null;
	const received = formatSize(page.receivedBytes);
	if (page.extractedBytes === null) return theme.fg("muted", received);
	const label = page.selectorApplied ? `selector ${JSON.stringify(page.selector ?? "")}` : "main";
	return theme.fg("muted", `${received} → ${formatSize(page.extractedBytes)} ${label}`);
}

function rungToken(attempt: AttemptRecord): string {
	const status =
		attempt.status !== null
			? String(attempt.status)
			: attempt.unusableSignal === "empty content"
				? "empty"
				: `failed${attempt.reason ? ` ${shorten(attempt.reason, 24)}` : ""}`;
	const signal = attempt.blockedSignal !== null ? ` ${blockedLabel(attempt.blockedSignal)}` : "";
	const latency = attempt.latencyMs !== null ? ` ${formatDuration(attempt.latencyMs)}` : "";
	const retry = attempt.retryAfterSeconds !== null ? ` retry-after ${Math.round(attempt.retryAfterSeconds)}s` : "";
	return `${status}${signal}${latency}${retry}`;
}

function rungLine(lane: Lane, theme: RowTheme): string {
	const arrow = theme.fg("dim", "→");
	return lane.attempts
		.map((attempt) => {
			const color = attempt.status !== null && attempt.status < 400 ? "success" : "warning";
			const wait = attempt.waitMs !== null && attempt.waitMs > 50 ? `${theme.fg("muted", `waited ${formatDuration(attempt.waitMs)}`)} ${arrow} ` : "";
			return `${wait}${theme.fg(color, rungToken(attempt))}`;
		})
		.join(` ${arrow} `);
}

function rungStrip(lane: Lane, theme: RowTheme): string | null {
	if (lane.attempts.length === 0) return null;
	const parts = lane.attempts.map((attempt) => {
		const status = attempt.status !== null ? String(attempt.status) : attempt.unusableSignal === "empty content" ? "empty" : "failed";
		const color = attempt.status !== null && attempt.status < 400 ? "success" : "warning";
		return theme.fg(color, `${attempt.tier} ${status}`);
	});
	const tail = lane.settled ? (lane.kind === "ok" ? theme.fg("success", " ✓") : "") : theme.fg("dim", " …");
	return parts.join(theme.fg("dim", " ⟶ ")) + tail;
}

function evidenceLines(page: PageRecord, theme: RowTheme): string[] {
	const lines: string[] = [];
	if (page.truncation?.truncated) {
		lines.push(theme.fg("dim", `[truncated for the model: kept ${formatSize(page.truncation.keptBytes)} of ${formatSize(page.truncation.totalBytes)}; full sanitized markdown saved to ${shorten(page.truncation.outputPath ?? "(path unavailable)", 200)}]`));
	}
	const captured = page.capturedXhr ?? [];
	if (captured.length > 0) {
		lines.push(theme.fg("dim", `captured xhr (${captured.length} response${captured.length === 1 ? "" : "s"}):`));
		for (const entry of captured) {
			lines.push(theme.fg("dim", `[${shrinkUrl(entry.url, 60)}] (${entry.status ?? "no status"}, ${formatSize(entry.bytes)}${entry.truncated ? ", truncated" : ""})`));
		}
	}
	return lines;
}

function receiptLines(details: RenderableDetails, lanes: Lane[], now: number, theme: RowTheme): string[] {
	const parts: string[] = [];
	const observed = Object.entries(details.autoThrottle?.observedDelays ?? {}).filter(([, ms]) => Number.isFinite(ms) && ms > 0).slice(0, 3);
	if (observed.length > 0) parts.push(`throttle ${observed.map(([domain, ms]) => `${formatDuration(ms)} on ${shorten(domain, 40)}`).join(", ")}`);
	if (details.browserMode !== undefined && details.browserMode !== "none") parts.push(`browser ${details.browserMode}`);
	const blocks = lanes.reduce((total, lane) => total + lane.attempts.filter((attempt) => attempt.blockedSignal !== null).length, 0);
	if (blocks > 0) parts.push(`${blocks} block${blocks === 1 ? "" : "s"}`);
	if (parts.length === 0) return [];
	const startedAt = details.startedAt ?? null;
	const finishedAt = details.completedAt ?? null;
	// The live clock is a number that must keep moving, so it is printed only
	// while the dot breathes for it (spec §4.10).
	const final = details.pending === true
		? startedAt !== null && motionEnabled()
			? `elapsed ${formatDuration(Math.max(0, now - startedAt))}`
			: null
		: startedAt !== null && finishedAt !== null
			? `total ${formatDuration(Math.max(0, finishedAt - startedAt))}`
			: null;
	const all = final === null ? parts : [...parts, final];
	return [RECEIPT_PREFIX + all.map((part) => theme.fg("muted", part)).join(theme.fg("dim", " · "))];
}

function errorHeadline(result: { content?: unknown }): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		const text = content.find((part) => (part as { type?: string })?.type === "text") as { text?: string } | undefined;
		if (text?.text) return shorten(text.text, 300);
	}
	return "fetch failed.";
}

class FetchTree implements Component {
	constructor(
		private readonly details: RenderableDetails,
		private readonly theme: RowTheme,
		private readonly error: string | null,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		if (this.error !== null) return [truncateToWidth(`${LANE_PREFIX}└─ ${theme.fg("error", this.error)}`, width, "")];
		if (this.details.cancelled === true) return [truncateToWidth(`${LANE_PREFIX}└─ ${theme.fg("warning", "Cancelled.")}`, width, "")];
		const lanes = collectLanes(this.details);
		if (lanes.length === 0) return [truncateToWidth(`${LANE_PREFIX}└─ ${theme.fg("warning", "no target record")}`, width, "")];
		const now = Date.now();
		const lines: string[] = [];
		lanes.forEach((lane, index) => lines.push(...this.laneLines(lane, index === lanes.length - 1, width, now)));
		lines.push(...receiptLines(this.details, lanes, now, theme).map((line) => truncateToWidth(line, width, "")));
		return lines;
	}

	invalidate(): void {}

	private laneLines(lane: Lane, last: boolean, width: number, now: number): string[] {
		const theme = this.theme;
		const head = `${LANE_PREFIX}${last ? "└─ " : "├─ "}`;
		const body = last ? LANE_LAST : LANE_MID;
		const url = theme.fg("accent", shrinkUrl(lane.requestedUrl));
		const final = lane.page !== undefined && lane.page.finalUrl !== null && lane.page.finalUrl !== lane.page.requestedUrl
			? theme.fg("muted", ` (final ${shrinkUrl(lane.page.finalUrl)})`)
			: "";
		const lines: string[] = [];

		if (!lane.settled) {
			lines.push(truncateToWidth(`${head}${url}${final}`, width, ""));
			const ceiling = typeof this.details.maxBlockedRetries === "number" ? this.details.maxBlockedRetries + 1 : null;
			const position = ceiling === null ? `rung ${lane.attempts.length + 1}` : `rung ${Math.min(lane.attempts.length + 1, ceiling)} of ${ceiling}`;
			const seconds = this.details.startedAt !== null && this.details.startedAt !== undefined ? (now - this.details.startedAt) / 1000 : 0;
			lines.push(truncateToWidth(`${body}${laneGlyph(lane.kind, false, theme, seconds)} ${theme.fg("muted", position)}`, width, ""));
			if (lane.attempts.length > 0) lines.push(truncateToWidth(`${body}${theme.fg("dim", "└ ")}${rungLine(lane, theme)}`, width, ""));
			return lines;
		}

		const page = lane.page;
		if (page === undefined) {
			// Settled without a page record: the state is known, the facts are not.
			lines.push(truncateToWidth(`${head}${url}${final}`, width, ""));
			const color = lane.kind === "ok" ? "success" : lane.kind === "bad" ? "error" : "warning";
			lines.push(truncateToWidth(`${body}${laneGlyph(lane.kind, true, theme, 0)} ${theme.fg(color, kindWord(lane.kind))}`, width, ""));
			return lines;
		}
		const glyph = laneGlyph(lane.kind, true, theme, 0);
		const outcome = laneOutcome(page, theme);
		const sizes = laneSizes(page, theme);
		const durationMs = laneDurationMs(lane.attempts);
		const duration = durationMs === null ? null : theme.fg("muted", formatDuration(durationMs));
		const strip = rungStrip(lane, theme);
		const separator = theme.fg("dim", " · ");
		const base = `${head}${url}${final}  ${glyph} `;

		if (width < NARROW) {
			lines.push(truncateToWidth(`${head}${url}${final}`, width, ""));
			lines.push(truncateToWidth(`${body}${glyph} ${outcome}`, width, ""));
		} else {
			const facts = [outcome, sizes, duration].filter((part): part is string => part !== null);
			lines.push(fit([
				`${base}${facts.join(separator)}${strip === null ? "" : `   ${strip}`}`,
				`${base}${facts.join(separator)}`,
				`${base}${[outcome, sizes].filter((part): part is string => part !== null).join(separator)}`,
				`${base}${outcome}`,
			], width));
		}
		if (lane.attempts.length >= 2) lines.push(truncateToWidth(`${body}${theme.fg("dim", "└ ")}${rungLine(lane, theme)}`, width, ""));
		for (const evidence of evidenceLines(page, theme)) lines.push(truncateToWidth(`${body}${evidence}`, width, ""));
		return lines;
	}
}

export function renderFetchResult(
	result: { content?: unknown; details?: unknown },
	_options: ToolRenderResultOptions,
	theme: RowTheme,
	context: RenderContext,
): Component {
	const details = (result?.details ?? {}) as RenderableDetails;
	const state = context.state as FetchRowState;
	// A live payload keeps the violet running marker: red is for a settled batch
	// that produced nothing usable, a failure or a cancellation (spec §4.3).
	if (details.cancelled === true) state.marker = "cancelled";
	else if (details.pending === true) state.marker = "running";
	else if (context.isError === true && (details.pages ?? []).length === 0) state.marker = "failed";
	else state.marker = (details.pages ?? []).some((page) => page.usable) ? "settled" : "failed";
	return new FetchTree(details, theme, context.isError === true ? errorHeadline(result) : null);
}
