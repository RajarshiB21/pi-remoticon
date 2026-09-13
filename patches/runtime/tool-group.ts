import type { Container, Component, TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { SkillState, createSkillPresenter } from "./skill.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface Assistant extends Component { remoticonVisible?: boolean; remoticonLastKind?: "text" | "thinking" | "notice"; remoticonVisibilityChanged?: () => void }
interface ToolRow extends Component {
  toolName: string; expanded: boolean; isPartial: boolean; remoticonStopped?: boolean; args?: unknown; cwd?: string;
  result?: { isError: boolean; content: { type: string; text?: string }[]; details?: { truncation?: { truncated?: boolean; firstLineExceedsLimit?: boolean }; groupSummary?: string } };
  remoticonChanged?: () => void;
  setExpanded(expanded: boolean): void;
  setShowImages(show: boolean): void;
  setImageWidthCells(width: number): void;
}
interface Snapshot { name: string; state: "pending" | "done" | "failed" | "stopped"; error: string; path?: string; skill?: SkillState; groupSummary?: string }
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
    return { name: row.toolName, state, error, path: path ? keyPath(path) : undefined, skill: name ? { name, state, error, partial } : undefined, groupSummary: typeof groupSummary === "string" && groupSummary.length > 0 ? groupSummary : undefined };
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
      const pad = " ".repeat(Math.min(Math.max(0, width), this.outputPad + 2));
      const lines: string[] = this.leadingBlank ? [""] : [];
      for (const [index, segment] of this.segments.entries()) {
        const skill = segment.entries[0].snapshot.skill;
        if (index || skill && !this.leadingBlank) lines.push("");
        segment.headerY = skill ? -1 : lines.length;
        if (skill) {
          lines.push(...d.skillLines(skill, width, this.outputPad));
          segment.bodyY = lines.length;
          segment.height = 0;
          continue;
        }
        const styled = segment.error ? theme.fg("error", segment.summary) : segment.pending ? `\x1b[38;2;185;165;232m${segment.summary}\x1b[39m` : theme.fg("muted", segment.summary);
        lines.push(d.truncateToWidth(pad + styled, width, ""));
        if (segment.error) lines.push(d.truncateToWidth(pad + "  " + theme.fg("error", `! ${segment.error}`), width, ""));
        segment.bodyY = lines.length;
        const body = segment.expanded ? segment.body.render(width) : [];
        segment.height = body.length;
        lines.push(...body);
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
  const visible = (component: Component): boolean => !(component instanceof d.AssistantMessageComponent) || component.remoticonVisible === true;
  const layout = (chat: Container) => {
    let previous: Component | undefined;
    for (const child of chat.children) {
      if (!visible(child)) continue;
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
      const previous = [...chat.children].reverse().find(visible);
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
