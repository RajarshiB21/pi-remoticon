import type { Container, Component, TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface Assistant extends Component { remoticonVisible?: boolean; remoticonLastKind?: "text" | "thinking" | "notice"; remoticonVisibilityChanged?: () => void }
interface ToolRow extends Component {
  toolName: string; expanded: boolean; isPartial: boolean; remoticonStopped?: boolean; args?: unknown; cwd?: string;
  result?: { isError: boolean; content: { type: string; text?: string }[] };
  remoticonChanged?: () => void;
  setExpanded(expanded: boolean): void;
  setShowImages(show: boolean): void;
  setImageWidthCells(width: number): void;
}
interface Snapshot { name: string; state: "pending" | "done" | "failed" | "stopped"; error: string; path?: string }
interface Entry { row: ToolRow; owner?: Assistant; snapshot: Snapshot }

/** Presentation only: retain original tool instances, results and execution order. */
export function createToolGroups(d: {
  Container: typeof Container; AssistantMessageComponent: new (...args: never[]) => Assistant;
  getTheme(): Theme; truncateToWidth: typeof truncateToWidth;
}) {
  const paths = process.getBuiltinModule("node:path");
  const snapshot = (row: ToolRow): Snapshot => {
    const args = row.args;
    const path = args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path.trim() ? paths.resolve(row.cwd ?? process.cwd(), args.path) : undefined;
    return {
      name: row.toolName,
      state: row.remoticonStopped ? "stopped" : !row.result || row.isPartial ? "pending" : row.result.isError ? "failed" : "done",
      error: row.result?.isError ? (row.result.content.find(block => block.type === "text")?.text ?? "Tool failed").slice(0, 100).replace(/\s+/g, " ").trim() : "",
      path: process.platform === "win32" ? path?.toLowerCase() : path,
    };
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
  const plural = (noun: string, count: number) => count === 1 ? noun : noun === "directory" ? "directories" : `${noun}s`;
  class Group extends d.Container {
    entries: Entry[] = [];
    expanded = false;
    leadingBlank = true;
    outputPad = 1;
    private dirty = true;
    private summary = "";
    private error = "";
    private pending = false;
    private detailOffset = 0;
    setEntries(entries: Entry[]): void {
      this.entries = [];
      this.clear();
      for (const entry of entries) this.append(entry);
    }
    append(entry: Entry): void {
      this.entries.push(entry);
      this.addChild(entry.row);
      entry.row.remoticonChanged = () => { entry.snapshot = snapshot(entry.row); this.dirty = true; };
      entry.row.remoticonChanged();
      this.dirty = true;
    }
    setExpanded(expanded: boolean): void {
      this.expanded = expanded;
      for (const { row } of this.entries) row.setExpanded(expanded);
    }
    setOutputPad(padding: number): void { this.outputPad = padding; }
    setShowImages(show: boolean): void { for (const { row } of this.entries) row.setShowImages(show); }
    setImageWidthCells(width: number): void { for (const { row } of this.entries) row.setImageWidthCells(width); }
    override invalidate(): void { super.invalidate(); this.dirty = true; }
    override render(width: number): string[] {
      if (this.dirty) {
        const counts = new Map<string, { value: Snapshot; count: number; paths: Set<string> }>();
        this.error = "";
        this.pending = false;
        let stopped = false;
        for (const { snapshot: value } of this.entries) {
          const known = Object.hasOwn(operations, value.name) ? operations[value.name] : undefined;
          // Failed/stopped attempts remain separate even when a retry uses the same path.
          const file = known?.file && value.path && (value.state === "pending" || value.state === "done");
          const key = `${known?.file || !known ? value.name : known.noun}/${value.state}/${Boolean(file)}`;
          let bucket = counts.get(key);
          if (!bucket) { bucket = { value, count: 0, paths: new Set() }; counts.set(key, bucket); }
          if (!file || !bucket.paths.has(value.path!)) bucket.count++;
          if (file) bucket.paths.add(value.path!);
          if (value.state === "failed") this.error ||= `${value.name}: ${value.error}`;
          if (value.state === "pending") this.pending = true;
          if (value.state === "stopped") stopped = true;
        }
        const parts = [...counts.values()].map(({ value, count }) => {
          const known = Object.hasOwn(operations, value.name) ? operations[value.name] : undefined;
          if (!known) return `${count} ${value.name} ${count === 1 ? "call" : "calls"} ${value.state === "done" ? "completed" : value.state === "stopped" ? "interrupted" : value.state}`;
          const noun = known.file && value.path && (value.state === "pending" || value.state === "done") ? "file" : known.noun;
          const label = `${count} ${plural(noun, count)}`;
          if (value.state === "failed" || value.state === "stopped") return `${label} ${value.state === "failed" ? "failed" : "interrupted"}`;
          // Without a known file path, describe invocations rather than inventing files.
          if (known.file && !value.path) return `${label} ${value.state === "done" ? "completed" : "pending"}`;
          return `${value.state === "pending" ? known.pending : known.done} ${label}`;
        });
        const summary = (stopped ? ["Stopped", ...parts] : parts).join(" · ");
        this.summary = summary.charAt(0).toUpperCase() + summary.slice(1);
        this.dirty = false;
      }
      const theme = d.getTheme();
      const pad = " ".repeat(Math.min(Math.max(0, width), this.outputPad + 2));
      const styled = this.error ? theme.fg("error", this.summary) : this.pending ? `\x1b[38;2;185;165;232m${this.summary}\x1b[39m` : theme.fg("muted", this.summary);
      const summary = d.truncateToWidth(pad + styled, width, "");
      const header = [...(this.leadingBlank ? [""] : []), summary];
      if (this.error) header.push(d.truncateToWidth(pad + "  " + theme.fg("error", `! ${this.error}`), width, ""));
      this.detailOffset = header.length;
      return [...header, ...(this.expanded ? super.render(width) : [])];
    }
    override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
      if (event.y === Number(this.leadingBlank) && event.type === "click" && event.button === "left") {
        this.setExpanded(!this.expanded);
        return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
      }
      return this.expanded && event.y >= this.detailOffset ? super.handleMouse({ ...event, y: event.y - this.detailOffset, height: event.height - this.detailOffset }) : undefined;
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
    add(chat: Container, row: ToolRow, outputPad = 1): void {
      const owner = [...chat.children].reverse().find(child => child instanceof d.AssistantMessageComponent) as Assistant | undefined;
      if (owner) owner.remoticonVisibilityChanged = () => split(chat, owner);
      const previous = [...chat.children].reverse().find(visible);
      const group = previous instanceof Group ? previous : new Group();
      group.outputPad = outputPad;
      if (group !== previous) { group.expanded = row.expanded; chat.addChild(group); }
      group.append({ row, owner, snapshot: snapshot(row) });
      layout(chat);
    },
    stop(chat: Container): void {
      for (const child of chat.children) if (child instanceof Group) for (const { row, snapshot: state } of child.entries) {
        if (state.state === "pending") { row.remoticonStopped = true; row.remoticonChanged?.(); }
      }
    },
  };
}
