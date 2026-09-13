/**
 * Versioned NDJSON protocol between the fetch tool (TypeScript) and
 * src/research/helper.py (Python). The helper reads one JSON request on
 * stdin and emits newline-delimited events on stdout. Nothing else may
 * ever be written to the helper's stdout; logging goes to stderr only.
 *
 * Spec: docs/spec/RESEARCH_SPEC.md section 6.1.
 */

/**
 * v2 (R3): the request gains blockedDomains + captureXhr, pages gain
 * truthful browser facts and captured-XHR records, and batch_finished
 * reports the browser mode actually used (none | local | remote-cdp).
 * A v1 helper/tool pair would silently ignore the new fields, so the
 * version must move together with the shape.
 *
 * v3 (R5): attempt records gain unusableSignal (empty-extraction
 * escalation, RV-1) and transport-failure attempts carry the real error
 * text in reason (RV-2/RV-6). pageLadder covers blocked, empty, and
 * transport escalation.
 */
export const PROTOCOL_VERSION = 3;

/** Settings the helper reports in batch_started so the receipt never invents them. */
export interface AutoThrottleSettings {
	enabled: boolean;
	startDelayMs: number;
	maxDelayMs: number;
	blockBackoff: boolean;
}

/** One rung of the escalation ladder actually executed for a target. */
export interface AttemptRecord {
	targetId: string;
	url: string;
	attempt: number;
	tier: string;
	status: number | null;
	reason: string | null;
	receivedBytes: number | null;
	latencyMs: number | null;
	waitMs: number | null;
	retryAfterSeconds: number | null;
	blockedSignal: string | null;
	/** RV-1: set when a 2xx rung extracted empty content and escalated. */
	unusableSignal: string | null;
	startedAt: number;
	completedAt: number;
}

/** Per-target truncation report. Paths live inside the call's output directory. */
export interface TruncationRecord {
	truncated: boolean;
	keptBytes: number;
	totalBytes: number;
	outputPath?: string;
}

/** One captured background fetch/XHR response, bounded per entry by the helper. */
export interface CapturedXhrRecord {
	url: string;
	status: number | null;
	bytes: number;
	truncated: boolean;
	content: string;
}

/** Per-target receipt. Never carries raw HTML, request headers, or cookies. */
export interface PageRecord {
	targetId: string;
	requestedUrl: string;
	finalUrl: string | null;
	selector: string | null;
	selectorApplied: boolean;
	finalStatus: number | null;
	finalReason: string | null;
	receivedBytes: number | null;
	extractedBytes: number | null;
	usedStealth: boolean;
	usedAdBlocking: boolean;
	blockedDomainsCount: number;
	usable: boolean;
	deadEndReason: string | null;
	error: string | null;
	cancelled: boolean;
	content: string | null;
	capturedXhr: CapturedXhrRecord[] | null;
	truncation: TruncationRecord | null;
	fullOutputPath: string | null;
}

export interface BatchStartedEvent {
	protocolVersion: number;
	type: "batch_started";
	batchId: string;
	startedAt: number;
	browserMode: "none" | "local" | "remote-cdp";
	globalConcurrency: number;
	perDomainConcurrency: number;
	maxBlockedRetries: number;
	autoThrottle: AutoThrottleSettings;
	targetCount: number;
}

export interface AttemptFinishedEvent {
	protocolVersion: number;
	type: "attempt_finished";
	batchId: string;
	attempt: AttemptRecord;
}

export interface TargetFinishedEvent {
	protocolVersion: number;
	type: "target_finished";
	batchId: string;
	page: PageRecord;
}

export interface BatchFinishedEvent {
	protocolVersion: number;
	type: "batch_finished";
	batchId: string;
	completedAt: number;
	browserMode: "none" | "local" | "remote-cdp";
	autoThrottle: AutoThrottleSettings & { observedDelays: Record<string, number> };
	stats: {
		blockedCount: number;
		failedCount: number;
		requestCount: number;
	};
	pages: PageRecord[];
	/** Helper self-report: peak working set and wall time (P6 evidence). */
	resources?: { peakRssBytes: number | null; elapsedMs: number | null };
}

export interface FatalErrorEvent {
	protocolVersion: number;
	type: "fatal_error";
	batchId: string | null;
	error: string;
}

export type HelperEvent =
	| BatchStartedEvent
	| AttemptFinishedEvent
	| TargetFinishedEvent
	| BatchFinishedEvent
	| FatalErrorEvent;

/** Request sent on stdin. outputDir is plumbing the tool owns, never a model parameter. */
export interface HelperRequest {
	protocolVersion: number;
	batchId: string;
	outputDir: string;
	targets: Array<{ id: string; url: string; selector?: string }>;
	/** 0..32 browser subrequest domains. Never the target's own host. */
	blockedDomains?: string[];
	/** Regex matched against browser background fetch/XHR response URLs. */
	captureXhr?: string;
}

export const EVENT_TYPES = ["batch_started", "attempt_finished", "target_finished", "batch_finished", "fatal_error"] as const;

/**
 * Strictly validate one stdout line as a protocol event. Returns the parsed
 * event, or null when the line is blank, or throws with a precise reason when
 * the line is non-protocol data (which must fail the whole call).
 */
export function parseHelperEvent(line: string): HelperEvent | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		throw new ProtocolError(`helper stdout line is not JSON: ${shortText(trimmed, 120, 12)}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ProtocolError("helper stdout line is not a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.protocolVersion !== PROTOCOL_VERSION) {
		throw new ProtocolError(`helper event protocolVersion ${JSON.stringify(obj.protocolVersion)} != ${PROTOCOL_VERSION}`);
	}
	const type = obj.type;
	if (typeof type !== "string" || type === "" || !(EVENT_TYPES as readonly string[]).includes(type)) {
		throw new ProtocolError(`helper stdout line has unknown event type ${JSON.stringify(type)}`);
	}
	const batchId = obj.batchId;
	if (type === "fatal_error") {
		// Pre-batch failures (before the helper knows the batchId) may carry
		// null; the real reason must still surface to the tool.
		if (batchId !== null && (typeof batchId !== "string" || batchId.length === 0)) {
			throw new ProtocolError(`helper fatal_error event has an invalid batchId`);
		}
	} else if (typeof batchId !== "string" || batchId.length === 0) {
		throw new ProtocolError(`helper ${type} event has no batchId`);
	}
	return obj as unknown as HelperEvent;
}

/** Check a batchId against the batch we spawned; a wrong id is a protocol failure. */
export function assertBatchId(event: HelperEvent, batchId: string): void {
	if (event.type === "fatal_error" && event.batchId === null) return;
	if (event.batchId !== batchId) {
		throw new ProtocolError(`helper event batchId ${JSON.stringify(event.batchId)} != ${JSON.stringify(batchId)}`);
	}
}

export class ProtocolError extends Error {}

/**
 * Remove ANSI escape sequences and control bytes from untrusted text
 * (model-supplied URLs, server reason phrases, helper error text) before it
 * is stored in a result or painted in the transcript.
 */
export function stripControlSequences(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function shortText(text: string, max: number, tail = 0): string {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.max(0, max - tail));
	const postfix = tail > 0 ? `…${text.slice(-tail)}` : "…";
	return head + postfix;
}

export function newBatchId(): string {
	const random = Math.random().toString(16).slice(2, 10);
	return `b-${Date.now().toString(16)}-${random}`;
}

/**
 * Ladder facts for one page, derived only from the real attempt records.
 * Returns null when the target never escalated. An escalation is a blocked
 * rung, an empty-extraction rung (RV-1), or a transport failure (RV-2).
 * `recovered` is true when the final attempt was itself clean (a cleared
 * wall, even when the page is later judged unusable, e.g. a banned
 * subreddit).
 */
export function pageLadder(page: PageRecord, attempts: AttemptRecord[]): {
	firstStatus: number | null;
	firstTier: string;
	finalTier: string;
	recovered: boolean;
	firstKind: "blocked" | "empty" | "failed";
} | null {
	const own = attempts.filter((attempt) => attempt.targetId === page.targetId);
	const firstEscalation = own.find(
		(attempt) =>
			attempt.blockedSignal !== null ||
			attempt.unusableSignal !== null ||
			(attempt.status === null && attempt.reason !== null),
	);
	if (firstEscalation === undefined) return null;
	const last = own[own.length - 1];
	const firstKind: "blocked" | "empty" | "failed" =
		firstEscalation.blockedSignal !== null ? "blocked" : firstEscalation.unusableSignal !== null ? "empty" : "failed";
	return {
		firstStatus: firstEscalation.status,
		firstTier: firstEscalation.tier,
		finalTier: last?.tier ?? firstEscalation.tier,
		recovered:
			last !== undefined &&
			last.blockedSignal === null &&
			last.unusableSignal === null &&
			!(last.status === null && last.reason !== null),
		firstKind,
	};
}