import { it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderFetchCall, renderFetchResult, shrinkUrl, type RenderableDetails } from "../lib/research/row.js";
import { attempt, page } from "./helpers/research-fixtures.js";

initTheme("dark", false);

const details = (over: Partial<RenderableDetails> = {}): RenderableDetails => ({
  pages: [],
  attempts: [],
  autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: {} },
  cancelled: false,
  live: [],
  pending: false,
  ...over,
});

function row(args: unknown, result: { details: RenderableDetails; isError?: boolean; text?: string }, isPartial = false): string[] {
  const component = new ToolExecutionComponent("fetch", "call-1", args, {}, {
    renderShell: "self",
    renderCall: renderFetchCall,
    renderResult: renderFetchResult,
  } as never, { requestRender() {} } as unknown as TUI, process.cwd());
  component.updateResult(
    { content: [{ type: "text", text: result.text ?? "fetch: 1 target (1 usable, 0 dead ends, 0 failed)" }], details: result.details, isError: result.isError ?? false },
    isPartial,
  );
  return component.render(120);
}

const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

it("draws the approved columns, states and evidence lines", () => {
  expect(plain(row({ targets: [{ url: "https://en.wikipedia.org/wiki/Scrapling" }] }, { details: details({ pages: [page({ requestedUrl: "https://en.wikipedia.org/wiki/Scrapling", receivedBytes: 86_221, extractedBytes: 43_111 })] }) })))
    .toContain("● Fetch(en.wikipedia.org/wiki/Scrapling)\n  └ en.wikipedia.org/wiki/Scrapling  200 OK · 84.2KB received · main content → 42.1KB");
  expect(plain(row({ targets: [{ url: "a" }, { url: "b" }, { url: "c" }] }, { details: details({ pages: [page()] }) })))
    .toContain("● Fetch(3 URLs concurrently)");
  expect(plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page({ selector: "main", selectorApplied: true, receivedBytes: 86_221, extractedBytes: 6_246 })] }) })))
    .toContain('200 OK · 84.2KB received · selector "main" → 6.1KB');

  const recovered = [attempt({ blockedSignal: "cloudflare", status: 403, reason: "Forbidden" }), attempt({ attempt: 2, tier: "stealth" })];
  expect(plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, { details: details({ pages: [page({ requestedUrl: "https://www.reddit.com/r/X/", usedStealth: true })], attempts: recovered }) })))
    .toContain("└ www.reddit.com/r/X/  403 → cleared with stealth · 200 OK");

  const empty = [attempt({ unusableSignal: "empty content" }), attempt({ attempt: 2, tier: "stealth" })];
  expect(plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page()], attempts: empty }) })))
    .toContain("200 → empty → cleared with stealth · 200 OK");

  const transport = [attempt({ status: null, reason: "connection reset" }), attempt({ attempt: 2, tier: "stealth" })];
  expect(plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page()], attempts: transport }) })))
    .toContain("failed → cleared with stealth · 200 OK");

  expect(plain(row({ targets: [{ url: "https://example.com/missing" }] }, { details: details({ pages: [page({ requestedUrl: "https://example.com/missing", usable: false, finalStatus: 404, finalReason: "Not Found", deadEndReason: "not found" })], attempts: [attempt({ status: 404, reason: "Not Found" })] }) })))
    .toContain("└ example.com/missing  404 → not found");

  const blocked = [attempt({ blockedSignal: "cloudflare", status: 403 }), attempt({ attempt: 2, blockedSignal: "cloudflare", status: 403 }), attempt({ attempt: 3, tier: "stealth", blockedSignal: "cloudflare", status: 403 })];
  expect(plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page({ usable: false, finalStatus: 403, finalReason: "Forbidden", deadEndReason: "blocked after 3 attempts, including stealth", usedStealth: true })], attempts: blocked }) })))
    .toContain("403 → blocked after 3 attempts, including stealth");

  expect(plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page({ usable: false, error: "connection reset", finalStatus: null, finalReason: null })], attempts: [attempt({ status: null, reason: "connection reset" })] }) })))
    .toContain("failed: connection reset");

  expect(plain(row({ targets: [{ url: "https://example.com/a" }] }, { details: details({ pages: [page({ requestedUrl: "https://example.com/a", finalUrl: "https://example.com/b" })] }) })))
    .toContain("└ example.com/a (final example.com/b)");
});

it("indents truncation and captured-xhr evidence under their target, and shows the throttle line last", () => {
  const captured = page({
    truncation: { truncated: true, keptBytes: 16_384, totalBytes: 43_000, outputPath: "pi-fetch-abc/t0.md" },
    capturedXhr: [{ url: "https://www.reddit.com/svc/shreddit/comments/x", status: 200, bytes: 18_637, truncated: false, content: "{}" }],
  });
  const text = plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, {
    details: details({ pages: [page({ requestedUrl: "https://www.reddit.com/r/X/" }), captured], autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: { "www.reddit.com": 1_200 } } }),
  }));
  expect(text).toContain("  [truncated for the model: kept 16.0KB of 42.0KB; full sanitized markdown saved to pi-fetch-abc/t0.md]");
  expect(text).toContain("  captured xhr (1 response):");
  expect(text).toContain("[www.reddit.com/svc/shreddit/");
  expect(text).toContain("(200, 18.2KB)");
  expect(text).toContain("AutoThrottle on (start 250ms, max 30000ms, block backoff on) · observed: www.reddit.com 1200ms");
  expect(text.indexOf("AutoThrottle")).toBeGreaterThan(text.indexOf("captured xhr"));

  const quiet = plain(row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page()] }) }));
  expect(quiet).not.toContain("AutoThrottle");
});

it("paints the running marker violet, repaints on settle, and never paints a background", () => {
  const running = row({ targets: [{ url: "https://example.com/" }] }, {
    details: details({ live: [{ targetId: "t0", requestedUrl: "https://www.reddit.com/r/X/", settled: false, kind: "bad" }], pending: true }),
  }, true);
  expect(running.join("\n")).toContain("\x1b[38;2;185;165;232m");
  expect(plain(running)).toContain("  └ www.reddit.com/r/X/  fetching…");

  const settled = row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page()] }) });
  expect(settled.join("\n")).toContain(theme.fg("success", "●"));
  expect(settled.join("\n")).not.toContain("\x1b[38;2;185;165;232m");

  const failed = row({ targets: [{ url: "https://example.com/" }] }, { details: details(), isError: true });
  expect(failed.join("\n")).toContain(theme.fg("error", "●"));

  const cancelled = row({ targets: [{ url: "https://example.com/" }] }, { details: details({ cancelled: true }) });
  expect(plain(cancelled)).toContain("  └ Cancelled.");

  for (const lines of [running, settled, failed, cancelled]) expect(lines.join("\n")).not.toContain("\x1b[48;");

  const wide = page({ truncation: { truncated: true, keptBytes: 16_384, totalBytes: 43_000, outputPath: "p/t0.md" }, capturedXhr: [{ url: "https://example.com/xhr", status: 200, bytes: 100, truncated: true, content: "{}" }] });
  for (const width of [120, 80, 40, 20, 1]) {
    const component = new ToolExecutionComponent("fetch", "w", { targets: [{ url: "https://en.wikipedia.org/wiki/Scrapling" }] }, {}, {
      renderShell: "self", renderCall: renderFetchCall, renderResult: renderFetchResult,
    } as never, { requestRender() {} } as unknown as TUI, process.cwd());
    component.updateResult({ content: [{ type: "text", text: "fetch" }], details: details({ pages: [wide] }), isError: false }, false);
    for (const line of component.render(width)) expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
  }
});

it("strips terminal escapes and control bytes from model-supplied urls", () => {
  expect(shrinkUrl("https://example.com/\u001b[31mred")).toBe("example.com/red");
  expect(shrinkUrl("https://example.com/\u0007bell")).toBe("example.com/bell");
});

it("strips terminal escapes from painted error text too", () => {
  const failed = row({ targets: [{ url: "https://example.com/" }] }, {
    details: details(),
    isError: true,
    text: "all 1 fetch targets failed: https://example.com/\u001b[2Jboom",
  });
  expect(failed.join("\n")).not.toContain("\x1b[2J");
  expect(plain(failed)).toContain("all 1 fetch targets failed: https://example.com/boom");
});
