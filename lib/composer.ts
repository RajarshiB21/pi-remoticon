import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mix, rgb, ruleColor, topRule, type Activity } from "./ui-state.js";

export interface Decoration { rank: number; effort: string; seconds: number; activity: Activity; moving: boolean }

/** Preserve pi editing and app keybindings; change only the border renderers. */
export class Composer extends CustomEditor {
  decoration: () => Decoration = () => ({ rank: 0, effort: "unknown", seconds: 0, activity: "Working", moving: false });
  protected override renderTopBorder(width: number, hidden: number): string {
    if (hidden || this.getText().startsWith("!")) return super.renderTopBorder(width, hidden);
    const d = this.decoration();
    return topRule(width, d.rank, d.seconds, d.activity, d.moving);
  }
  protected override renderBottomBorder(width: number, hidden: number): string {
    if (hidden || this.getText().startsWith("!")) return super.renderBottomBorder(width, hidden);
    const d = this.decoration();
    const label = ` effort ${d.effort} `;
    const remaining = width - visibleWidth(label) - 2;
    if (remaining < 0) return rgb(ruleColor(d.rank), "─".repeat(Math.max(0, width)));
    return rgb(ruleColor(d.rank), "─".repeat(remaining)) + rgb(mix([144, 130, 164], [185, 165, 232], d.rank), label) + rgb(ruleColor(d.rank), "──");
  }
}
