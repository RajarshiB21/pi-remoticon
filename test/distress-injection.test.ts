import { describe, expect, it } from "vitest";
import { createDistressState, distressInjection, HAIL_MARY_TEXT, matchesDistress } from "../lib/distress/hailmary.js";
import { injectedMessage, latestHumanMessage } from "../lib/injects/scan.js";

const user = (text: string) => ({ role: "user", content: text });
/** The exact shape extensions/distress.ts appends (the lib text carries its own tags). */
const injected = injectedMessage;
const toolResult = (text: string) => ({ role: "toolResult", content: text });

describe("matchesDistress", () => {
  it("matches the two trigger phrases case-insensitively", () => {
    expect(matchesDistress("I am in distress")).toBe(true);
    expect(matchesDistress("i am in distress, just answer")).toBe(true);
    expect(matchesDistress("I'm in distress and cannot follow this")).toBe(true);
    expect(matchesDistress("please stop, i am in distress")).toBe(true);
  });
  it("does not match near-phrases or unrelated asks", () => {
    expect(matchesDistress("this module is distressing to read")).toBe(false);
    expect(matchesDistress("the login page feels slow")).toBe(false);
    expect(matchesDistress(null)).toBe(false);
  });
});

describe("distressInjection", () => {
  it("returns the hail mary when the latest human message states distress", () => {
    const injection = distressInjection(createDistressState(), [user("what's the latest on x"), user("i am in distress, just give me the answer")]);
    expect(injection).toContain("stop the current work now");
    expect(injection).toContain("never ask whether to continue");
    expect(injection).toContain("<system-reminder>");
  });
  it("stays silent without a matching ask", () => {
    const state = createDistressState();
    expect(distressInjection(state, [user("continue with the refactor")])).toBeNull();
    expect(distressInjection(state, [toolResult("tool output"), injected("something else")])).toBeNull();
  });
  it("fires once per ask and never stacks on repeated model calls", () => {
    const state = createDistressState();
    const ask = user("i am in distress");
    expect(distressInjection(state, [ask])).not.toBeNull();
    const context = [ask, injected(HAIL_MARY_TEXT), toolResult("kept working")];
    expect(latestHumanMessage(context)).toBe(ask);
    expect(distressInjection(state, context)).toBeNull();
    expect(distressInjection(state, [ask])).toBeNull();
  });
  it("ends when the owner's next message arrives, and a fresh ask fires again", () => {
    const state = createDistressState();
    expect(distressInjection(state, [user("i am in distress")])).not.toBeNull();
    expect(distressInjection(state, [user("ok continue with the plan")])).toBeNull();
    expect(distressInjection(state, [user("i am in distress again")])).not.toBeNull();
  });
  it("re-arms when the exact same phrase arrives in a later exchange", () => {
    const state = createDistressState();
    expect(distressInjection(state, [user("i am in distress")])).not.toBeNull();
    expect(distressInjection(state, [user("continue")])).toBeNull();
    expect(distressInjection(state, [user("i am in distress")])).not.toBeNull();
  });
});
