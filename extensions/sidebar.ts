// Remoticon sidebar: TASKS slot, task tools, reminders, /sidebar command, lifecycle.
// Borrowed mechanics are attributed in each lib/sidebar file; this entry wires them.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makePainter, type Painter } from "../lib/sidebar/paint.js";
import { composeColumn, makeTasksSlot, type Slot } from "../lib/sidebar/panels.js";
import { createSplitController, type SplitController } from "../lib/sidebar/split.js";
import { loadConfig, saveGlobalSideFlag, saveGlobalWidth, projectOverrideActive } from "../lib/sidebar/config.js";
import { TaskStore } from "../lib/sidebar/tasks/store.js";
import { reclaimSessionTasksDir, sessionTaskFile } from "../lib/sidebar/tasks/paths.js";
import { registerTaskTools, TASK_TOOL_NAMES } from "../lib/sidebar/tasks/tools.js";
import { resolveGlyphs } from "../lib/sidebar/tasks/glyphs.js";
import {
  createCadenceState, onTurnStart, evaluateToolResult, drainReminderForContext,
  buildSystemReminder, AutoClearManager, REMINDER_INTERVAL, ACTIVE_REMINDER_INTERVAL, EMPTY_LIST_NUDGE_TURNS,
} from "../lib/sidebar/tasks/reminders.js";
import type { Task, TaskStatus } from "../lib/sidebar/tasks/types.js";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const motion = process.env.PI_REMOTICON_MOTION !== "off";
  let cfg = loadConfig(agentDir);
  /** Captured when the session's config is loaded, not re-derived per command: `/sidebar`
   *  mutates `cfg`, so re-deriving it later would report "no override" the moment the user
   *  ran `/sidebar on|off|width` — the exact case where the note matters most, because the
   *  project file will still win on the next session. */
  let projectOverride = false;
  let store = new TaskStore();
  let cadence = createCadenceState();
  let autoClear = new AutoClearManager(() => store, () => cfg.tasks.autoClear);
  let tasks: readonly Task[] = [];
  let split: SplitController | undefined;
  let requestRender: (() => void) | undefined;
  let closeOverlay: (() => void) | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let slots: Slot[] = [];

  const refresh = () => { tasks = store.list(); };
  const changed = () => { refresh(); requestRender?.(); syncSpinner(); };
  let painterTheme: unknown;
  let cachedPainter: Painter | undefined;
  /** One painter per theme. `makePainter` reports an unknown role once per instance, and the
   *  painter is built inside `render` — a fresh one each frame would repeat that toast on every
   *  repaint, and the spinner repaints every 150 ms while a task is in progress. */
  const painterFor = (ctx: ExtensionContext): Painter => {
    if (!cachedPainter || painterTheme !== ctx.ui.theme) {
      painterTheme = ctx.ui.theme;
      cachedPainter = makePainter(ctx.ui.theme,
        role => ctx.ui.notify(`Theme has no "${role}" color; sidebar falls back to text`, "warning"));
    }
    return cachedPainter;
  };
  const syncSpinner = () => {
    const running = tasks.some(t => t.status === "in_progress");
    if (motion && running && requestRender && !spinnerTimer) {
      spinnerTimer = setInterval(() => requestRender?.(), 150);
      spinnerTimer.unref?.();
    } else if ((!running || !motion || !requestRender) && spinnerTimer) {
      clearInterval(spinnerTimer); spinnerTimer = undefined;
    }
  };
  const buildSlots = () => {
    const glyphs = resolveGlyphs(cfg.tasks.glyphs);
    // motion off freezes the spinner on frame 0: the slot's clock stops at t=0
    slots = [makeTasksSlot(motion ? () => Date.now() : () => 0, () => tasks, glyphs, () => cfg.sidebar.width)];
  };

  let configuredCwd: string | undefined;
  function repointStore(ctx: ExtensionContext, event?: { reason: string }) {
    configuredCwd = ctx.cwd;
    const parentSnapshot = event?.reason === "fork" ? store.snapshot() : undefined;
    const sessionId = ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionId() : undefined;
    store = new TaskStore(sessionId ? sessionTaskFile(agentDir, ctx.cwd, sessionId) : undefined);
    const loaded = store.list();
    // A finished list from a previous session must not sit on screen, so the startup rule
    // clears it before anything is shown. The toast then has to report what SURVIVED that
    // clear, not what the file happened to hold — otherwise it announces tasks the user
    // cannot see, next to a panel reading "No tasks".
    if ((event?.reason === "startup" || event?.reason === "new") && loaded.length > 0
      && loaded.every(t => t.status === "completed")) store.clearCompleted();
    if (parentSnapshot) store.seed(parentSnapshot);
    refresh();
    if (tasks.length > 0 && event?.reason !== "reload") ctx.ui.notify(`Restored ${tasks.length} persisted task${tasks.length === 1 ? "" : "s"}`, "info");
  }

  registerTaskTools(pi, () => store, changed, {
    beforeCreate: () => autoClear.startNewBatch(),
    afterUpdate: (id: string, fields: { status?: TaskStatus }) => {
      if (fields.status === "completed") autoClear.trackCompletion(id, cadence.currentTurn);
      else if (fields.status !== undefined) autoClear.resetBatchCountdown();
    },
  });

  function showSidebar(ctx: ExtensionContext): void {
    if (split) return;
    split = createSplitController({
      width: cfg.sidebar.width,
      onError: e => ctx.ui.notify(`Sidebar column unavailable: ${String(e)}`, "error"),
    });
    void ctx.ui.custom<string | null>(tui => {
      requestRender = () => tui.requestRender();
      split?.attach(tui);
      split?.show();                                   // the column's visibility predicate reads `enabled`
      const rowHeight = () => tui.terminal.rows;
      syncSpinner();
      return {
        render(width: number) {
          void width;                                   // the column owns its width; pi paints rows
          return composeColumn(painterFor(ctx), slots, rowHeight(), cfg.sidebar.width);
        },
        invalidate() {},
      };
    }, {
      overlay: true,
      overlayOptions: () => split?.overlayOptions() ?? {},
      // Removal is by identity via the handle, and the factory's `done` is deliberately not
      // retained: for an overlay pi drives `done` into `ui.hideOverlay()`, which pops whatever
      // overlay is topmost, not ours. With a dialog open above this one that would close the
      // dialog and leave the sidebar. `handle.hide()` splices our own entry out and is a no-op
      // if it is already gone, so calling it twice (off, then shutdown) is safe.
      onHandle: handle => { closeOverlay = () => handle.hide(); },
    }).catch(e => ctx.ui.notify(`Sidebar failed: ${String(e)}`, "error"));
  }

  function hideSidebar(): void {
    closeOverlay?.(); closeOverlay = undefined;
    split?.dispose(); split = undefined;
    requestRender = undefined;
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = undefined; }
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    cfg = loadConfig(agentDir, ctx.cwd, ctx.isProjectTrusted(),
      path => ctx.ui.notify(`Ignoring invalid sidebar config: ${path}`, "warning"));
    projectOverride = projectOverrideActive(cfg, agentDir);
    cadence = createCadenceState();
    autoClear = new AutoClearManager(() => store, () => cfg.tasks.autoClear);
    repointStore(ctx, event);
    buildSlots();
    if (store.list().length === 0) { store.deleteFileIfEmpty(); reclaimSessionTasksDir(agentDir, ctx.cwd); }
    if (cfg.sidebar.on) showSidebar(ctx);
  });

  pi.on("session_shutdown", () => {
    hideSidebar();
  });

  pi.on("turn_start", (_e, ctx) => {
    onTurnStart(cadence);
    if (store.list().length > 0 && autoClear.onTurnStart(cadence.currentTurn)) {
      changed();
      if (store.list().length === 0) { store.deleteFileIfEmpty(); reclaimSessionTasksDir(agentDir, ctx.cwd); }
    }
    if (configuredCwd !== undefined && ctx.cwd !== configuredCwd) repointStore(ctx);   // workspace switched
  });
  pi.on("agent_settled", () => autoClear.onRunEnded());
  pi.on("turn_end", () => markDueIfStale(""));
  pi.on("tool_result", event => markDueIfStale(event.toolName));
  // The empty-list nudge rides this same cadence: v4 made it reachable for
  // batches that run long with no list at all.
  pi.on("context", event => {
    if (!drainReminderForContext(cadence)) return {};
    // pi REPLACES the message list with what a handler returns, so append to the current one.
    return {
      messages: [...event.messages, {
        role: "user" as const,
        content: [{ type: "text" as const, text: `<system-reminder>${buildSystemReminder(store.list())}</system-reminder>` }],
        timestamp: Date.now(),
      }],
    };
  });
  function markDueIfStale(toolName: string): void {
    const interval = tasks.some(t => t.status === "in_progress") ? ACTIVE_REMINDER_INTERVAL : REMINDER_INTERVAL;
    if (evaluateToolResult(cadence, toolName, tasks.length > 0, { reminderInterval: interval, emptyListNudgeTurns: EMPTY_LIST_NUDGE_TURNS, taskToolNames: TASK_TOOL_NAMES }).markDue)
      cadence.reminderDue = true;
  }

  pi.registerCommand("sidebar", {
    description: "Show, hide, resize or clear the Remoticon sidebar",
    handler: async (args, ctx) => {
      const [a, b] = args.trim().split(/\s+/).filter(Boolean);
      const override = projectOverride ? " \u00B7 project override active" : "";
      if (a === "on" || a === "off") {
        cfg.sidebar.on = a === "on";
        saveGlobalSideFlag(agentDir, a === "on");
        if (ctx.mode === "tui") {
          if (a === "off") hideSidebar();
          else showSidebar(ctx);                       // on shows immediately, exactly like off hides
        }
        ctx.ui.notify(`Sidebar ${a}${override}`, "info");
        return;
      }
      if (a === "width") {
        const w = Number(b);
        if (!Number.isInteger(w) || w < 28 || w > 60) { ctx.ui.notify("Usage: /sidebar width <28..60>", "warning"); return; }
        saveGlobalWidth(agentDir, w);
        cfg.sidebar.width = w;
        split?.rebuild(w);
        buildSlots();
        requestRender?.();
        ctx.ui.notify(`Sidebar width ${w}${override}`, "info");
        return;
      }
      if (a === "clear") {
        // The user's own escape hatch. Auto-clear never deletes an unfinished row, and the agent
        // cannot be relied on to retire one it abandoned, so without this the only way to get a
        // stray row off the screen is hiding the whole sidebar.
        const cleared = store.clearAll();
        changed();
        if (store.list().length === 0) { store.deleteFileIfEmpty(); reclaimSessionTasksDir(agentDir, ctx.cwd); }
        ctx.ui.notify(cleared === 0
          ? `Task list already empty${override}`
          : `Cleared ${cleared} task${cleared === 1 ? "" : "s"}${override}`, "info");
        return;
      }
      if (a === undefined) {
        const slotIds = (slots.length ? slots.map(s => s.id) : cfg.slots.map(s => s.id)).join(", ");
        ctx.ui.notify(`sidebar ${cfg.sidebar.on ? "on" : "off"} \u00B7 width ${cfg.sidebar.width} \u00B7 slots ${slotIds}${override}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /sidebar [on|off|clear|width <28..60>]", "warning");
    },
  });
}
