// S3 + S4 — Custom single-line footer with an agent-state status dot.
//
// Replaces pi's default footer via ctx.ui.setFooter: a left cluster (dot, model,
// effort, context, working-state token/cache/cost clusters, provider) that grows
// left->right, and `cwd (branch)` pinned hard right. The leftmost dot is yellow
// at rest and green while a turn runs (INTENT.md:86-93; no animation).
//
// The old `🐴 ponytail: ⚡ FULL` row was a ctx.ui.setStatus (ponytail
// index.js:88) that pi's default footer rendered via getExtensionStatuses(). We
// do NOT render extension statuses here, so that row is gone by omission.
//
// All the string-shaping lives in the pure lib/footer-format.ts (unit-tested);
// this file only wires live pi data into it.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFooterLine, type FooterUsage } from "../lib/footer-format.js";

export default function (pi: ExtensionAPI) {
  // The dot's resting truth is ctx.isIdle() (INTENT.md:91), read live in render —
  // so an aborted/errored turn that skips agent_settled can't strand the dot
  // green; the next repaint self-corrects. The agent_start/agent_settled events
  // exist only to *trigger* that repaint when the state flips (isIdle changing
  // does not itself request a render). requestRender is captured from the footer
  // factory. Handlers are re-registered per session load (pi reloads the module).
  let requestRender: (() => void) | undefined;
  pi.on("agent_start", async () => requestRender?.());
  pi.on("agent_settled", async () => requestRender?.());

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const working = !ctx.isIdle();
          // Sum usage over the session branch (assistant messages only), as pi's
          // own custom-footer example does.
          let usage: FooterUsage | null = null;
          if (working) {
            let input = 0, output = 0, cacheRead = 0, cost = 0;
            for (const e of ctx.sessionManager.getBranch()) {
              if (e.type === "message" && e.message.role === "assistant") {
                const m = e.message as AssistantMessage;
                input += m.usage.input;
                output += m.usage.output;
                cacheRead += m.usage.cacheRead;
                cost += m.usage.cost.total;
              }
            }
            usage = { input, output, cacheRead, cost };
          }

          const ctxUsage = ctx.getContextUsage();
          return [
            buildFooterLine(theme, {
              working,
              modelId: ctx.model?.id ?? "no-model",
              provider: ctx.model?.provider ?? "",
              effort: ctx.thinkingLevel ?? "",
              // percent is null before the first response — show 0.0% then.
              ctxPercent: ctxUsage?.percent ?? 0,
              ctxWindow: ctx.model?.contextWindow ?? 0,
              usage,
              cwd: ctx.cwd,
              branch: footerData.getGitBranch(),
              showAuto: true, // v1: auto-compaction on by default (INTENT.md:73)
            }, width),
          ];
        },
      };
    });
  });
}
