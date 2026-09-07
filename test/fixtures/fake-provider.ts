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
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";

// A turn's user message triggers a single tool call ONLY when it carries this
// token. Keeps the default (text-only) turn unchanged for every existing test;
// S1's box-death test opts in by putting the token in its message.
const TOOLCALL_TRIGGER = "RUNTOOL";

// Does this turn's context ask for — and not yet have — a tool call? The context
// carries the running conversation (StreamFunction = (model, context, options)).
// Turn 1: the user text holds the trigger and no toolResult exists yet -> emit an
// `ls` call. Turn 2: pi has run the tool and appended a toolResult -> fall through
// to plain text, so the agent settles instead of looping forever.
function wantsToolCall(context?: Context): boolean {
  const messages = context?.messages ?? [];
  if (messages.some((m) => m.role === "toolResult")) return false;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const content = lastUser?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return text.includes(TOOLCALL_TRIGGER);
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    name: "Fake (test)",
    baseUrl: "http://127.0.0.1:1", // unreachable on purpose; never hit at frame-zero
    apiKey: "unused",
    api: "openai-completions", // model.api for the canned reply; streamSimple bypasses the network
    // Canned stream: emit a tiny reply and a fixed usage (input + cacheRead
    // non-zero so CH% computes; output non-zero; cost 0 -> $0.000, per the
    // mockup working row). A deliberate hold before `done` keeps the working
    // state on screen long enough for the integration read to catch it.
    streamSimple: (model, context) => {
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
        stream.push({ type: "start", partial: out });
        if (wantsToolCall(context)) {
          // One `ls` call — read-only, OS-neutral, no shell. Renders a tool row
          // (the umbrella's ToolExecutionComponent) so the box-death theme change
          // can be checked against a real tool. pi executes it and re-invokes us.
          const toolCall = { type: "toolCall" as const, id: "call_1", name: "ls", arguments: { path: "." } };
          out.content.push(toolCall);
          const argsJson = JSON.stringify(toolCall.arguments);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: argsJson, partial: out });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: out });
          await new Promise((r) => setTimeout(r, 300)); // hold the working frame
          out.stopReason = "toolUse";
          stream.push({ type: "done", reason: out.stopReason, message: out });
          stream.end();
          return;
        }
        out.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: out });
        const block = out.content[0];
        if (block.type === "text") {
          block.text = "ok";
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: out });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: out });
        }
        await new Promise((r) => setTimeout(r, 300)); // hold the working frame
        out.stopReason = "stop";
        stream.push({ type: "done", reason: out.stopReason, message: out });
        stream.end();
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
