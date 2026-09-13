import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  DEFAULT_HELPER_DEADLINE_MS, HelperCancelledError, HelperDeadlineError,
  helperScriptPath, resolveHelperInterpreter, runHelper,
} from "../lib/research/process.js";
import { PROTOCOL_VERSION, type HelperRequest } from "../lib/research/protocol.js";

const request = (batchId = "b-test"): HelperRequest => ({
  protocolVersion: PROTOCOL_VERSION,
  batchId,
  outputDir: ".",
  targets: [{ id: "t0", url: "https://example.com/" }],
});

const BATCH_STARTED = `emit({ type: "batch_started", startedAt: 1, browserMode: "none", globalConcurrency: 4, perDomainConcurrency: 2, maxBlockedRetries: 2, autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30000, blockBackoff: true }, targetCount: 1 });`;

/** A Node stand-in for helper.py: read the request, run the body, exit. */
function nodeHelper(body: string): ChildProcess {
  const script = [
    'let data = "";',
    'process.stdin.on("data", (chunk) => { data += chunk; });',
    'process.stdin.on("end", () => {',
    "  const request = JSON.parse(data);",
    '  const emit = (event) => process.stdout.write(JSON.stringify({ protocolVersion: request.protocolVersion, batchId: request.batchId, ...event }) + "\\n");',
    body,
    "});",
  ].join("\n");
  return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
}

describe("runHelper", () => {
  it("resolves the interpreter from PI_REMOTICON_PYTHON, else a PATH name", () => {
    const before = process.env.PI_REMOTICON_PYTHON;
    try {
      delete process.env.PI_REMOTICON_PYTHON;
      expect(resolveHelperInterpreter()).toBe(process.platform === "win32" ? "python" : "python3");
      process.env.PI_REMOTICON_PYTHON = "   /opt/scrapling/bin/python   ";
      expect(resolveHelperInterpreter()).toBe("/opt/scrapling/bin/python");
    } finally {
      if (before === undefined) delete process.env.PI_REMOTICON_PYTHON;
      else process.env.PI_REMOTICON_PYTHON = before;
    }
  });

  it("resolves helper.py next to the module", () => {
    const script = helperScriptPath();
    expect(script.endsWith("helper.py")).toBe(true);
    expect(existsSync(script)).toBe(true);
  });

  it("resolves a bounded batch and keeps the events", async () => {
    const run = runHelper(request(), undefined, undefined, () => nodeHelper([
      BATCH_STARTED,
      'emit({ type: "target_finished", page: {} });',
      'emit({ type: "batch_finished", completedAt: 2, browserMode: "none", autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30000, blockBackoff: true, observedDelays: {} }, stats: { blockedCount: 0, failedCount: 0, requestCount: 0 }, pages: [] });',
    ].join("\n")));
    const events = await run.completion;
    expect(events.map((event) => event.type)).toEqual(["batch_started", "target_finished", "batch_finished"]);
    expect(DEFAULT_HELPER_DEADLINE_MS).toBe(40_000);
    expect(await run.exitInfo).toEqual({ code: 0 });
  });

  it("surfaces a fatal_error with the helper's reason", async () => {
    const run = runHelper(request(), undefined, undefined, () => nodeHelper([
      'emit({ type: "fatal_error", batchId: null, error: "boom" });',
      "process.exit(1);",
    ].join("\n")));
    await expect(run.completion).rejects.toThrow(/fetch helper failed: boom/);
  });

  it("rejects a malformed stdout line", async () => {
    const run = runHelper(request(), undefined, undefined, () => nodeHelper([
      'process.stdout.write("not json\\n");',
      "setTimeout(() => {}, 30000);",
    ].join("\n")));
    await expect(run.completion).rejects.toThrow(/not JSON/);
  });

  it("stops at the deadline and keeps the events collected so far", async () => {
    const run = runHelper(request(), undefined, undefined, () => nodeHelper([
      BATCH_STARTED,
      "setTimeout(() => {}, 30000);",
    ].join("\n")), 100);
    const error = await run.completion.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HelperDeadlineError);
    expect((error as HelperDeadlineError).timeoutMs).toBe(100);
    expect((error as HelperDeadlineError).events.map((event) => event.type)).toEqual(["batch_started"]);
  });

  it("cancels the whole tree and settles once", async () => {
    const run = runHelper(request(), undefined, undefined, () => nodeHelper([
      BATCH_STARTED,
      "setTimeout(() => {}, 30000);",
    ].join("\n")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await run.cancel("test cancel reason");
    await expect(run.completion).rejects.toThrow(/test cancel reason/);
    await expect(run.completion).rejects.toBeInstanceOf(HelperCancelledError);
  });

  it("rejects when the abort signal fires", async () => {
    const controller = new AbortController();
    const run = runHelper(request(), controller.signal, undefined, () => nodeHelper([
      BATCH_STARTED,
      "setTimeout(() => {}, 30000);",
    ].join("\n")));
    controller.abort();
    await expect(run.completion).rejects.toBeInstanceOf(HelperCancelledError);
  });

  it("names PI_REMOTICON_PYTHON when the helper cannot start", async () => {
    const run = runHelper(request(), undefined, undefined, () => spawn("pi-remoticon-no-such-binary-xyz", []));
    await expect(run.completion).rejects.toThrow(/PI_REMOTICON_PYTHON.*scrapling==0\.4\.15/);
  });
});
