import type { Container, Component, TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface Assistant extends Component { remoticonVisible?: boolean; remoticonVisibilityChanged?: () => void }
interface ToolRow extends Component {
  toolName: string; expanded: boolean; isPartial: boolean; remoticonStopped?: boolean;
  result?: { isError: boolean; content: { type: string; text?: string }[] };
  remoticonChanged?: () => void;
  setExpanded(expanded: boolean): void;
  setShowImages(show: boolean): void;
  setImageWidthCells(width: number): void;
}
interface Snapshot { name: string; state: "pending" | "done" | "failed" | "stopped"; error: string }
interface Entry { row: ToolRow; owner?: Assistant; snapshot: Snapshot }

/** Presentation only: groups retain original tool rows and never execute tools. */
export function createToolGroups(d: {
  Container: typeof Container; AssistantMessageComponent: new (...args: never[]) => Assistant;
  getTheme(): Theme; truncateToWidth: typeof truncateToWidth;
}) {
  const snapshot = (row: ToolRow): Snapshot => ({
    name: row.toolName,
    state: row.remoticonStopped ? "stopped" : !row.result || row.isPartial ? "pending" : row.result.isError ? "failed" : "done",
    error: row.result?.isError ? (row.result.content.find(block => block.type === "text")?.text ?? "Tool failed").slice(0, 100).replace(/\s+/g, " ").trim() : "",
  });
  const operations: Record<string, string> = { read: "read", write: "write", edit: "edit", bash: "command", powershell: "command", grep: "search", find: "search", ls: "listing" };
  const operation = (name: string): string => Object.hasOwn(operations, name) ? operations[name] : name;
  class Group extends d.Container {
    entries: Entry[] = [];
    expanded = false;
    private dirty = true;
    private summary = "";
    private errors = false;
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
      this.dirty = true;
    }
    setShowImages(show: boolean): void { for (const { row } of this.entries) row.setShowImages(show); }
    setImageWidthCells(width: number): void { for (const { row } of this.entries) row.setImageWidthCells(width); }
    override invalidate(): void { super.invalidate(); this.dirty = true; }
    override render(width: number): string[] {
      if (this.dirty) {
        const counts = new Map<string, number>();
        let failures = 0;
        let stopped = 0;
        let error = "";
        for (const entry of this.entries) {
          const value = entry.snapshot;
          if (value.state === "failed") { failures++; error ||= `${value.name}: ${value.error}`; }
          else if (value.state === "stopped") stopped++;
          else {
            const key = `${operation(value.name)}${value.state === "pending" ? " pending" : ""}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        const parts = [...counts].map(([name, count]) => `${count} ${name}${count > 1 && !name.endsWith("pending") ? "s" : ""}`);
        if (failures) parts.push(`${failures} failed`);
        if (stopped) parts.push(`${stopped} stopped`);
        if (error) parts.push(error);
        this.summary = parts.join(" · ");
        this.errors = failures > 0;
        this.dirty = false;
      }
      const theme = d.getTheme();
      const summary = d.truncateToWidth(theme.fg(this.errors ? "error" : "muted", `${this.expanded ? "▾" : "▸"} ${this.summary}`), width, "");
      return ["", summary, ...(this.expanded ? super.render(width) : [])];
    }
    override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
      if (event.y === 1 && event.type === "click" && event.button === "left") {
        this.setExpanded(!this.expanded);
        return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
      }
      return this.expanded && event.y >= 2 ? super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 }) : undefined;
    }
  }
  const visible = (component: Component): boolean => !(component instanceof d.AssistantMessageComponent) || component.remoticonVisible === true;
  const split = (chat: Container, owner: Assistant) => {
    if (!owner.remoticonVisible) return;
    for (const child of [...chat.children]) {
      if (!(child instanceof Group) || chat.children.indexOf(child) >= chat.children.indexOf(owner)) continue;
      const moved = child.entries.filter(entry => entry.owner === owner);
      if (!moved.length) continue;
      const following = chat.children[chat.children.indexOf(owner) + 1];
      const target = following instanceof Group ? following : new Group();
      target.expanded = child.expanded;
      child.setEntries(child.entries.filter(entry => entry.owner !== owner));
      if (!child.entries.length) chat.removeChild(child);
      target.setEntries([...moved, ...target.entries]);
      if (target !== following) chat.children.splice(chat.children.indexOf(owner) + 1, 0, target);
    }
  };
  return {
    Group,
    add(chat: Container, row: ToolRow): void {
      const owner = [...chat.children].reverse().find(child => child instanceof d.AssistantMessageComponent) as Assistant | undefined;
      if (owner) owner.remoticonVisibilityChanged = () => split(chat, owner);
      const previous = [...chat.children].reverse().find(visible);
      const group = previous instanceof Group ? previous : new Group();
      if (group !== previous) { group.expanded = row.expanded; chat.addChild(group); }
      group.append({ row, owner, snapshot: snapshot(row) });
    },
    stop(chat: Container): void {
      for (const child of chat.children) if (child instanceof Group) for (const { row, snapshot: state } of child.entries) {
        if (state.state === "pending") { row.remoticonStopped = true; row.remoticonChanged?.(); }
      }
    },
  };
}
