import type { wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface SkillState { name: string; state: "pending" | "done" | "failed" | "stopped"; partial?: boolean; error?: string }

/** Compact terminal presentation only; never renders the underlying skill source. */
export function createSkillPresenter(d: { getTheme(): Theme; wrapTextWithAnsi: typeof wrapTextWithAnsi; truncateToWidth: typeof truncateToWidth }) {
  return (skill: SkillState, width: number, padding: number): string[] => {
    if (width < 1) return [];
    const theme = d.getTheme();
    const pad = " ".repeat(Math.min(Math.max(0, padding), Math.max(0, width - 3)));
    const indent = pad + "  ";
    // Strip terminal controls from untrusted names and error excerpts.
    // eslint-disable-next-line no-control-regex
    const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const color = skill.state === "done" ? "success" : skill.state === "failed" ? "error" : skill.state === "pending" ? "accent" : "muted";
    const title = `${theme.bold("Skill")}(${clean(skill.name)})`;
    const lines = d.wrapTextWithAnsi(title, Math.max(1, width - indent.length)).map((line, index) =>
      d.truncateToWidth((index ? indent : pad + theme.fg(color, "●") + " ") + line, width, ""));
    const status = skill.state === "pending" ? "Loading skill…" : skill.state === "failed" ? "Failed to load skill" : skill.state === "stopped" ? "Stopped loading skill" : skill.partial ? "Read part of skill" : "Successfully loaded skill";
    for (const line of d.wrapTextWithAnsi(`└ ${status}`, Math.max(1, width - indent.length))) lines.push(d.truncateToWidth(indent + theme.fg("muted", line), width, ""));
    if (skill.state === "failed" && skill.error) lines.push(d.truncateToWidth(indent + theme.fg("error", `! ${clean(skill.error).slice(0, 100)}`), width, ""));
    return lines;
  };
}
