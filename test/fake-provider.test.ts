import { describe, it, expect } from "vitest";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Context, Model, Api, ToolResultMessage } from "@earendil-works/pi-ai";
import registerFake, { wantsToolCall } from "./fixtures/fake-provider.js";

const user = { role: "user" as const, content: "RUNTOOL", timestamp: 1 };
const result: ToolResultMessage = { role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "fixture" }], isError: false, timestamp: 2 };
const model = { api: "openai-completions", provider: "fake", id: "fake-model" } as Model<Api>;

describe("finite fake provider", () => {
  it("starts each new user scenario, retains unique calls, streams deltas and terminates on abort", async () => {
    let config: ProviderConfig | undefined;
    registerFake({ registerProvider: (_name: string, value: ProviderConfig) => { config = value; } } as unknown as ExtensionAPI);
    for (const [messages, expected] of [
      [[user], true], [[user, result], false], [[user, result, user], true],
    ] as const) expect(wantsToolCall({ messages: [...messages] } as Context)).toBe(expected);
    const context = { messages: [user, result, user] } as Context;
    const calls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const stream = config!.streamSimple!(model, context);
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.map(e => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
      const message = await stream.result();
      const call = message.content[0];
      expect(call.type).toBe("toolCall");
      if (call.type === "toolCall") calls.push(call.id);
    }
    expect(new Set(calls).size).toBe(2);
    const controller = new AbortController();
    const stream = config!.streamSimple!(model, { messages: [user, result] } as Context, { signal: controller.signal });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === "text_delta") controller.abort();
    }
    expect(events).toContain("text_delta");
    expect(events.at(-1)).toBe("error");
    expect((await stream.result()).stopReason).toBe("aborted");
  });
});
