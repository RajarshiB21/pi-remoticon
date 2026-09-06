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
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

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
    streamSimple: (model) => {
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
