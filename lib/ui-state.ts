export type Activity = "Working" | "Reasoning" | "Writing" | "Running tools";
export type Outcome = "Finished" | "Stopped" | "Failed";

/** One run survives individual model turns, tool errors and automatic retries. */
export class RunState {
  active = false;
  waiting = false;
  activity: Activity = "Working";
  outcome: Outcome = "Finished";
  started = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  readonly tools = new Set<string>();
  start(now: number): void {
    if (this.active) return;
    this.active = true;
    this.started = now;
    this.pausedMs = 0;
    this.waiting = false;
    this.activity = "Working";
    this.outcome = "Finished";
    this.tools.clear();
  }
  pause(now: number): void {
    if (this.waiting) return;
    this.waiting = true;
    this.pausedAt = now;
  }
  resume(now: number): void {
    if (!this.waiting) return;
    this.pausedMs += now - this.pausedAt;
    this.waiting = false;
  }
  seconds(now: number): number {
    return Math.max(0, ((this.waiting ? this.pausedAt : now) - this.started - this.pausedMs) / 1000);
  }
  settle(): void {
    this.active = false;
    this.waiting = false;
    this.tools.clear();
  }
}

export const mix = (a: number[], b: number[], amount: number): number[] => a.map((v, i) => Math.round(v + (b[i] - v) * amount));
export const rgb = (color: number[], text: string): string => `\x1b[38;2;${color.join(";")}m${text}\x1b[39m`;
export const peak = (activity: Activity): number[] => activity === "Running tools" ? [159, 181, 221] : activity === "Writing" ? [220, 211, 236] : [185, 165, 232];
export const ruleColor = (rank: number): number[] => [Math.round(75 + rank * 55), Math.round(67 + rank * 45), Math.round(95 + rank * 65)];

/** Rank is relative to the selected model, never a provider token budget. */
export function effortRank(levels: readonly string[], selected: string): number {
  const index = levels.indexOf(selected);
  return index < 0 || levels.length < 2 ? 0 : index / (levels.length - 1);
}
export function dotColor(seconds: number, activity: Activity, moving: boolean): number[] {
  const phase = 2 * Math.PI * (0.65 * seconds - 0.4 * 12 / (2 * Math.PI) * Math.sin(2 * Math.PI * seconds / 12));
  const brightness = moving ? Math.round((0.25 + 0.75 * (1 - Math.cos(phase)) / 2) * 23) / 23 : 1;
  return mix([83, 77, 92], peak(activity), brightness);
}
/** Draw decoration at the actual cell width supplied by the native editor. */
export function topRule(width: number, rank: number, seconds: number, activity: Activity, moving: boolean): string {
  if (!moving) return rgb(ruleColor(rank), "─".repeat(Math.max(0, width)));
  const spread = Math.min(Math.max(1, Math.floor(width / 2)), Math.round(3 + rank * 12));
  const pos = Math.floor((Math.sin(seconds * 0.42 - Math.PI / 2) + 1) / 2 * Math.max(0, width - 2 * spread));
  return Array.from({ length: Math.max(0, width) }, (_, i) => rgb(mix(ruleColor(rank), peak(activity), Math.max(0, 1 - Math.abs(i - pos - spread) / spread)), "─")).join("");
}
