import { describe, expect, it } from "vitest";
import {
	createReminderState,
	reminderOnToolResult,
	reminderOnTurnStart,
	RESEARCH_REMINDER_TEXT,
	researchReminderInjection,
} from "../lib/research/reminder.js";
import { injectedMessage, latestHumanMessage } from "../lib/injects/scan.js";

const user = (text: string) => ({ role: "user", content: text });
/** The exact shape extensions/research-reminder.ts appends. */
const injected = injectedMessage;
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
  it("fires on the third turn with no fetch ever recorded", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 3; turn++) reminderOnTurnStart(state);
    const reminder = researchReminderInjection(state, [user("what's the latest on x")]);
    expect(reminder).toContain("research flow now: one fetch call");
  });
  it("fires once per ask and never stacks on repeated model calls", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const ask = user("what's the latest state of x");
    expect(researchReminderInjection(state, [ask])).not.toBeNull();
    const context = [ask, injected(RESEARCH_REMINDER_TEXT), fetchResult()];
    expect(latestHumanMessage(context)).toBe(ask);
    expect(researchReminderInjection(state, context)).toBeNull();
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
  it("does not treat local words containing a keyword as a match", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, [user("I updated the parser module")])).toBeNull();
  });
  it("re-arms for the same ask on a later turn after the cadence resets", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const ask = [user("what's the latest state of x")];
    expect(researchReminderInjection(state, ask)).not.toBeNull();
    reminderOnToolResult(state, "fetch");
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    expect(researchReminderInjection(state, ask)).not.toBeNull();
  });
  it("re-arms for an identical ask that arrives as a new message without a fetch", () => {
    const state = createReminderState();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const ask = [user("what's the latest state of x")];
    expect(researchReminderInjection(state, ask)).not.toBeNull();
    for (let turn = 0; turn < 4; turn++) reminderOnTurnStart(state);
    const repeated = [...ask, injected(RESEARCH_REMINDER_TEXT), user("what's the latest state of x")];
    expect(researchReminderInjection(state, repeated)).not.toBeNull();
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
