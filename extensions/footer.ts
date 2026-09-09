import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildFooterLines, type FooterUsage } from "../lib/footer-format.js";
import { Composer } from "../lib/composer.js";
import { RunState, dotColor, effortRank, rgb } from "../lib/ui-state.js";

interface Bridge { version: number; getState(): { autoCompactionEnabled: boolean } }

/** One owner for footer, editor, elapsed widget and the decoration clock. */
export default function (pi: ExtensionAPI) {
  let run = new RunState();
  let timer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  let refresh: ((ctx: ExtensionContext, onlyChanged?: boolean) => void) | undefined;
  let dispose: (() => void) | undefined;
  let rank = 0;
  let effort = "unknown";
  let frameSeconds = 0;
  const motion = process.env.PI_REMOTICON_MOTION !== "off";
  const stopClock = () => { if (timer) clearInterval(timer); timer = undefined; };
  const updateClock = () => {
    stopClock();
    frameSeconds = run.active ? run.seconds(performance.now()) : 0;
    if (render && motion && run.active && !run.waiting) timer = setInterval(() => {
      frameSeconds = run.seconds(performance.now());
      render?.();
    }, 50);
    render?.();
  };
  const selection = (ctx: ExtensionContext) => {
    effort = ctx.thinkingLevel ?? "unknown";
    rank = effortRank(ctx.model ? getSupportedThinkingLevels(ctx.model) : [], effort);
  };
  const finish = (ctx: ExtensionContext) => {
    if (!render || !run.active) return;
    const elapsed = run.seconds(performance.now());
    run.settle();
    updateClock();
    refresh?.(ctx, true);
    ctx.ui.setWidget("remoticon-finished", [rgb([164, 165, 174], `${run.outcome} · ${elapsed.toFixed(1)}s`)]);
  };

  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    run = new RunState();
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("remoticon-finished", undefined);
    selection(ctx);
    ctx.ui.setFooter((tui, _theme, provider) => {
      const bridge = (provider as typeof provider & { remoticon?: Bridge }).remoticon;
      if (bridge?.version !== 1 || typeof bridge.getState !== "function") {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setWorkingVisible(true);
        return { invalidate() {}, render: (width: number) => [truncateToWidth("Remoticon UI patch unavailable; run core-patch status for this installation", width, "")] };
      }
      let modelId = ctx.model?.id ?? "no-model";
      let cwd = ctx.cwd;
      let branch = provider.getGitBranch();
      let ctxPercent: number | null = null;
      let ctxWindow = 0;
      let usage: FooterUsage | null = null;
      let revision = 0;
      let cacheKey = "";
      let cached: string[] = [];
      let disposed = false;
      let refreshedSession = "";
      render = () => tui.requestRender();
      refresh = (current, onlyChanged = false) => {
        const sessionRevision = `${current.sessionManager.getSessionId()}/${current.sessionManager.getLeafId()}`;
        if (onlyChanged && sessionRevision === refreshedSession) return;
        refreshedSession = sessionRevision;
        modelId = current.model?.id ?? "no-model";
        cwd = current.cwd;
        const context = current.getContextUsage();
        ctxPercent = context?.percent ?? null;
        ctxWindow = context?.contextWindow ?? current.model?.contextWindow ?? 0;
        const totals: FooterUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let known = false;
        for (const entry of current.sessionManager.getEntries()) {
          const u = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage :
            (entry.type === "compaction" || entry.type === "branch_summary") ? entry.usage : undefined;
          if (!u) continue;
          known = true;
          totals.input += u.input;
          totals.output += u.output;
          totals.cacheRead += u.cacheRead;
          totals.cacheWrite += u.cacheWrite;
          totals.cost += u.cost.total;
        }
        usage = known ? totals : null;
        revision++;
        render?.();
      };
      const unsubscribe = provider.onBranchChange(() => { branch = provider.getGitBranch(); revision++; render?.(); });
      dispose = () => {
        if (disposed) return;
        disposed = true;
        stopClock(); unsubscribe(); render = undefined; refresh = undefined; dispose = undefined;
        ctx.ui.setWorkingVisible(true);
        ctx.ui.setEditorComponent(undefined);
      };
      refresh(ctx);
      ctx.ui.setEditorComponent((t, theme, keys) => {
        const editor = new Composer(t, theme, keys);
        editor.decoration = () => ({ rank, effort, seconds: frameSeconds, activity: run.activity, moving: motion && run.active && !run.waiting });
        return editor;
      });
      ctx.ui.setWorkingVisible(false);
      return {
        dispose,
        invalidate() { revision++; },
        render(width: number): string[] {
          const auto = bridge.getState().autoCompactionEnabled;
          const state = run.waiting ? "Waiting" : run.active ? run.activity : run.outcome === "Finished" ? "Ready" : run.outcome;
          const dot = run.active ? dotColor(frameSeconds, run.activity, motion && !run.waiting) :
            run.outcome === "Failed" ? [232, 152, 145] : run.outcome === "Stopped" ? [164, 165, 174] :
            run.started >= 0 ? [159, 203, 180] : [185, 165, 232];
          const key = `${width}/${revision}/${auto}/${state}/${dot.join(",")}`;
          if (key !== cacheKey) {
            cached = buildFooterLines({ modelId, cwd, branch, ctxPercent, ctxWindow, usage, auto, state, dot }, width);
            cacheKey = key;
          }
          return cached;
        },
      };
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!render) return;
    if (!run.active) ctx.ui.setWidget("remoticon-finished", undefined);
    run.start(performance.now());
    updateClock();
  });
  pi.on("message_start", (event) => { if (event.message.role === "assistant") run.outcome = "Finished"; });
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (type === "thinking_delta") run.activity = "Reasoning";
    if (type === "text_delta") run.activity = "Writing";
    render?.();
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "aborted") run.outcome = "Stopped";
    else if (event.message.stopReason === "error" || event.message.stopReason === "length") run.outcome = "Failed";
  });
  pi.on("tool_execution_start", (event) => { run.tools.add(event.toolCallId); run.activity = "Running tools"; render?.(); });
  pi.on("tool_execution_end", (event) => {
    run.tools.delete(event.toolCallId);
    if (run.activity === "Running tools" && !run.tools.size) run.activity = "Working";
    render?.();
  });
  pi.on("ui_prompt_start", () => { run.pause(performance.now()); updateClock(); });
  pi.on("ui_prompt_end", () => { run.resume(performance.now()); updateClock(); });
  pi.on("agent_settled", (event, ctx) => {
    if (!render) return;
    if ((event as typeof event & { remoticonRetryStopped?: boolean }).remoticonRetryStopped) run.outcome = "Stopped";
    finish(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    if (run.active && ctx.isIdle()) finish(ctx);
    else refresh?.(ctx);
  });
  pi.on("agent_end", (_event, ctx) => { if (ctx.isIdle()) finish(ctx); });
  pi.on("session_compact", (_event, ctx) => refresh?.(ctx));
  pi.on("session_tree", (_event, ctx) => refresh?.(ctx));
  pi.on("model_select", (_event, ctx) => { selection(ctx); refresh?.(ctx); });
  pi.on("thinking_level_select", (event, ctx) => { selection(ctx); effort = event.level; render?.(); });
  pi.on("session_shutdown", () => dispose?.());
}
