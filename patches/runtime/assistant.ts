import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Container, Markdown, Text, MouseRegion, Spacer, Component, TuiMouseEvent, MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme, MarkdownTransformer } from "@earendil-works/pi-coding-agent";

interface Owner {
  contentContainer: Container;
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
  hasToolCalls: boolean;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  outputPad: number;
  markdownTheme: MarkdownTheme;
  markdownTransformers: readonly MarkdownTransformer[];
  thinkingVisibilityOverrides: Map<number, boolean>;
  updateContent(message: AssistantMessage, streaming?: boolean): void;
  remoticonInvalidate?: () => void;
  remoticonVisible?: boolean;
  remoticonVisibilityChanged?: () => void;
}

/** Retain native Markdown, mouse controls and the AssistantMessageComponent owner.
 * Adapted from pi 0.85.1 assistant-message.js, MIT, copyright Mario Zechner.
 */
export function createAssistantPresenter(d: {
  Container: typeof Container; Markdown: typeof Markdown; Text: typeof Text; MouseRegion: typeof MouseRegion; Spacer: typeof Spacer;
  truncateToWidth: typeof truncateToWidth; getTheme(): Theme;
  createMarkdownTransform: (kind: "assistant" | "assistant-thinking", streaming: boolean, transformers: readonly MarkdownTransformer[]) => (text: string, width: number) => string;
}) {
  interface Record { text: string; signature: string; component: Component; markdown?: Markdown; clear(): void }
  const records = new Map<string, Record>();
  return function update(this: Owner, message: AssistantMessage, streaming = this.isStreaming): void {
    this.lastMessage = message;
    this.isStreaming = streaming;
    this.hasToolCalls = message.content.some(block => block.type === "toolCall");
    this.remoticonInvalidate = () => records.clear();
    const next: Component[] = [];
    const used = new Set<string>();
    let thinkingRun = 0;
    const theme = d.getTheme();
    const add = (key: string, text: string, kind: "text" | "thinking", hidden = false, runIndex = 0) => {
      used.add(key);
      const pad = this.outputPad;
      const signature = `${kind}/${hidden}/${pad}/${streaming}/${this.hiddenThinkingLabel}/${runIndex}`;
      let record = records.get(key);
      if (!record || record.signature !== signature) {
        let markdown: Markdown | undefined;
        let inner: Component;
        if (hidden) inner = new d.Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 0, 0);
        else {
          markdown = new d.Markdown(text, 0, 0, this.markdownTheme,
            kind === "thinking" ? { color: value => d.getTheme().fg("thinkingText", value), italic: true } : undefined,
            { transform: d.createMarkdownTransform(kind === "text" ? "assistant" : "assistant-thinking", streaming, this.markdownTransformers) });
          if (kind === "thinking") {
            const thinking = new d.Container();
            thinking.addChild(new d.Text(theme.fg("thinkingText", "Reasoning"), 0, 0));
            thinking.addChild(markdown);
            inner = thinking;
          } else inner = markdown;
        }
        let cachedWidth = -1;
        let cached: string[] = [];
        const wrapped: Component = {
          render(width) {
            if (cachedWidth !== width) {
              const lines = inner.render(Math.max(1, width - pad * 2 - 2));
              cached = lines.map((line, index) => d.truncateToWidth(" ".repeat(pad) +
                (kind === "text" && index === 0 ? d.getTheme().fg("text", "● ") : "  ") + line + " ".repeat(pad), width, ""));
              cachedWidth = width;
            }
            return cached;
          },
          invalidate() { cachedWidth = -1; inner.invalidate(); },
          handleMouse(event: TuiMouseEvent) {
            return inner.handleMouse?.({ ...event, x: event.x - pad - 2, width: Math.max(1, event.width - pad * 2 - 2) });
          },
        };
        const component = kind === "thinking" ? new d.MouseRegion(wrapped, event => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          this.thinkingVisibilityOverrides.set(runIndex, !hidden);
          if (this.lastMessage) this.updateContent(this.lastMessage);
          return { handled: true };
        }) : wrapped;
        record = { text, signature, component, markdown, clear: () => { cachedWidth = -1; } };
        records.set(key, record);
      } else if (record.text !== text) {
        record.markdown?.setText(text);
        record.text = text;
        record.clear();
      }
      next.push(record.component);
    };
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block.type === "text" && block.text.trim()) add(`text:${index}`, block.text.trim(), "text");
      else if (block.type === "thinking") {
        const start = index;
        const parts: string[] = [];
        while (index < message.content.length && message.content[index].type === "thinking") {
          const thinking = message.content[index] as { type: "thinking"; thinking: string };
          if (thinking.thinking.trim()) parts.push(thinking.thinking.trim());
          index++;
        }
        index--;
        if (!parts.length) continue;
        const runIndex = thinkingRun++;
        add(`thinking:${start}`, parts.join("\n\n"), "thinking", this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock, runIndex);
        if (message.content.slice(index + 1).some(content => content.type === "text" && content.text.trim() || content.type === "thinking" && content.thinking.trim())) next.push(new d.Spacer(1));
      }
    }
    for (const key of records.keys()) if (!used.has(key)) records.delete(key);
    if (next.length) next.unshift(new d.Spacer(1));
    let notice: string | undefined;
    if (message.stopReason === "length") notice = "Response was truncated before completion.";
    else if (!this.hasToolCalls && message.stopReason === "aborted") notice = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
    else if (!this.hasToolCalls && message.stopReason === "error") notice = `Error: ${message.errorMessage || "Unknown error"}`;
    if (notice) next.push(new d.Spacer(1), new d.Text(theme.fg("error", notice), this.outputPad, 0));
    this.contentContainer.clear();
    for (const component of next) this.contentContainer.addChild(component);
    const visible = next.length > 0;
    if (this.remoticonVisible !== visible) {
      this.remoticonVisible = visible;
      this.remoticonVisibilityChanged?.();
    }
  };
}
