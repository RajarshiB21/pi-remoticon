import { describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateResearchTools, FETCH_PARAMS, registerFetchTool } from "../lib/research/tool.js";

describe("fetch tool registration", () => {
  it("keeps the schema bounds the model sees", () => {
    expect(Value.Check(FETCH_PARAMS, { targets: [{ url: "https://example.com/" }] })).toBe(true);
    expect(Value.Check(FETCH_PARAMS, { targets: [] })).toBe(false);
    expect(Value.Check(FETCH_PARAMS, { targets: Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}` })) })).toBe(false);
    expect(Value.Check(FETCH_PARAMS, {
      targets: [{ url: "https://example.com/" }],
      blockedDomains: Array.from({ length: 33 }, (_, i) => `d${i}.example.com`),
    })).toBe(false);
  });

  it("adds fetch to the active set once", () => {
    let active = ["read", "bash"];
    const pi = {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI;
    activateResearchTools(pi);
    activateResearchTools(pi);
    expect(active).toEqual(["read", "bash", "fetch"]);
  });
});

/** A Node stand-in for helper.py that emits a fixed batch, exactly as the real one does. */
function helperEmitting(events: string[], linger = false): ChildProcess {
  const script = [
    'let data = "";',
    'process.stdin.on("data", (chunk) => { data += chunk; });',
    'process.stdin.on("end", () => {',
    "  const request = JSON.parse(data);",
    '  const emit = (event) => process.stdout.write(JSON.stringify({ protocolVersion: request.protocolVersion, batchId: request.batchId, ...event }) + "\\n");',
    ...events,
    ...(linger ? ["  setInterval(() => {}, 1000);"] : []),
    "});",
  ].join("\n");
  return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
}

const BATCH_STARTED = `emit({ type: "batch_started", startedAt: 1000, browserMode: "local", globalConcurrency: 4, perDomainConcurrency: 2, maxBlockedRetries: 2, autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30000, blockBackoff: true }, targetCount: 1 });`;
const ATTEMPT = `emit({ type: "attempt_finished", attempt: { targetId: "t0", url: "https://example.com/", attempt: 1, tier: "http", status: 200, reason: "OK", receivedBytes: 40, latencyMs: 120, waitMs: null, retryAfterSeconds: null, blockedSignal: null, unusableSignal: null, startedAt: 1100, completedAt: 1220 } });`;
const PAGE = `emit({ type: "target_finished", page: { targetId: "t0", requestedUrl: "https://example.com/", finalUrl: null, selector: null, selectorApplied: false, finalStatus: 200, finalReason: "OK", receivedBytes: 40, extractedBytes: 20, usedStealth: false, usedAdBlocking: false, blockedDomainsCount: 0, usable: true, deadEndReason: null, error: null, cancelled: false, content: "body", capturedXhr: null, truncation: null, fullOutputPath: null } });`;
const BATCH_FINISHED = `emit({ type: "batch_finished", completedAt: 9000, browserMode: "local", autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30000, blockBackoff: true, observedDelays: { "example.com": 1200 } }, stats: { blockedCount: 0, failedCount: 0, requestCount: 1 }, pages: [{ targetId: "t0", requestedUrl: "https://example.com/", finalUrl: null, selector: null, selectorApplied: false, finalStatus: 200, finalReason: "OK", receivedBytes: 40, extractedBytes: 20, usedStealth: false, usedAdBlocking: false, blockedDomainsCount: 0, usable: true, deadEndReason: null, error: null, cancelled: false, content: null, capturedXhr: null, truncation: null, fullOutputPath: null }], resources: { peakRssBytes: null, elapsedMs: 8000 } });`;

function definitionWith(events: string[], hooks: { spawnForTest?: () => ChildProcess; deadlineMs?: number } = {}) {
  let definition: { execute: (...args: never[]) => Promise<unknown> } | undefined;
  const pi = {
    registerTool: (value: unknown) => { definition = value as never; },
    on: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;
  registerFetchTool(pi, { spawnForTest: hooks.spawnForTest ?? (() => helperEmitting(events)), deadlineMs: hooks.deadlineMs });
  if (definition === undefined) throw new Error("fetch tool was not registered");
  return definition as unknown as {
    execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: (update: { details: unknown }) => void): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };
}

describe("fetch payload", () => {
  it("carries the facts the tree paints, live and settled", async () => {
    const tool = definitionWith([BATCH_STARTED, ATTEMPT, PAGE, BATCH_FINISHED]);
    const updates: Record<string, unknown>[] = [];
    const result = await tool.execute("call-1", { targets: [{ url: "https://example.com/" }] }, undefined, (update) => {
      updates.push(update.details as Record<string, unknown>);
    });

    expect(updates.length).toBeGreaterThan(0);
    const first = updates[0]!;
    expect(first.inlineBody).toBe(true);
    expect(first.startedAt).toBe(1000);
    expect(first.maxBlockedRetries).toBe(2);
    expect(first.browserMode).toBe("local");
    expect(first.attempts).toHaveLength(0);
    expect(first.live).toEqual([{ targetId: "t0", requestedUrl: "https://example.com/", settled: false, kind: "pending" }]);

    const last = updates[updates.length - 1]!;
    expect(last.attempts).toHaveLength(1);
    expect(last.live).toEqual([{ targetId: "t0", requestedUrl: "https://example.com/", settled: true, kind: "ok" }]);
    expect((last.pages as unknown[])).toHaveLength(1);

    expect(result.details.inlineBody).toBe(true);
    expect(result.details.startedAt).toBe(1000);
    expect(result.details.completedAt).toBe(9000);
    expect(result.details.maxBlockedRetries).toBe(2);
  }, 30000);

  it("keeps the tree painted, with its settled lanes, when the call is cancelled", async () => {
    const tool = definitionWith([], { spawnForTest: () => helperEmitting([BATCH_STARTED, ATTEMPT, PAGE], true) });
    const controller = new AbortController();
    let settledPages = 0;
    const pending = tool.execute("call-3", { targets: [{ url: "https://example.com/" }] }, controller.signal, (update) => {
      settledPages = ((update.details as { pages?: unknown[] }).pages ?? []).length;
    });
    await vi.waitFor(() => { if (settledPages === 0) throw new Error("waiting for the settled page"); }, { timeout: 15000 });
    controller.abort();
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.details.inlineBody).toBe(true);
    expect(result.details.startedAt).toBe(1000);
    expect((result.details.pages as unknown[])).toHaveLength(1);
    expect((result.details.attempts as unknown[])).toHaveLength(1);
    expect(result.details.groupSummary).toMatch(/^Fetch cancelled after |^Fetch cancelled$/);
  }, 30000);

  it("throws when the deadline arrives before any batch started", async () => {
    const tool = definitionWith([], { spawnForTest: () => helperEmitting([], true), deadlineMs: 60 });
    await expect(tool.execute("call-4", { targets: [{ url: "https://example.com/" }] }, undefined, () => undefined))
      .rejects.toThrow(/gave up after/);
  }, 30000);

  it("returns the tree when the deadline arrived after the batch started", async () => {
    // The helper here is a real process, so its boot has to fit inside the deadline:
    // at 60ms a loaded runner rejected before the batch started and the assertions
    // below never ran. The process-level deadline test uses the same 2s margin.
    const tool = definitionWith([], { spawnForTest: () => helperEmitting([BATCH_STARTED], true), deadlineMs: 2_000 });
    const result = await tool.execute("call-5", { targets: [{ url: "https://example.com/" }] }, undefined, () => undefined);
    const pages = result.details.pages as { error: string | null }[];
    expect(result.details.startedAt).toBe(1000);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.error).toMatch(/never arrived within/);
    expect(result.details.inlineBody).toBe(true);
  }, 30000);

  it("returns the tree's details when the batch completed and nothing was usable", async () => {
    const failing = [
      BATCH_STARTED,
      `emit({ type: "attempt_finished", attempt: { targetId: "t0", url: "https://example.com/", attempt: 1, tier: "http", status: null, reason: "connection reset", receivedBytes: null, latencyMs: 30, waitMs: null, retryAfterSeconds: null, blockedSignal: null, unusableSignal: null, startedAt: 1100, completedAt: 1130 } });`,
      `emit({ type: "target_finished", page: { targetId: "t0", requestedUrl: "https://example.com/", finalUrl: null, selector: null, selectorApplied: false, finalStatus: null, finalReason: null, receivedBytes: null, extractedBytes: null, usedStealth: false, usedAdBlocking: false, blockedDomainsCount: 0, usable: false, deadEndReason: null, error: "connection reset", cancelled: false, content: null, capturedXhr: null, truncation: null, fullOutputPath: null } });`,
      `emit({ type: "batch_finished", completedAt: 9000, browserMode: "none", autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30000, blockBackoff: true, observedDelays: {} }, stats: { blockedCount: 0, failedCount: 1, requestCount: 1 }, pages: [{ targetId: "t0", requestedUrl: "https://example.com/", finalUrl: null, selector: null, selectorApplied: false, finalStatus: null, finalReason: null, receivedBytes: null, extractedBytes: null, usedStealth: false, usedAdBlocking: false, blockedDomainsCount: 0, usable: false, deadEndReason: null, error: "connection reset", cancelled: false, content: null, capturedXhr: null, truncation: null, fullOutputPath: null }], resources: { peakRssBytes: null, elapsedMs: 8000 } });`,
    ];
    const tool = definitionWith(failing);
    const result = await tool.execute("call-2", { targets: [{ url: "https://example.com/" }] }, undefined, () => undefined);
    const pages = result.details.pages as { usable: boolean }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]!.usable).toBe(false);
    expect(result.details.inlineBody).toBe(true);
    expect(result.content[0]!.text).toContain("0 usable");
  }, 30000);
});
