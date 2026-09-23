import type { Container, Component, TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { SkillState, createSkillPresenter } from "./skill.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface Assistant extends Component { remoticonVisible?: boolean; remoticonLastKind?: "text" | "thinking" | "notice"; remoticonVisibilityChanged?: () => void }
interface ToolRow extends Component {
  toolName: string; expanded: boolean; isPartial: boolean; remoticonStopped?: boolean; args?: unknown; cwd?: string;
  result?: { isError: boolean; content: { type: string; text?: string }[]; details?: { truncation?: { truncated?: boolean; firstLineExceedsLimit?: boolean }; groupSummary?: string; inlineBody?: boolean; diff?: string; patch?: string; firstChangedLine?: number } };
  remoticonChanged?: () => void;
  setExpanded(expanded: boolean): void;
  setShowImages(show: boolean): void;
  setImageWidthCells(width: number): void;
}
type DiffLine = { sign: "-" | "+" | " "; num: string; text: string };
interface Snapshot {
  name: string; state: "pending" | "done" | "failed" | "stopped"; error: string; path?: string; skill?: SkillState; groupSummary?: string; inlineBody?: boolean;
  arg?: string; command?: string; writeTotal?: number; writeHead?: string[]; diffW?: number; diffLines?: DiffLine[]; diffHidden?: number;
  diffAdded?: number; diffRemoved?: number; resultLines?: number; grepFiles?: number; grepMatches?: number; tail?: string[]; tailEarlier?: number;
}
interface Entry { row: ToolRow; owner?: Assistant; snapshot: Snapshot; skills: ReadonlyMap<string, string> }

/** Presentation only: retain original tool instances, results and execution order. */
export function createToolGroups(d: {
  Container: typeof Container; AssistantMessageComponent: new (...args: never[]) => Assistant;
  getTheme(): Theme; truncateToWidth: typeof truncateToWidth;
  resolvePath(path: string, cwd: string): string; skillLines: ReturnType<typeof createSkillPresenter>;
}) {
  const paths = process.getBuiltinModule("node:path");
  const keyPath = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const snapshot = (row: ToolRow, skills: ReadonlyMap<string, string>): Snapshot => {
    const args = row.args;
    const path = args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path.trim() ? d.resolvePath(args.path, row.cwd ?? process.cwd()) : undefined;
    const state = row.remoticonStopped ? "stopped" : !row.result || row.isPartial ? "pending" : row.result.isError ? "failed" : "done";
    const error = row.result?.isError ? (row.result.content.find(block => block.type === "text")?.text ?? "Tool failed").slice(0, 100).replace(/\s+/g, " ").trim() : "";
    const name = row.toolName === "read" && path ? skills.get(keyPath(path)) ?? (paths.basename(path) === "SKILL.md" ? paths.basename(paths.dirname(path)) : undefined) : undefined;
    const partial = !!(args && typeof args === "object" && "offset" in args && typeof args.offset === "number" && args.offset > 1) ||
      !!row.result?.details?.truncation?.truncated || !!row.result?.details?.truncation?.firstLineExceedsLimit ||
      !!row.result?.content.some(block => block.type === "text" && /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(block.text ?? ""));
    const groupSummary = row.result?.details?.groupSummary;
    // D6: a row that paints its own body is never hidden by the group's state.
    const inlineBody = row.result?.details?.inlineBody === true;
    // Bounded presentation slices for the collapsed per-call blocks (plan §2–3).
    const text = resultText(row);
    const arg = argOf(row.toolName, args);
    let command: string | undefined;
    let writeTotal: number | undefined;
    let writeHead: string[] | undefined;
    let diffW: number | undefined;
    let diffLines: DiffLine[] | undefined;
    let diffHidden: number | undefined;
    let diffAdded: number | undefined;
    let diffRemoved: number | undefined;
    let resultLines: number | undefined;
    let grepFiles: number | undefined;
    let grepMatches: number | undefined;
    let tail: string[] | undefined;
    let tailEarlier: number | undefined;
    if (Object.hasOwn(operations, row.toolName)) {
      resultLines = countLines(text);
      if (row.toolName === "bash" || row.toolName === "powershell") {
        command = arg;
        const slice = tailOf(text, 5);
        tail = slice.tail;
        tailEarlier = slice.earlier;
      } else if (row.toolName === "write") {
        const preview = writePreview(args && typeof args === "object" ? (args as Record<string, unknown>).content : undefined);
        if (preview) { writeTotal = preview.total; writeHead = preview.head; }
      } else if (row.toolName === "edit") {
        const diff = row.result?.details?.diff;
        if (typeof diff === "string") {
          const parsed = parseDiff(diff);
          diffW = parsed.w;
          diffLines = parsed.lines;
          diffHidden = parsed.hidden;
          diffAdded = parsed.added;
          diffRemoved = parsed.removed;
        }
      } else if (row.toolName === "grep") {
        const stats = grepStats(text);
        grepFiles = stats.files;
        grepMatches = stats.matches;
      } else if (row.toolName === "find") {
        resultLines = /^No files found/u.test(stripNotice(text).trim()) ? 0 : countNonEmptyLines(text);
      } else if (row.toolName === "ls") {
        resultLines = /^\(empty directory\)/u.test(stripNotice(text).trim()) ? 0 : countNonEmptyLines(text);
      }
    }
    return { name: row.toolName, state, error, path: path ? keyPath(path) : undefined, skill: name ? { name, state, error, partial } : undefined, groupSummary: typeof groupSummary === "string" && groupSummary.length > 0 ? groupSummary : undefined, inlineBody: inlineBody || undefined,
      arg, command, writeTotal, writeHead, diffW, diffLines, diffHidden, diffAdded, diffRemoved, resultLines, grepFiles, grepMatches, tail, tailEarlier };
  };
  const operations: Record<string, { done: string; pending: string; noun: string; file?: boolean }> = {
    read: { done: "read", pending: "reading", noun: "read", file: true },
    write: { done: "wrote", pending: "writing", noun: "write", file: true },
    edit: { done: "edited", pending: "editing", noun: "edit", file: true },
    bash: { done: "ran", pending: "running", noun: "command" },
    powershell: { done: "ran", pending: "running", noun: "command" },
    grep: { done: "ran", pending: "running", noun: "search" },
    find: { done: "ran", pending: "running", noun: "search" },
    ls: { done: "listed", pending: "listing", noun: "directory" },
  };
  const plural = (noun: string, count: number) => count === 1 ? noun : noun === "directory" ? "directories" : noun === "search" ? "searches" : `${noun}s`;

  // Presentation-only helpers for the collapsed per-call blocks.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const visible = (text: string) => [...stripAnsi(text)].length;
  const pendingViolet = "\x1b[38;2;185;165;232m";
  const ansiResetFg = "\x1b[39m";
  const ansiResetBg = "\x1b[49m";
  const diffRemovedBand = "\x1b[48;2;46;26;28m";
  const diffAddedBand = "\x1b[48;2;21;42;30m";
  const displayNames: Record<string, string> = { read: "Read", write: "Write", edit: "Update", bash: "Bash", powershell: "PowerShell", grep: "Grep", find: "Find", ls: "Ls" };
  const pendingText: Record<string, string> = { read: "Reading…", write: "Writing…", edit: "Editing…", bash: "running…", powershell: "running…", grep: "searching…", find: "searching…", ls: "listing…" };
  const argKey: Record<string, string> = { read: "path", write: "path", edit: "path", ls: "path", bash: "command", powershell: "command", grep: "pattern", find: "pattern" };

  const argOf = (name: string, args: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    const record = args as Record<string, unknown>;
    const key = argKey[name];
    if (key) { const value = record[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
    for (const value of Object.values(record)) if (typeof value === "string" && value.trim()) return value.trim();
    return undefined;
  };
  const resultText = (row: ToolRow): string =>
    (row.result?.content ?? []).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n");
  // pi appends a "[Showing …]"/"[N more lines …]" notice to truncated results; drop the trailing one.
  const stripNotice = (text: string) => text.replace(/\n\n\[(?:Showing[^\]]*|\d+ more lines[^\]]*)\]\s*$/u, "");
  const countLines = (text: string): number => {
    const body = stripNotice(text).replace(/\n+$/u, "");
    return body ? body.split("\n").length : 0;
  };
  const countNonEmptyLines = (text: string): number => stripNotice(text).split("\n").filter(line => line.trim().length > 0).length;
  const grepStats = (text: string): { matches: number; files: number } => {
    const files = new Set<string>();
    let matches = 0;
    for (const line of stripNotice(text).split("\n")) {
      const match = /^(.+?):\d+:/.exec(line);
      if (match) { matches++; files.add(match[1]); }
    }
    return { matches, files: files.size };
  };
  const parseDiff = (diff: string): { w: number; lines: DiffLine[]; added: number; removed: number; hidden: number } => {
    const parsed: DiffLine[] = [];
    let w = 1;
    for (const raw of diff.split("\n")) {
      const match = /^([-+ ])(\d*)(?: (.*))?$/.exec(raw);
      if (!match) continue;
      const sign = match[1] as "-" | "+" | " ";
      const num = match[2];
      if (num) w = Math.max(w, num.length);
      parsed.push({ sign, num, text: num ? match[3] ?? "" : "..." });
    }
    const isChange = (line: DiffLine) => line.sign === "+" || line.sign === "-";
    return { w, lines: parsed.slice(0, 12), added: parsed.filter(line => line.sign === "+").length, removed: parsed.filter(line => line.sign === "-").length, hidden: parsed.slice(12).filter(isChange).length };
  };
  const writePreview = (content: unknown): { total: number; head: string[] } | undefined => {
    if (typeof content !== "string") return undefined;
    const all = content.replace(/\n$/u, "").split("\n");
    return { total: all.length === 1 && all[0] === "" ? 0 : all.length, head: all.slice(0, 10).map(line => line.replace(/\t/g, "   ")) };
  };
  const tailOf = (text: string, limit: number): { tail: string[]; earlier: number } => {
    const body = stripNotice(text).replace(/\n+$/u, "");
    const all = body ? body.split("\n") : [];
    const tail = all.slice(-limit);
    return { tail, earlier: Math.max(0, all.length - tail.length) };
  };
  const countLabel = (count: number, noun: string, pluralForm?: string) => `${count} ${count === 1 ? noun : pluralForm ?? `${noun}s`}`;
  // 1:1 remove/add pairs get a bold changed span (longest common prefix/suffix).
  const changedSpans = (lines: DiffLine[]): Map<number, { start: number; end: number }> => {
    const spans = new Map<number, { start: number; end: number }>();
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].sign !== "-" || !lines[index].num) continue;
      if (index > 0 && lines[index - 1].sign === "-") continue;
      let removedEnd = index;
      while (removedEnd < lines.length && lines[removedEnd].sign === "-" && lines[removedEnd].num) removedEnd++;
      if (removedEnd - index !== 1) continue;
      if (!lines[removedEnd] || lines[removedEnd].sign !== "+" || !lines[removedEnd].num) continue;
      let addedEnd = removedEnd;
      while (addedEnd < lines.length && lines[addedEnd].sign === "+" && lines[addedEnd].num) addedEnd++;
      if (addedEnd - removedEnd !== 1) continue;
      const before = lines[index].text;
      const after = lines[removedEnd].text;
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      if (prefix + suffix === 0) continue;
      spans.set(index, { start: prefix, end: before.length - suffix });
      spans.set(removedEnd, { start: prefix, end: after.length - suffix });
    }
    return spans;
  };
  const diffBody = (state: Snapshot, width: number, pad: string, theme: Theme): string[] => {
    const lines = state.diffLines ?? [];
    const spans = changedSpans(lines);
    const columns = state.diffW ?? 1;
    const indent = pad + "    ";
    const out: string[] = [];
    lines.forEach((line, index) => {
      if (!line.num) { out.push(d.truncateToWidth(indent + theme.fg("dim", "…"), width, "…")); return; }
      const prefix = line.sign + " " + line.num.padStart(columns) + "  ";
      const color = line.sign === "-" ? "toolDiffRemoved" : line.sign === "+" ? "toolDiffAdded" : "toolDiffContext";
      const band = line.sign === "-" ? diffRemovedBand : line.sign === "+" ? diffAddedBand : "";
      if (!band) { out.push(d.truncateToWidth(indent + theme.fg("dim", prefix) + theme.fg(color, line.text), width, "…")); return; }
      const span = spans.get(index);
      const styled = span && span.end > span.start
        ? theme.fg(color, prefix + line.text.slice(0, span.start)) + theme.bold(theme.fg(color, line.text.slice(span.start, span.end))) + theme.fg(color, line.text.slice(span.end))
        : theme.fg(color, prefix + line.text);
      const clipped = width < 1 ? "" : d.truncateToWidth(indent + styled, width, "…").replaceAll("\x1b[0m", `\x1b[0m${band}`);
      out.push(band + clipped + " ".repeat(Math.max(0, width - visible(clipped))) + ansiResetBg);
    });
    if ((state.diffHidden ?? 0) > 0) out.push(d.truncateToWidth(indent + theme.fg("dim", `⋯ +${state.diffHidden} more changed lines hidden`), width, "…"));
    return out;
  };
  const branchOf = (state: Snapshot, theme: Theme): string => {
    if (state.state === "failed") return theme.fg("error", `failed · ${state.error}`);
    if (state.state === "stopped") return theme.fg("muted", "interrupted");
    if (state.state === "pending") return pendingViolet + (pendingText[state.name] ?? "running…") + ansiResetFg;
    switch (state.name) {
      case "write": return theme.fg("muted", state.arg ? `Wrote ${countLabel(state.writeTotal ?? 0, "line")} to ${state.arg}` : `Wrote ${countLabel(state.writeTotal ?? 0, "line")}`);
      case "edit": return theme.fg("muted", `Added ${countLabel(state.diffAdded ?? 0, "line")}, removed ${countLabel(state.diffRemoved ?? 0, "line")}`);
      case "read": return theme.fg("muted", countLabel(state.resultLines ?? 0, "line"));
      case "bash":
      case "powershell": return theme.fg("muted", "ran");
      case "grep": return theme.fg("muted", `${countLabel(state.grepMatches ?? 0, "match", "matches")} in ${countLabel(state.grepFiles ?? 0, "file")}`);
      case "find": return theme.fg("muted", (state.resultLines ?? 0) > 0 ? countLabel(state.resultLines ?? 0, "path") : "No matches");
      case "ls": return theme.fg("muted", countLabel(state.resultLines ?? 0, "entry", "entries"));
      default: return theme.fg("muted", "");
    }
  };
  const blockBody = (state: Snapshot, width: number, pad: string, theme: Theme): string[] => {
    if (state.state === "failed" || state.state === "stopped") return [];
    const indent = pad + "    ";
    if (state.name === "write" && state.writeTotal && state.writeHead?.length) {
      const columns = String(state.writeTotal).length;
      const out = state.writeHead.map((text, index) => d.truncateToWidth(indent + theme.fg("dim", String(index + 1).padStart(columns) + "  ") + theme.fg("muted", text), width, "…"));
      if (state.writeTotal > state.writeHead.length) out.push(d.truncateToWidth(indent + theme.fg("dim", `… +${state.writeTotal - state.writeHead.length} lines`), width, "…"));
      return out;
    }
    if (state.name === "edit" && state.state === "done" && state.diffLines?.length) return diffBody(state, width, pad, theme);
    if ((state.name === "bash" || state.name === "powershell") && state.state === "done" && state.tail?.length) {
      const out: string[] = [];
      if ((state.tailEarlier ?? 0) > 0) out.push(d.truncateToWidth(indent + theme.fg("dim", `… ${state.tailEarlier} earlier lines`), width, "…"));
      for (const text of state.tail) out.push(d.truncateToWidth(indent + theme.fg("muted", text), width, "…"));
      return out;
    }
    return [];
  };
  const headerOf = (state: Snapshot, width: number, pad: string, theme: Theme): string => {
    const display = displayNames[state.name] ?? state.name.charAt(0).toUpperCase() + state.name.slice(1);
    const marker = theme.fg("accent", "●") + " " + theme.bold(display);
    const head = state.arg ? marker + theme.fg("text", "(") + theme.fg("accent", state.arg) + theme.fg("text", ")") : marker;
    return d.truncateToWidth(pad + head, width, "");
  };
  const renderBlock = (state: Snapshot, width: number, pad: string, theme: Theme): string[] => [
    headerOf(state, width, pad, theme),
    d.truncateToWidth(pad + "  " + theme.fg("dim", "└") + " " + branchOf(state, theme), width, "…"),
    ...blockBody(state, width, pad, theme),
  ];

  class Group extends d.Container {
    entries: Entry[] = [];
    expanded = false;
    leadingBlank = true;
    outputPad = 1;
    private dirty = true;
    private segments: { entries: Entry[]; body: Container; summary: string; error: string; pending: boolean; expanded: boolean; headerY: number; bodyY: number; height: number }[] = [];
    setEntries(entries: Entry[]): void {
      this.entries = [];
      this.dirty = true;
      this.clear();
      for (const entry of entries) this.append(entry);
    }
    append(entry: Entry): void {
      this.entries.push(entry);
      this.addChild(entry.row);
      entry.row.remoticonChanged = () => { entry.snapshot = snapshot(entry.row, entry.skills); this.dirty = true; };
      entry.row.remoticonChanged();
      this.dirty = true;
    }
    setExpanded(expanded: boolean): void {
      this.expanded = expanded;
      for (const segment of this.segments) segment.expanded = expanded;
      for (const { row } of this.entries) row.setExpanded(expanded);
    }
    setOutputPad(padding: number): void { this.outputPad = padding; }
    setShowImages(show: boolean): void { for (const { row } of this.entries) row.setShowImages(show); }
    setImageWidthCells(width: number): void { for (const { row } of this.entries) row.setImageWidthCells(width); }
    override invalidate(): void { super.invalidate(); this.dirty = true; }
    override render(width: number): string[] {
      if (this.dirty) {
        const previous = new Map(this.segments.map(segment => [segment.entries[0], segment.expanded]));
        this.segments = [];
        for (const entry of this.entries) {
          let segment = this.segments.at(-1);
          if (!segment || entry.snapshot.skill || segment.entries[0].snapshot.skill) {
            segment = { entries: [], body: new d.Container(), summary: "", error: "", pending: false, expanded: previous.get(entry) ?? this.expanded, headerY: -1, bodyY: 0, height: 0 };
            this.segments.push(segment);
          }
          segment.entries.push(entry);
          segment.body.addChild(entry.row);
        }
        for (const segment of this.segments) {
          if (segment.entries[0].snapshot.skill) continue;
          const counts = new Map<string, { value: Snapshot; count: number; paths: Set<string> }>();
          const ordered: ({ bucket: string } | { custom: string })[] = [];
          segment.error = "";
          segment.pending = false;
          let stopped = false;
          for (const { snapshot: value } of segment.entries) {
            // Known tools paint a per-call block; they never enter the aggregate summary.
            if (Object.hasOwn(operations, value.name)) continue;
            if (value.state === "failed") segment.error ||= `${value.name}: ${value.error}`;
            if (value.state === "pending") segment.pending = true;
            if (value.state === "stopped") stopped = true;
            // D5: an extension-supplied summary replaces the counted line for this row.
            if (value.groupSummary) { ordered.push({ custom: value.groupSummary }); continue; }
            const known = Object.hasOwn(operations, value.name) ? operations[value.name] : undefined;
            // Failed/stopped attempts remain separate even when a retry uses the same path.
            const file = known?.file && value.path && (value.state === "pending" || value.state === "done");
            const key = `${known?.file || !known ? value.name : known.noun}/${value.state}/${Boolean(file)}`;
            let bucket = counts.get(key);
            if (!bucket) { bucket = { value, count: 0, paths: new Set() }; counts.set(key, bucket); ordered.push({ bucket: key }); }
            if (!file || !bucket.paths.has(value.path!)) bucket.count++;
            if (file) bucket.paths.add(value.path!);
          }
          const parts = ordered.map(entry => {
            if ("custom" in entry) return entry.custom;
            const { value, count } = counts.get(entry.bucket)!;
            const known = Object.hasOwn(operations, value.name) ? operations[value.name] : undefined;
            if (!known) return `${count} ${value.name} ${count === 1 ? "call" : "calls"} ${value.state === "done" ? "completed" : value.state === "stopped" ? "interrupted" : value.state}`;
            const noun = known.file && value.path && (value.state === "pending" || value.state === "done") ? "file" : known.noun;
            const label = `${count} ${plural(noun, count)}`;
            if (value.state === "failed" || value.state === "stopped") return `${label} ${value.state === "failed" ? "failed" : "interrupted"}`;
            // Without a known file path, describe invocations rather than inventing files.
            if (known.file && !value.path) return `${label} ${value.state === "done" ? "completed" : "pending"}`;
            return `${value.state === "pending" ? known.pending : known.done} ${label}`;
          });
          const allCustom = ordered.length > 0 && ordered.every(entry => "custom" in entry);
          const summary = (stopped && !allCustom ? ["Stopped", ...parts] : parts).join(" · ");
          segment.summary = summary.charAt(0).toUpperCase() + summary.slice(1);
        }
        this.dirty = false;
      }
      const theme = d.getTheme();
      const pad = " ".repeat(Math.min(Math.max(0, width), this.outputPad));
      const lines: string[] = this.leadingBlank ? [""] : [];
      for (const [index, segment] of this.segments.entries()) {
        const skill = segment.entries[0].snapshot.skill;
        if (index || skill && !this.leadingBlank) lines.push("");
        if (skill) {
          segment.headerY = -1;
          lines.push(...d.skillLines(skill, width, this.outputPad));
          segment.bodyY = lines.length;
          segment.height = 0;
          continue;
        }
        const start = lines.length;
        if (segment.summary) {
          const styled = segment.error ? theme.fg("error", segment.summary) : segment.pending ? `${pendingViolet}${segment.summary}${ansiResetFg}` : theme.fg("muted", segment.summary);
          lines.push(d.truncateToWidth(pad + styled, width, ""));
          if (segment.error) lines.push(d.truncateToWidth(pad + "  " + theme.fg("error", `! ${segment.error}`), width, ""));
        }
        let first = true;
        let headerY = segment.summary ? start : -1;
        for (const entry of segment.entries) {
          const value = entry.snapshot;
          if (Object.hasOwn(operations, value.name)) {
            if (!first || segment.summary) lines.push("");
            if (headerY < 0) headerY = lines.length;
            lines.push(...(segment.expanded ? [headerOf(value, width, pad, theme)] : renderBlock(value, width, pad, theme)));
            first = false;
          } else if (!segment.expanded && value.inlineBody) {
            if (!first || segment.summary) lines.push("");
            lines.push(...entry.row.render(width));
            first = false;
          }
        }
        segment.headerY = headerY < 0 ? start : headerY;
        segment.bodyY = lines.length;
        if (segment.expanded) {
          const body = segment.body.render(width);
          segment.height = body.length;
          lines.push(...body);
        } else {
          segment.height = 0;
        }
      }
      return lines;
    }
    override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
      for (const segment of this.segments) {
        if (event.y === segment.headerY && (event.type === "press" || event.type === "click") && event.button === "left") {
          if (event.type === "click") {
            segment.expanded = !segment.expanded;
            this.expanded = this.segments.every(value => value.entries[0].snapshot.skill || value.expanded);
            for (const { row } of segment.entries) row.setExpanded(segment.expanded);
          }
          return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
        }
        if (segment.expanded && event.y >= segment.bodyY && event.y < segment.bodyY + segment.height) return segment.body.handleMouse({ ...event, y: event.y - segment.bodyY, height: segment.height });
      }
      return undefined;
    }
  }
  const isVisible = (component: Component): boolean => !(component instanceof d.AssistantMessageComponent) || component.remoticonVisible === true;
  const layout = (chat: Container) => {
    let previous: Component | undefined;
    for (const child of chat.children) {
      if (!isVisible(child)) continue;
      if (child instanceof Group) child.leadingBlank = !(previous instanceof d.AssistantMessageComponent && previous.remoticonLastKind === "text" && child.entries.some(entry => entry.owner === previous));
      previous = child;
    }
  };
  const split = (chat: Container, owner: Assistant) => {
    if (owner.remoticonVisible) for (const child of [...chat.children]) {
      if (!(child instanceof Group) || chat.children.indexOf(child) >= chat.children.indexOf(owner)) continue;
      const moved = child.entries.filter(entry => entry.owner === owner);
      if (!moved.length) continue;
      const following = chat.children[chat.children.indexOf(owner) + 1];
      const target = following instanceof Group ? following : new Group();
      target.expanded = child.expanded;
      target.outputPad = child.outputPad;
      child.setEntries(child.entries.filter(entry => entry.owner !== owner));
      if (!child.entries.length) chat.removeChild(child);
      target.setEntries([...moved, ...target.entries]);
      if (target !== following) chat.children.splice(chat.children.indexOf(owner) + 1, 0, target);
    }
    layout(chat);
  };
  return {
    Group,
    add(chat: Container, row: ToolRow, outputPad = 1, catalog: readonly { filePath: string; name: string }[] = []): void {
      const skills = new Map(catalog.map(skill => [keyPath(d.resolvePath(skill.filePath, row.cwd ?? process.cwd())), skill.name]));
      const owner = [...chat.children].reverse().find(child => child instanceof d.AssistantMessageComponent) as Assistant | undefined;
      if (owner) owner.remoticonVisibilityChanged = () => split(chat, owner);
      const previous = [...chat.children].reverse().find(isVisible);
      const group = previous instanceof Group ? previous : new Group();
      group.outputPad = outputPad;
      if (group !== previous) { group.expanded = row.expanded; chat.addChild(group); }
      group.append({ row, owner, snapshot: snapshot(row, skills), skills });
      layout(chat);
    },
    stop(chat: Container): void {
      for (const child of chat.children) if (child instanceof Group) for (const { row, snapshot: state } of child.entries) {
        if (state.state === "pending") { row.remoticonStopped = true; row.remoticonChanged?.(); }
      }
    },
  };
}
