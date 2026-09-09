import { it, expect, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, Component } from "@earendil-works/pi-tui";
import register from "../extensions/footer.js";

it("caches session totals across clock frames, reads auto state, and disposes every timer", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  try {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    register({ on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0 } };
    const entries = vi.fn(() => [{ type: "message", message: { role: "assistant", usage } }, { type: "message", message: { role: "toolResult", usage } }, { type: "compaction", usage }, { type: "branch_summary", usage }]);
    const contextUsage = vi.fn(() => ({ percent: null, contextWindow: 1000000 }));
    const paint = vi.fn();
    const unsubscribe = vi.fn();
    const branch = vi.fn(() => "main");
    let auto = true;
    let leaf = "turn";
    let component: (Component & { dispose?(): void }) | undefined;
    let patched = true;
    const ctx = {
      mode: "tui", cwd: "D:/fixture", model: { id: "model", reasoning: true }, thinkingLevel: "low",
      sessionManager: { getEntries: entries, getSessionId: () => "session", getLeafId: () => leaf }, getContextUsage: contextUsage, isIdle: () => false,
      ui: { setWidget: vi.fn(), setEditorComponent: vi.fn(), setWorkingVisible: vi.fn(),
        setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
          component = factory!({ requestRender: paint } as unknown as TUI, {} as Theme, {
            getGitBranch: branch, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
            onBranchChange: () => unsubscribe,
            ...(patched ? { remoticon: { version: 1, getState: () => ({ autoCompactionEnabled: auto }) } } : {}),
          });
        },
      },
    } as unknown as ExtensionContext;
    const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
    emit("session_start");
    expect(component!.render(100).join("\n")).toContain("↑4");
    emit("agent_start");
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 20; i++) component!.render(100);
    expect(entries).toHaveBeenCalledTimes(1);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    expect(branch).toHaveBeenCalledTimes(1);
    auto = false;
    expect(component!.render(100).join("\n")).toContain("auto off");
    emit("ui_prompt_start");
    const pausedPaints = paint.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(paint).toHaveBeenCalledTimes(pausedPaints);
    emit("ui_prompt_end");
    emit("tool_execution_start", { toolCallId: "bad" });
    emit("tool_execution_end", { toolCallId: "bad", isError: true });
    expect(vi.getTimerCount()).toBe(1);
    emit("turn_end");
    expect(entries).toHaveBeenCalledTimes(2);
    emit("agent_settled", { remoticonRetryStopped: true });
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("remoticon-finished", [expect.stringContaining("Stopped · 1.0s")]);
    expect(vi.getTimerCount()).toBe(0);
    expect(component!.render(100).join("\n")).toContain("Stopped");
    expect(component!.render(100)[0]).toContain("38;2;164;165;174m●");
    expect(entries).toHaveBeenCalledTimes(2);
    emit("agent_start");
    leaf = "next";
    emit("agent_settled");
    expect(entries).toHaveBeenCalledTimes(3);
    expect(component!.render(100)[0]).toContain("38;2;159;203;180m●");
    emit("agent_start");
    emit("session_shutdown");
    const stoppedPaints = paint.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(paint).toHaveBeenCalledTimes(stoppedPaints);
    component!.dispose?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    patched = false;
    emit("session_start");
    expect(component!.render(100).join("\n")).toContain("Remoticon UI patch unavailable");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
