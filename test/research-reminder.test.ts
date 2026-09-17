import { describe, expect, it } from "vitest";
import {
	createReminderState,
	reminderOnToolResult,
	reminderOnTurnStart,
	researchReminderInjection,
} from "../lib/research/reminder.js";

const user = (text: string) => ({ role: "user", content: text });
const injected = (text: string) => ({ role: "user", content: text });
const fetchResult = () => ({ role: "toolResult", content: "fetched pages" });

describe("researchReminderInjection", () => {
  it("stays silent while a fetch ran within the last three turns, then fires", () => {
    const state = createReminderState();
    const ask = [user("what's the latest on x")];
    reminderOnTurnStart(state);
    expect(researchReminderInjection(state, ask)).toBeNull();          // turn 1, never fetched: below threshold
    reminderOnTurnStart(state);
    reminderOnToolResult(state, "fetch");                              // a fetch in turn 2
    reminderOnTurnStart(state);
    expect(researchReminderInjection(state, ask)).toBeNull();          // turn 3: one turn since fetch
    reminderOnTurnStart(state);
    expect(researchReminderInjection(state, ask)).toBeNull();          // turn 4: two turns
    reminderOnTurnStart(state);
    const reminder = researchReminderInjection(state, ask);            // turn 5: three turns
    expect(reminder).toContain("research flow now: one fetch call");
    expect(reminder).toContain("<system-reminder>");
  });
  it("fires once per ask and never stacks on repeated model calls", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const ask = user("what's the latest state of x");
    expect(researchReminderInjection(state, [ask])).not.toBeNull();
    expect(researchReminderInjection(state, [ask, injected("the reminder"), fetchResult()])).toBeNull();
    expect(researchReminderInjection(state, [ask])).toBeNull();
  });
  it("defers to the distress hail mary", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("i am in distress, what's the latest news")])).toBeNull();
  });
  it("stays silent without a current-info keyword", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("refactor the parser module")])).toBeNull();
  });
  it("stays silent on the owner's observed local-only ask", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("reading the current state of the repo")])).toBeNull();
  });
  it("stays silent when search means the repo, not the web", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("search the repo for the failing test")])).toBeNull();
  });
  it("fires again on a fresh keyword ask after the fetch budget resets", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const firstAsk = [user("search for the latest state of x")];
    expect(researchReminderInjection(state, firstAsk)).not.toBeNull();
    reminderOnToolResult(state, "fetch");
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("and the recent news on y")])).not.toBeNull();
  });
});
