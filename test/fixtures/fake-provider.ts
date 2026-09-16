// Test-only fake model provider. NOT shipped in the pi-remoticon package —
// it lives under test/ and is loaded into pi per-run via `pi -e`, never from
// the product's extensions/ directory.
//
// Its whole job: give the Integration lane a provider that pi can select
// WITHOUT any real credentials or network, so no lane-1..3 test can ever reach
// a real (or metered, e.g. openrouter) model. At frame-zero pi never calls the
// model (a never-reached baseUrl is enough there); S4 needs a running turn to
// exercise the footer's working state, so streamSimple returns a canned reply
// carrying a fixed usage object — no network.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

// A turn's user message triggers a single tool call ONLY when it carries this
// token. Keeps the default (text-only) turn unchanged for every existing test;
// S1's box-death test opts in by putting the token in its message.
const TOOLCALL_TRIGGER = "RUNTOOL";

/** Trigger one read per latest RUNTOOL request; earlier tool results do not settle it. */
export function wantsToolCall(context?: Context): boolean {
  const messages = context?.messages ?? [];
  const userIndex = messages.map(m => m.role).lastIndexOf("user");
  if (messages.slice(userIndex + 1).some(m => m.role === "toolResult")) return false;
  const lastUser = messages[userIndex];
  const content = lastUser?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return text.includes(TOOLCALL_TRIGGER);
}

/** Register finite text/tool streams with abort handling and no network adapter. */
export default function (pi: ExtensionAPI) {
  // Keep native shell rendering but make the fixture independent of installed shells.
  pi.registerTool(createBashToolDefinition(process.cwd(), { operations: {
    async exec(command, _cwd, options) {
      if (!["echo restoration-fixture", "fixture-fail", "fixture-long"].includes(command)) throw new Error("Unsupported fixture command");
      if (options.signal?.aborted) throw new Error("aborted");
      if (command === "fixture-fail") throw new Error("Fixture command failed; continuing safely");
      if (command === "fixture-long") for (let i = 0; i < 120; i++) {
        options.onData(Buffer.from(`Fixture output ${i}: ${"read-only output ".repeat(20)}\n`));
        await delay(100, undefined, { signal: options.signal }).catch(error => {
          if (options.signal?.aborted) throw new Error("aborted");
          throw error;
        });
      }
      options.onData(Buffer.from("restoration-fixture\n"));
      return { exitCode: 0 };
    },
  } }));
  pi.registerProvider("fake", {
    name: "Fake (test)",
    baseUrl: "http://127.0.0.1:1", // unreachable on purpose; never hit at frame-zero
    apiKey: "unused",
    api: "openai-completions", // model.api for the canned reply; streamSimple bypasses the network
    // Canned stream: emit a tiny reply and a fixed usage (input + cacheRead
    // non-zero so CH% computes; output non-zero; cost 0 -> $0.000, per the
    // mockup working row). A deliberate hold before `done` keeps the working
    // state on screen long enough for the integration read to catch it.
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const out: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 127,
          output: 97,
          cacheRead: 6700,
          cacheWrite: 0,
          totalTokens: 6924,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      (async () => {
        try {
          options?.signal?.throwIfAborted();
          stream.push({ type: "start", partial: out });
          const latestUser = context?.messages.filter(message => message.role === "user").at(-1);
          const polish = JSON.stringify(latestUser?.content ?? "").includes("POLISH");
          const skillRun = JSON.stringify(latestUser?.content ?? "").includes("SKILLREAD");
          const restore = JSON.stringify(latestUser?.content ?? "").includes("RESTORE");
          const boundary = JSON.stringify(latestUser?.content ?? "").includes("BOUNDARY");
          const failure = JSON.stringify(latestUser?.content ?? "").includes("FAILURE");
          const long = JSON.stringify(latestUser?.content ?? "").includes("LONG");
          const groupRun = JSON.stringify(latestUser?.content ?? "").includes("GROUPTOOLS");
          const fetchBad = JSON.stringify(latestUser?.content ?? "").includes("FETCHBAD");
          const taskPlan = JSON.stringify(latestUser?.content ?? "").includes("TASKPLAN");
          const taskGo = JSON.stringify(latestUser?.content ?? "").includes("TASKGO");
          const latestIndex = context.messages.lastIndexOf(latestUser!);
          const toolCount = context.messages.slice(latestIndex + 1).filter(message => message.role === "toolResult").length;
          if ((polish || restore && toolCount === 0 || boundary && toolCount < 2) && !wantsToolCall(context)) {
            const thinking = { type: "thinking" as const, thinking: "" };
            out.content.push(thinking);
            stream.push({ type: "thinking_start", contentIndex: 0, partial: out });
            for (const delta of restore ? ["I need to separate animation timing from the work performed during each redraw. ", "I will check the footer and native transcript rendering path."] : ["Inspecting the fixture. ", "The stream remains incremental."]) {
              thinking.thinking += delta;
              stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: out });
              await delay(200, undefined, { signal: options?.signal });
            }
            stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: out });
          }
          if (fetchBad && toolCount === 0) {
            // One fetch call with a non-public scheme: rejected in TypeScript
            // before any Python spawn, so this stays an offline test.
            const toolCall = { type: "toolCall" as const, id: randomUUID(), name: "fetch", arguments: { targets: [{ url: "ftp://example.com/file" }] } };
            out.content.push(toolCall);
            const argsJson = JSON.stringify(toolCall.arguments);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: argsJson, partial: out });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: out });
            out.stopReason = "toolUse";
            stream.push({ type: "done", reason: out.stopReason, message: out });
            stream.end();
            return;
          }
          if (taskPlan && toolCount === 0) {
            // Three TaskCreate calls in one turn: the sidebar's empty slot becomes a
            // three-row list with a summary line.
            for (const n of [1, 2, 3]) {
              const toolCall = { type: "toolCall" as const, id: randomUUID(), name: "TaskCreate",
                arguments: { subject: `Sidebar task ${n}`, description: `Fixture task ${n}`, activeForm: `Working sidebar task ${n}` } };
              out.content.push(toolCall);
              const contentIndex = out.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex, partial: out });
              stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: out });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: out });
            }
            out.stopReason = "toolUse";
            stream.push({ type: "done", reason: out.stopReason, message: out });
            stream.end();
            return;
          }
          // On the TASKGO turn the user message is still the latest one, so toolCount starts at 0
          // and grows by one per emitted call: 0 -> in_progress, 1 -> completed.
          if (taskGo && (toolCount === 0 || toolCount === 1)) {
            // Hold the in_progress state for a moment: without it both updates land
            // inside one terminal render-throttle window and the spinner frame is
            // never painted, so nothing can observe the in-progress row.
            if (toolCount === 1) await delay(500, undefined, { signal: options?.signal });
            const args = toolCount === 0 ? { task_id: "1", status: "in_progress" } : { task_id: "1", status: "completed" };
            const toolCall = { type: "toolCall" as const, id: randomUUID(), name: "TaskUpdate", arguments: args };
            out.content.push(toolCall);
            const contentIndex = out.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: out });
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: out });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: out });
            out.stopReason = "toolUse";
            stream.push({ type: "done", reason: out.stopReason, message: out });
            stream.end();
            return;
          }
          if ((restore || skillRun) && toolCount === 0 || boundary && toolCount < 2 || failure && toolCount < 2) {
            if (restore) {
              const commentary = { type: "text" as const, text: "I'll inspect the footer and its rendering path." };
              out.content.push(commentary);
              stream.push({ type: "text_start", contentIndex: 1, partial: out });
              stream.push({ type: "text_delta", contentIndex: 1, delta: commentary.text, partial: out });
              stream.push({ type: "text_end", contentIndex: 1, content: commentary.text, partial: out });
            }
            const calls = skillRun ? [["read", { path: "package.json" }], ["read", { path: "sample-skill/SKILL.md" }], ["bash", { command: "echo restoration-fixture" }]] as const : restore ? [["read", { path: "package.json" }], ["read", { path: "fixture.txt" }], ["bash", { command: long ? "fixture-long" : "echo restoration-fixture" }]] as const : [["bash", { command: failure && toolCount === 0 ? "fixture-fail" : long ? "fixture-long" : "echo restoration-fixture" }]] as const;
            for (const [name, args] of calls) {
              const toolCall = { type: "toolCall" as const, id: randomUUID(), name, arguments: args };
              const contentIndex = out.content.length;
              out.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex, partial: out });
              stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: out });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: out });
            }
            out.stopReason = "toolUse";
            stream.push({ type: "done", reason: out.stopReason, message: out });
            stream.end();
            return;
          }
          if (wantsToolCall(context) || groupRun && toolCount < 2) {
            // One `read` call — read-only, OS-neutral, no shell. Renders a tool row
            // (the umbrella's ToolExecutionComponent) so the box-death theme change
            // can be checked against a real tool. pi executes it and re-invokes us.
            const toolCall = { type: "toolCall" as const, id: randomUUID(), name: "read", arguments: { path: "package.json" } };
            out.content.push(toolCall);
            const argsJson = JSON.stringify(toolCall.arguments);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: argsJson, partial: out });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: out });
            await delay(300, undefined, { signal: options?.signal });
            out.stopReason = "toolUse";
            stream.push({ type: "done", reason: out.stopReason, message: out });
            stream.end();
            return;
          }
          out.content.push({ type: "text", text: "" });
          const textIndex = out.content.length - 1;
          stream.push({ type: "text_start", contentIndex: textIndex, partial: out });
          const block = out.content[textIndex];
          if (block.type === "text") {
            const chunks = restore ? ["The footer needs a real animation lifecycle. ", "Keep its timing separate from usage calculations. Update those numbers when data changes, then let each animation frame change only the visual state.", "\n\nThe result should stay responsive while you type."] : polish ? ["A full-width answer arrives ", "while the draft remains editable. ", "Native Markdown keeps **bold text**, `code`, and wide characters 界 intact. ", "This paragraph continues across the available terminal width without a fixed reading column."] : ["ok"];
            for (const delta of chunks) {
              block.text += delta;
              stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: out });
              if (polish || restore) await delay(250, undefined, { signal: options?.signal });
            }
            stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: out });
          }
          await delay(300, undefined, { signal: options?.signal });
          out.stopReason = "stop";
          stream.push({ type: "done", reason: out.stopReason, message: out });
          stream.end();
          } catch (error) {
          out.stopReason = options?.signal?.aborted ? "aborted" : "error";
          out.errorMessage = options?.signal?.aborted ? "Stopped" : String(error);
          stream.push({ type: "error", reason: out.stopReason, error: out });
          stream.end();
        }
      })();
      return stream;
    },
    models: [
      {
        id: "fake-model",
        name: "Fake Model",
        reasoning: true, // so thinking-level UI (composer border, effort) has something to render
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 4096,
      },
    ],
  });
}
