/**
 * Model-visible fetch result assembly (spec 5.3) and the details receipt
 * (spec 5.4) built from batch_finished plus collected protocol events.
 * Bounds: 16 KiB per target, then 50 KiB / 2,000 lines total with a
 * truthful truncation notice and a sanitized temp path when truncated.
 */

import type { BatchFinishedEvent, HelperRequest, PageRecord } from "./protocol.js";
import type { AttemptRecord } from "./protocol.js";
import { pageLadder, stripControlSequences } from "./protocol.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export interface AssembledResult {
	text: string;
	totalTruncated: boolean;
}

function safeUrl(url: string): string {
	return stripControlSequences(url).replace(/\s+/g, " ");
}

function statusLabel(page: PageRecord): string {
	if (page.error !== null) return `error: ${page.error}`;
	if (page.deadEndReason !== null) return `dead end: ${page.deadEndReason}`;
	return page.usable ? "usable" : "retrieved but unusable";
}

function sectionFor(index: number, total: number, page: PageRecord, attempts: AttemptRecord[]): string {
	const status =
		page.finalStatus === null
			? "no response"
			: `${page.finalStatus} ${page.finalReason ?? ""}`.trim();
	const lines: string[] = [];
	const finalPart = page.finalUrl !== null && page.finalUrl !== page.requestedUrl ? ` (final ${safeUrl(page.finalUrl)})` : "";
	lines.push(`[${index}/${total}] ${safeUrl(page.requestedUrl)}${finalPart}`);
	const facts = [
		`status ${statusLabel(page)}`,
		`http ${status}`,
		`received ${page.receivedBytes !== null ? formatSize(page.receivedBytes) : "unknown"}`,
		`extracted ${page.extractedBytes !== null ? formatSize(page.extractedBytes) : "unknown"}`,
	];
	const ladder = pageLadder(page, attempts);
	if (ladder !== null && ladder.recovered) {
		const first =
			ladder.firstKind === "failed"
				? "failed"
				: ladder.firstKind === "empty"
					? `${ladder.firstStatus ?? "unknown"} (empty)`
					: ladder.firstStatus ?? "unknown";
		facts.push(`recovered: first ${first} (${ladder.firstTier}) -> final ${page.finalStatus ?? "unknown"} (${ladder.finalTier})`);
	}
	if (page.usedStealth) facts.push("stealth used");
	if (page.usedAdBlocking) facts.push(`ad/tracker blocking enabled${page.blockedDomainsCount > 0 ? ` + ${page.blockedDomainsCount} blocked domain(s)` : ""}`);
	lines.push(`  ${facts.join(" | ")}`);
	lines.push(`  selector: ${page.selector ? JSON.stringify(page.selector) + (page.selectorApplied ? " (applied)" : " (unapplied)") : "none"}`);
	if (page.content != null && page.content.length > 0) {
		lines.push("  sanitized markdown:");
		for (const line of page.content.split("\n")) lines.push(`  ${line}`);
	}
	if (page.capturedXhr !== null && page.capturedXhr !== undefined && page.capturedXhr.length > 0) {
		lines.push(`  captured xhr (${page.capturedXhr.length} response${page.capturedXhr.length === 1 ? "" : "s"}):`);
		for (const entry of page.capturedXhr) {
			lines.push(`    [${safeUrl(entry.url)}] (${entry.status ?? "no status"}, ${formatSize(entry.bytes)})`);
			if (entry.content) {
				for (const line of entry.content.split("\n")) lines.push(`      ${line}`);
			}
			if (entry.truncated) lines.push(`      [entry truncated for the model: ${formatSize(entry.bytes)} total]`);
		}
	}
	if (page.truncation !== null && page.truncation.truncated) {
		lines.push(`  [truncated for the model: kept ${formatSize(page.truncation.keptBytes)} of ${formatSize(page.truncation.totalBytes)}; full sanitized markdown saved to ${page.truncation.outputPath ?? "(path unavailable)"}]`);
	}
	return lines.join("\n");
}

export function summaryCounts(pages: PageRecord[]): string {
	const usable = pages.filter((page) => page.usable).length;
	const dead = pages.filter((page) => !page.usable && page.error === null && !page.cancelled).length;
	const failed = pages.filter((page) => !page.usable && page.error !== null).length;
	return `${usable} usable, ${dead} dead end${dead === 1 ? "" : "s"}, ${failed} failed`;
}

export function buildModelResult(batchFinished: BatchFinishedEvent, attempts: AttemptRecord[] = []): AssembledResult {
	const pages = batchFinished.pages;
	const header = `fetch: ${pages.length} target${pages.length === 1 ? "" : "s"} (${summaryCounts(pages)}) | browser mode: ${batchFinished.browserMode}`;
	const sections: string[] = [header];
	let index = 0;
	for (const page of pages) {
		index += 1;
		sections.push(sectionFor(index, pages.length, page, attempts));
	}
	sections.push(`batch stats: responses ${batchFinished.stats.requestCount} | blocks ${batchFinished.stats.blockedCount} | failed ${batchFinished.stats.failedCount}`);
	const joined = sections.join("\n\n");
	const bounded = truncateHead(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (bounded.truncated) {
		const notice = `[fetch output truncated for the model: ${bounded.outputLines} of ${bounded.totalLines} lines (${formatSize(bounded.outputBytes)} of ${formatSize(bounded.totalBytes)}) kept]`;
		return { text: `${bounded.content}\n${notice}`, totalTruncated: true };
	}
	return { text: joined, totalTruncated: false };
}

export function allTargetsFailed(pages: PageRecord[]): boolean {
	return pages.length > 0 && pages.every((page) => !page.usable);
}

export function firstFailureSummary(pages: PageRecord[]): string {
	const first = pages.find((page) => page.error !== null) ?? pages[0];
	if (first === undefined) return "no targets";
	if (first.error !== null) return safeUrl(first.requestedUrl);
	return `${safeUrl(first.requestedUrl)}: ${first.deadEndReason ?? "unusable"}`;
}

export interface FetchToolDetails {
	protocolVersion: number;
	batchId: string;
	browserMode: BatchFinishedEvent["browserMode"];
	globalConcurrency: number;
	perDomainConcurrency: number;
	autoThrottle: BatchFinishedEvent["autoThrottle"] | null;
	pages: PageRecord[];
	attempts: AttemptRecord[];
	stats: BatchFinishedEvent["stats"] | null;
	startedAt: number | null;
	completedAt: number | null;
	cancelled: boolean;
}

export function buildDetails(
	request: HelperRequest,
	batchStarted: { browserMode: BatchFinishedEvent["browserMode"]; globalConcurrency: number; perDomainConcurrency: number } | null,
	batchFinished: BatchFinishedEvent | null,
	attempts: AttemptRecord[],
	cancelled: boolean,
): FetchToolDetails {
	return {
		protocolVersion: request.protocolVersion,
		batchId: request.batchId,
		browserMode: batchFinished?.browserMode ?? batchStarted?.browserMode ?? "none",
		// The helper reports these in batch_started only (helper.py _emit_batch_started).
		globalConcurrency: batchStarted?.globalConcurrency ?? 4,
		perDomainConcurrency: batchStarted?.perDomainConcurrency ?? 2,
		autoThrottle: batchFinished?.autoThrottle ?? null,
		pages: batchFinished?.pages ?? [],
		attempts,
		stats: batchFinished?.stats ?? null,
		startedAt: null,
		completedAt: batchFinished?.completedAt ?? null,
		cancelled,
	};
}
