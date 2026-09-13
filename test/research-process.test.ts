import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  DEFAULT_HELPER_DEADLINE_MS, DEPENDENCY_PROBE, HelperCancelledError, HelperDeadlineError,
  discoveredInterpreterCandidates, helperScriptPath, resolveHelperInterpreter,
  resolveHelperInterpreterCached, scraplingInterpretersFromCondaEnvs, runHelper,
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
  it("uses the configured interpreter without probing, and otherwise probes candidates in order", () => {
    const before = process.env.PI_REMOTICON_PYTHON;
    try {
      process.env.PI_REMOTICON_PYTHON = "   /opt/scrapling/bin/python   ";
      expect(resolveHelperInterpreter(() => false, () => ["never-probed"])).toBe("/opt/scrapling/bin/python");

      delete process.env.PI_REMOTICON_PYTHON;
      const order = ["python-guess", "conda-scrapling"];
      expect(resolveHelperInterpreter((name) => name === "conda-scrapling", () => order)).toBe("conda-scrapling");
      expect(resolveHelperInterpreter((name) => name === "python-guess", () => order)).toBe("python-guess");
      // Nothing verified: the first candidate is returned so the spawn failure carries the install hint.
      expect(resolveHelperInterpreter(() => false, () => order)).toBe("python-guess");
    } finally {
      if (before === undefined) delete process.env.PI_REMOTICON_PYTHON;
      else process.env.PI_REMOTICON_PYTHON = before;
    }
  });

  it("offers PATH first, the default conda roots next and conda's list last", () => {
    const before = process.env.PI_REMOTICON_PYTHON;
    try {
      delete process.env.PI_REMOTICON_PYTHON;
      const list = [...discoveredInterpreterCandidates(() => ["conda-scrapling"])];
      expect(list[0]).toBe(process.platform === "win32" ? "python" : "python3");
      expect(list.at(-1)).toBe("conda-scrapling");
      if ((process.env.USERPROFILE ?? process.env.HOME ?? "") !== "") {
        expect(list.some((entry) => entry.includes("miniconda3"))).toBe(true);
        expect(list.some((entry) => entry.includes("anaconda3"))).toBe(true);
      }
    } finally {
      if (before === undefined) delete process.env.PI_REMOTICON_PYTHON;
      else process.env.PI_REMOTICON_PYTHON = before;
    }
  });

  it("keeps the dependency probe cheap and immune to PYTHONOPTIMIZE", () => {
    expect(DEPENDENCY_PROBE).toContain("find_spec");
    expect(DEPENDENCY_PROBE).toContain("sys.exit");
    expect(DEPENDENCY_PROBE).not.toContain("import scrapling");
  });

  it("probes once per process", () => {
    const before = process.env.PI_REMOTICON_PYTHON;
    let probes = 0;
    try {
      delete process.env.PI_REMOTICON_PYTHON;
      const probe = () => { probes += 1; return true; };
      expect(resolveHelperInterpreterCached(probe, () => ["first-candidate"])).toBe("first-candidate");
      expect(resolveHelperInterpreterCached(probe, () => ["second-candidate"])).toBe("first-candidate");
      expect(probes).toBe(1);
    } finally {
      if (before === undefined) delete process.env.PI_REMOTICON_PYTHON;
      else process.env.PI_REMOTICON_PYTHON = before;
    }
  });

  it("reads only scrapling-named environments from conda's list", () => {
    const json = JSON.stringify({ envs: ["C:\\Users\\x\\miniconda3", "C:\\Users\\x\\miniconda3\\envs\\scrapling", "/opt/conda/envs/not-scrapling", "/opt/conda/envs/scrapling"] });
    const found = scraplingInterpretersFromCondaEnvs(json);
    expect(found).toHaveLength(2);
    expect(found[0]!.endsWith(process.platform === "win32" ? "python.exe" : "python")).toBe(true);
    expect(found[1]!).toContain("scrapling");
    expect(scraplingInterpretersFromCondaEnvs("not json")).toEqual([]);
    expect(scraplingInterpretersFromCondaEnvs(JSON.stringify({ envs: "nope" }))).toEqual([]);
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
    await expect(run.completion).rejects.toThrow(/scrapling.*PI_REMOTICON_PYTHON/);
  });
});
