import { PROTOCOL_VERSION, type AttemptRecord, type BatchFinishedEvent, type PageRecord } from "../../lib/research/protocol.js";

export function page(over: Partial<PageRecord> = {}): PageRecord {
  return {
    targetId: "t0",
    requestedUrl: "https://example.com/",
    finalUrl: null,
    selector: null,
    selectorApplied: false,
    finalStatus: 200,
    finalReason: "OK",
    receivedBytes: 40_000,
    extractedBytes: 20_000,
    usedStealth: false,
    usedAdBlocking: false,
    blockedDomainsCount: 0,
    usable: true,
    deadEndReason: null,
    error: null,
    cancelled: false,
    content: "example body",
    capturedXhr: null,
    truncation: null,
    fullOutputPath: null,
    ...over,
  };
}

export function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    targetId: "t0",
    url: "https://example.com/",
    attempt: 1,
    tier: "http",
    status: 200,
    reason: "OK",
    receivedBytes: 40_000,
    latencyMs: 120,
    waitMs: null,
    retryAfterSeconds: null,
    blockedSignal: null,
    unusableSignal: null,
    startedAt: 1,
    completedAt: 2,
    ...over,
  };
}

export function batch(pages: PageRecord[], over: Partial<BatchFinishedEvent> = {}): BatchFinishedEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "batch_finished",
    batchId: "b-test",
    completedAt: 2,
    browserMode: "none",
    autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: {} },
    stats: { blockedCount: 0, failedCount: 0, requestCount: pages.length },
    pages,
    ...over,
  };
}
