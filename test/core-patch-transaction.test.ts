import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Container, Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { transact, runCorePatch, readBundle } from "../scripts/apply-core-patch.js";
import { STATE_DIR, sha256, planEdits, PATCHES, type Edit } from "../scripts/core-patch-plan.js";
import { makePiCopy } from "./helpers/patch-harness.js";

/** Exercise multi-file replacement on tiny owned files, then remove the fixture. */
function fixture(run: (target: string, edits: Edit[]) => void): void {
  const target = mkdtempSync(join(tmpdir(), "remoticon-transaction-"));
  const edits = ["a.js", "b.js", "c.js"].map((path, index) => ({ path, original: `const value = ${index};\n`, patched: `const value = ${index + 1};\n` }));
  for (const edit of edits) writeFileSync(join(target, edit.path), edit.original);
  try { run(target, edits); } finally { rmSync(target, { recursive: true, force: true }); }
}

describe("S0 filesystem transaction", () => {
  it("recovers a disposable installation and exercises its patched native tool event path", async () => {
    const copy = makePiCopy();
    try {
      expect(runCorePatch("check", copy.pkgDir).state).toBe("pristine");
      expect(existsSync(join(copy.pkgDir, STATE_DIR))).toBe(false);
      transact(copy.pkgDir, planEdits(readBundle(copy.pkgDir), [PATCHES[0]]), "apply", sha256("S0 source"));
      expect(runCorePatch("status", copy.pkgDir).state).toBe("older managed");
      expect(runCorePatch("apply", copy.pkgDir).state).toBe("current managed");
      const path = join(copy.pkgDir, STATE_DIR, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      await assertPatchedToolFlow(join(copy.pkgDir, manifest.files[0].path));
      manifest.phase = "applying";
      writeFileSync(path, JSON.stringify(manifest));
      expect(runCorePatch("status", copy.pkgDir).state).toBe("interrupted managed");
      expect(() => runCorePatch("apply", copy.pkgDir)).toThrow(/restore/);
      expect(runCorePatch("restore", copy.pkgDir).state).toBe("pristine");
      expect(runCorePatch("apply", copy.pkgDir).state).toBe("current managed");
    } finally { copy.cleanup(); }
  }, 20000);

  it("stages, saves durable originals, applies and restores exact bytes without touching neighboring files", () => fixture((target, edits) => {
    writeFileSync(join(target, "auth.json"), "untouched");
    transact(target, edits, "apply", sha256("source"));
    for (const edit of edits) {
      expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.patched);
      expect(readFileSync(join(target, STATE_DIR, "backups", `${edit.path}.original`), "utf8")).toBe(edit.original);
    }
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("applied");
    transact(target, edits, "restore", sha256("source"));
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("untouched");
  }));

  it("rolls back every replaced file when a later replacement fails", () => fixture((target, edits) => {
    let calls = 0;
    expect(() => transact(target, edits, "apply", sha256("source"), (from, to) => {
      if (++calls === 3) throw new Error("injected third replacement failure");
      renameSync(from, to);
    })).toThrow(/rollback verified/);
    expect(calls).toBe(5);
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("restored");
  }));

  it("reports a failed rollback individually, attempts the others, and leaves a detectable recovery phase", () => fixture((target, edits) => {
    let calls = 0;
    expect(() => transact(target, edits, "apply", sha256("source"), (from, to) => {
      calls++;
      if (calls === 3 || calls === 4) throw new Error("injected failure");
      renameSync(from, to);
    })).toThrow(/rollback failures: a.js/);
    expect(calls).toBe(5);
    expect(readFileSync(join(target, "a.js"), "utf8")).toBe(edits[0].patched);
    expect(readFileSync(join(target, "b.js"), "utf8")).toBe(edits[1].original);
    expect(JSON.parse(readFileSync(join(target, STATE_DIR, "manifest.json"), "utf8")).phase).toBe("rollback-failed");
    transact(target, edits, "restore", sha256("source"));
    for (const edit of edits) expect(readFileSync(join(target, edit.path), "utf8")).toBe(edit.original);
  }));

  it("rejects unknown current/backup bytes and duplicate plans before writes; syntax failure leaves installed files intact", () => fixture((target, edits) => {
    expect(() => transact(target, [edits[0], edits[0]], "apply", sha256("source"))).toThrow(/duplicate/);
    writeFileSync(join(target, "c.js"), "unknown bytes");
    expect(() => transact(target, edits, "restore", sha256("source"))).toThrow(/Unknown edits/);
    expect(existsSync(join(target, STATE_DIR))).toBe(false);
    writeFileSync(join(target, "c.js"), edits[2].original);
    expect(() => transact(target, [{ ...edits[0], patched: "const = ;" }], "apply", sha256("source"))).toThrow(/no installed files replaced/);
    expect(readFileSync(join(target, "a.js"), "utf8")).toBe(edits[0].original);
    const backup = join(target, STATE_DIR, "backups");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "a.js.original"), "unknown backup");
    expect(() => transact(target, edits, "apply", sha256("source"))).toThrow(/Changed backup/);
  }));
});

/** Reuse the recovery copy to exercise the actual injected handler and observer. */
async function assertPatchedToolFlow(chunk: string): Promise<void> {
  const native = await import(pathToFileURL(chunk).href);
  native.initTheme("dark", false);
  const setup = () => Object.assign(Object.create(native.InteractiveMode.prototype), {
    isInitialized: true, footer: { invalidate() {} }, ui: { requestRender() {} },
    runtimeHost: { session: { settingsManager: { getShowImages: () => false, getImageWidthCells: () => 30 }, sessionManager: { getCwd: () => process.cwd() } } },
    getRegisteredToolDefinition: () => ({ renderCall: () => new Text("native call", 0, 0), renderResult: () => new Text("native result", 0, 0) }),
    toolOutputExpanded: false, pendingTools: new Map(), chatContainer: new Container(),
    checkShutdownRequested: async () => {},
  });
  const start = (owner: ReturnType<typeof setup>, id: string) => owner.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} });
  const plain = (component: Container) => component.render(90).map(stripVTControlCharacters).join("\n");
  for (const [state, expected] of [["pending", "1 read pending"], ["done", "1 read"], ["failed", "1 failed"], ["stopped", "1 stopped"]] as const) {
    const owner = setup();
    await start(owner, state);
    const row = owner.pendingTools.get(state);
    const group = owner.chatContainer.children[0];
    expect(row, state).toBeInstanceOf(native.ToolExecutionComponent);
    expect(group.entries[0].row, state).toBe(row);
    await owner.handleEvent({ type: "tool_execution_update", toolCallId: state, partialResult: { content: [{ type: "text", text: "partial" }] } });
    if (state === "done" || state === "failed") await owner.handleEvent({ type: "tool_execution_end", toolCallId: state, isError: state === "failed", result: { content: [{ type: "text", text: state === "failed" ? "broken input" : "ok" }] } });
    if (state === "stopped") await owner.handleEvent({ type: "agent_settled" });
    expect(plain(group), state).toContain(expected);
    if (state === "failed") expect(plain(group)).toContain("broken input");
    if (state === "done" || state === "failed") expect(owner.pendingTools.has(state)).toBe(false);
  }
  const owner = setup();
  const first = new native.AssistantMessageComponent(undefined, false, native.getMarkdownTheme());
  owner.chatContainer.addChild(first);
  await start(owner, "first");
  const originalFirst = owner.pendingTools.get("first");
  const second = new native.AssistantMessageComponent(undefined, false, native.getMarkdownTheme());
  owner.chatContainer.addChild(second);
  await start(owner, "second");
  const originalSecond = owner.pendingTools.get("second");
  const group = owner.chatContainer.children[1];
  expect(group.entries.map((entry: { row: unknown }) => entry.row)).toEqual([originalFirst, originalSecond]);
  second.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "Late reasoning" }], stopReason: "pending" }, true);
  const split = owner.chatContainer.children[owner.chatContainer.children.indexOf(second) + 1];
  expect(split.entries[0].row).toBe(owner.pendingTools.get("second"));
  expect(group.entries[0].row).toBe(owner.pendingTools.get("first"));
  await owner.handleEvent({ type: "tool_execution_end", toolCallId: "second", isError: true, result: { content: [{ type: "text", text: "failed then continued" }] } });
  await start(owner, "retry");
  expect(split.entries.map((entry: { row: unknown }) => entry.row)).toEqual([originalSecond, owner.pendingTools.get("retry")]);
  expect(plain(split)).toContain("1 failed");
  expect(plain(split)).toContain("1 read pending");
  expect(owner.pendingTools.get("first")).toBe(originalFirst);
}
