import { it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { Container, Text, truncateToWidth, wrapTextWithAnsi, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme, getMarkdownTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createSkillPresenter } from "../patches/runtime/skill.js";
import { resolveToCwd } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { createToolGroups } from "../patches/runtime/tool-group.js";

it("keeps skills compact in order, including late arguments, partial reads and every settlement state", () => {
  initTheme("dark", false);
  const skillLines = createSkillPresenter({ getTheme: () => theme, truncateToWidth, wrapTextWithAnsi });
  const groups = createToolGroups({ Container, AssistantMessageComponent, getTheme: () => theme, truncateToWidth, resolvePath: resolveToCwd, skillLines });
  const chat = new Container();
  let hiddenRenders = 0;
  let nativeClicks = 0;
  class Row extends Text {
    toolName = "read"; expanded = false; isPartial = false; cwd = process.cwd();
    args: Record<string, unknown> = {};
    result?: { isError: boolean; content: { type: string; text: string }[]; details?: { truncation: { truncated: boolean } } };
    remoticonChanged?: () => void;
    setExpanded(value: boolean) { this.expanded = value; }
    setShowImages() {} setImageWidthCells() {}
    handleMouse() { nativeClicks++; return { handled: true as const }; }
    override render(width: number) { if (this.args.path === "custom.md") hiddenRenders++; return super.render(width); }
  }
  const add = (path: string, name = "read") => {
    const row = new Row(path === "custom.md" ? "SKILL_SOURCE_MUST_STAY_HIDDEN" : "ordinary native detail", 0, 0);
    row.toolName = name; row.args = { path };
    groups.add(chat, row, 1, [{ filePath: resolveToCwd("custom.md", process.cwd()), name: "declared:skill" }]);
    return row;
  };
  const before = add("ordinary.txt");
  const skill = add("custom.md");
  const after = add("references/guide.md");
  const group = chat.children[0] as InstanceType<typeof groups.Group>;
  const plain = () => group.render(120).map(stripVTControlCharacters).join("\n");
  expect(plain()).toContain("Skill(declared:skill)\n   └ Loading skill…");
  expect(plain().match(/Reading 1 file/g)).toHaveLength(2);
  expect(group.entries.map(entry => entry.row)).toEqual([before, skill, after]);
  skill.result = { isError: false, content: [{ type: "text", text: "SKILL_SOURCE_MUST_STAY_HIDDEN" }] };
  skill.remoticonChanged?.();
  group.setExpanded(true);
  group.render(120);
  expect(hiddenRenders).toBe(0);
  expect(plain()).not.toContain("SKILL_SOURCE_MUST_STAY_HIDDEN");
  expect(plain()).toContain("ordinary native detail");
  for (const [y, line] of group.render(120).entries()) if (line.includes("ordinary native detail")) group.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 120, height: 40, shift: false, ctrl: false, alt: false });
  expect(nativeClicks).toBe(2);
  expect(skill.result.content[0].text).toBe("SKILL_SOURCE_MUST_STAY_HIDDEN");
  expect(plain()).toContain("Successfully loaded skill");
  const skillY = group.render(120).map(stripVTControlCharacters).findIndex(line => line.includes("Skill("));
  expect(group.handleMouse({ type: "click", button: "left", x: 2, y: skillY, screenX: 2, screenY: skillY, width: 120, height: 40, shift: false, ctrl: false, alt: false })).toBeUndefined();
  group.setExpanded(false);
  expect(plain()).not.toContain("SKILL_SOURCE_MUST_STAY_HIDDEN");
  skill.args.offset = 2; skill.remoticonChanged?.();
  expect(plain()).toContain("Read part of skill");
  delete skill.args.offset;
  skill.result.details = { truncation: { truncated: true } }; skill.remoticonChanged?.();
  expect(plain()).toContain("Read part of skill");
  delete skill.result.details;
  skill.result.content[0].text = "part\n\n[3 more lines in file. Use offset=2 to continue.]"; skill.remoticonChanged?.();
  expect(plain()).toContain("Read part of skill");
  skill.result = { isError: true, content: [{ type: "text", text: "Permission denied" }] }; skill.remoticonChanged?.();
  expect(plain()).toContain("Failed to load skill\n   ! Permission denied");
  add("folder/SKILL.md");
  expect(plain()).toContain("Skill(folder)");
  groups.stop(chat);
  expect(plain()).toContain("Stopped loading skill");
  const late = add("unknown.md");
  late.args.path = "custom.md"; late.remoticonChanged?.();
  expect(plain().match(/Skill\(declared:skill\)/g)).toHaveLength(2);
  if (process.platform === "win32") {
    late.args.path = resolveToCwd("custom.md", process.cwd()).toUpperCase(); late.remoticonChanged?.();
    expect(plain().match(/Skill\(declared:skill\)/g)).toHaveLength(2);
  }
  late.args.path = "ordinary.txt"; late.remoticonChanged?.();
  expect(plain().match(/Skill\(declared:skill\)/g)).toHaveLength(1);
  group.invalidate(); group.setOutputPad(3);
  expect(plain()).toContain("   ● Skill");
  const replay = new Container();
  for (const entry of group.entries) groups.add(replay, entry.row, 3, [{ filePath: resolveToCwd("custom.md", process.cwd()), name: "declared:skill" }]);
  expect(replay.render(120).map(stripVTControlCharacters).join("\n")).toBe(plain());
  for (const width of [120, 80, 60, 8, 2, 1, 0]) {
    const lines = skillLines({ name: "very-long-界-é-name".repeat(8), state: "done" }, width, 3);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    if (width >= 60) expect(lines.map(stripVTControlCharacters).join("\n")).toContain("Successfully loaded skill");
  }
});

it("groups original rows across empty turns, splits owned rows at late content and preserves native controls", () => {
  initTheme("dark", false);
  const groups = createToolGroups({ Container, AssistantMessageComponent, getTheme: () => theme, truncateToWidth, resolvePath: resolveToCwd, skillLines: createSkillPresenter({ getTheme: () => theme, truncateToWidth, wrapTextWithAnsi }) });
  const chat = new Container();
  const assistant = () => Object.assign(new AssistantMessageComponent(undefined, false, getMarkdownTheme()), { remoticonVisible: false, remoticonVisibilityChanged: undefined as (() => void) | undefined });
  const first = assistant(); chat.addChild(first);
  let renders = 0;
  let updates = 0;
  class Output extends Text { override render(width: number) { renders++; return super.render(width); } }
  let callId = 0;
  let clicks = 0;
  class NativeControl extends Output { handleMouse() { clicks++; return { handled: true as const }; } }
  const makeRow = (name = "read") => {
    const native = new ToolExecutionComponent(name, String(++callId), {}, {}, {
      renderCall: () => new Output("native call", 0, 0),
      renderResult: () => { updates++; return new NativeControl("\x1b[48;2;1;2;3mnative result\x1b[49m", 0, 0); },
    }, { requestRender() {} } as TUI, process.cwd());
    const row = native as unknown as Parameters<typeof groups.add>[1] & { updateDisplay(): void };
    const display = row.updateDisplay.bind(row);
    row.updateDisplay = () => { try { display(); } finally { row.remoticonChanged?.(); } };
    return { native, row };
  };
  const a = makeRow(); groups.add(chat, a.row);
  const second = assistant(); chat.addChild(second);
  const b = makeRow(); groups.add(chat, b.row);
  const c = makeRow("write"); groups.add(chat, c.row);
  const group = chat.children.find(child => child instanceof groups.Group)! as InstanceType<typeof groups.Group>;
  expect(group.entries.map(entry => entry.row)).toEqual([a.row, b.row, c.row]);
  const plain = () => group.render(90).map(stripVTControlCharacters).join("\n");
  expect(plain()).toContain("2 reads pending");
  expect(group.render(90).join("\n")).toContain("\x1b[38;2;185;165;232m");
  expect(renders).toBe(0);
  b.native.updateResult({ content: [{ type: "text", text: "broken input" }], isError: true });
  a.native.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  expect(updates).toBeGreaterThan(0);
  expect(plain()).toContain("1 read failed");
  expect(plain()).toContain("broken input");
  expect(renders).toBe(0);
  second.remoticonVisible = true; second.remoticonVisibilityChanged?.();
  const split = chat.children[chat.children.indexOf(second) + 1] as InstanceType<typeof groups.Group>;
  expect(group.entries.map(entry => entry.row)).toEqual([a.row]);
  expect(split.entries.map(entry => entry.row)).toEqual([b.row, c.row]);
  expect(b.native).toBeInstanceOf(ToolExecutionComponent);
  groups.stop(chat);
  expect(split.render(90).map(stripVTControlCharacters).join("\n")).toContain("1 write interrupted");
  const event = { type: "click", button: "left", x: 2, y: 1, width: 90, height: 20, screenX: 2, screenY: 1, shift: false, alt: false, ctrl: false } satisfies TuiMouseEvent;
  expect(split.handleMouse(event)?.handled).toBe(true);
  expect(split.render(90).map(stripVTControlCharacters).join("\n")).toContain("native result");
  expect(split.render(90).join("\n")).toContain("\x1b[48;2;1;2;3m");
  for (let y = 2; y < split.render(90).length; y++) split.handleMouse({ ...event, y });
  expect(clicks).toBeGreaterThan(0);
  expect(renders).toBeGreaterThan(0);
  split.setShowImages(false); split.setImageWidthCells(30); split.invalidate(); split.setExpanded(false);
  const count = renders; split.render(20); split.render(20); expect(renders).toBe(count);
  chat.addChild(new Text("visible boundary", 0, 0));
  const d = makeRow(); groups.add(chat, d.row);
  expect(chat.children.at(-1)).not.toBe(split);
  chat.clear(); const e = makeRow(); groups.add(chat, e.row);
  expect((chat.children[0] as InstanceType<typeof groups.Group>).entries).toHaveLength(1);
  for (let i = 0; i < 300; i++) groups.add(chat, makeRow().row);
  const long = chat.children[0] as InstanceType<typeof groups.Group>;
  const before = renders;
  for (let i = 0; i < 20; i++) long.render(90);
  expect(renders).toBe(before);
  for (const name of ["constructor", "toString", "__proto__"]) {
    const generic = new Container(); groups.add(generic, makeRow(name).row);
    expect(generic.render(90).map(stripVTControlCharacters).join("\n")).toContain(`1 ${name} call pending`);
  }
  chat.clear();
  const commentary = Object.assign(assistant(), { remoticonVisible: true, remoticonLastKind: "text" as "text" | "thinking" });
  chat.addChild(commentary);
  const rows = [makeRow("read"), makeRow("read"), makeRow("read"), makeRow("bash")];
  for (const [index, value] of rows.entries()) {
    Object.assign(value.row, { args: index < 3 ? { path: index === 2 ? "second.txt" : "first.txt" } : { command: "echo safe" } });
    groups.add(chat, value.row, 2);
  }
  const summary = chat.children.at(-1) as InstanceType<typeof groups.Group>;
  expect(summary.render(120).map(stripVTControlCharacters)[0]).toBe("    Reading 2 files · running 1 command");
  for (const { native } of rows) native.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  expect(summary.render(120).map(stripVTControlCharacters)[0]).toBe("    Read 2 files · ran 1 command");
  expect(summary.render(120).join("\n")).not.toMatch(/[▸▾]/);
  commentary.remoticonLastKind = "thinking"; commentary.remoticonVisibilityChanged?.();
  expect(summary.render(120)[0]).toBe("");
  commentary.remoticonLastKind = "text"; commentary.remoticonVisibilityChanged?.();
  expect(summary.render(120)[0]).not.toBe("");
  summary.setOutputPad(0);
  expect(summary.render(120).map(stripVTControlCharacters)[0]).toMatch(/^ {2}Read/);
  const failed = makeRow("read"); Object.assign(failed.row, { args: { path: "first.txt" } }); groups.add(chat, failed.row, 0);
  failed.native.updateResult({ content: [{ type: "text", text: "denied" }], isError: true });
  const failure = summary.render(120).map(stripVTControlCharacters);
  expect(failure[0]).toContain("Read 2 files · ran 1 command · 1 read failed");
  expect(failure[1]).toBe("    ! read: denied");
  expect(summary.handleMouse({ ...event, type: "press", y: 0 })?.handled).toBe(true);
  expect(summary.expanded).toBe(false);
  expect(summary.handleMouse({ ...event, y: 0 })?.handled).toBe(true);
  expect(summary.expanded).toBe(true);
  const operations = new Container();
  for (const name of ["grep", "find", "ls", "ls"]) {
    const tool = makeRow(name); groups.add(operations, tool.row);
    tool.native.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  }
  expect(operations.render(120).map(stripVTControlCharacters).join("\n")).toContain("Ran 2 searches · listed 2 directories");
});
