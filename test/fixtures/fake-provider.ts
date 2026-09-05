// Test-only fake model provider. NOT shipped in the pi-remoticon package —
// it lives under test/ and is loaded into pi per-run via `pi -e`, never from
// the product's extensions/ directory.
//
// Its whole job: give the Integration lane a provider that pi can select
// WITHOUT any real credentials or network, so no lane-1..3 test can ever reach
// a real (or metered, e.g. openrouter) model. At frame-zero pi never calls the
// model, so a never-reached baseUrl is enough here; a canned streamSimple
// response (needs @earendil-works/pi-ai) is added when a slice first runs a
// real turn.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    name: "Fake (test)",
    baseUrl: "http://127.0.0.1:1", // unreachable on purpose; never hit at frame-zero
    apiKey: "unused",
    api: "openai-completions",
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
