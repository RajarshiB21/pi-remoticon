import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderFetchCall, renderFetchResult, type RenderableDetails } from "../lib/research/row.js";
import { attempt, page } from "./helpers/research-fixtures.js";

initTheme("dark", false);

const details = (over: Partial<RenderableDetails> = {}): RenderableDetails => ({
  pages: [],
  attempts: [],
  autoThrottle: null,
  browserMode: "none",
  cancelled: false,
  live: [],
  pending: false,
  startedAt: 1000,
  completedAt: 9000,
  maxBlockedRetries: 2,
  inlineBody: true,
  ...over,
});

function row(args: unknown, result: { details: RenderableDetails; isError?: boolean }, isPartial = false, width = 120): string[] {
  const component = new ToolExecutionComponent("fetch", "call-1", args, {}, {
    renderShell: "self",
    renderCall: renderFetchCall,
    renderResult: renderFetchResult,
  } as never, { requestRender() {} } as unknown as TUI, process.cwd());
  component.updateResult(
    { content: [{ type: "text", text: "fetch: 1 target (1 usable, 0 dead ends, 0 failed)" }], details: result.details, isError: result.isError ?? false },
    isPartial,
  );
  return component.render(width);
}

const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(6000));
});
afterEach(() => {
  vi.useRealTimers();
});

const reddit = page({
  targetId: "t0",
  requestedUrl: "https://www.reddit.com/r/SillyTavernAI/comments/1w3z0bb/marinara_preset/",
  finalStatus: 200,
  receivedBytes: 86_221,
  extractedBytes: 43_111,
});
const climbed = [
  attempt({ tier: "http", status: 403, reason: "Forbidden", blockedSignal: "cloudflare-challenge-platform", latencyMs: 312, startedAt: 1000, completedAt: 1312 }),
  attempt({ attempt: 2, tier: "http", status: 403, reason: "Forbidden", blockedSignal: "cloudflare-challenge-platform", latencyMs: 287, startedAt: 2000, completedAt: 2287 }),
  attempt({ attempt: 3, tier: "stealth", status: 200, latencyMs: 4800, startedAt: 1600, completedAt: 6400 }),
];

describe("the fetch tree", () => {
  it("frame 1 — a mixed batch mid-run, with the floor of the tree at full width", () => {
    const text = plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }, { url: "https://example.com/missing" }] }, {
      details: details({
        live: [
          { targetId: "t0", requestedUrl: "https://www.reddit.com/r/SillyTavernAI/comments/1w3z0bb/marinara_preset/", settled: false, kind: "pending" },
          { targetId: "t1", requestedUrl: "https://example.com/missing", settled: true, kind: "warn" },
        ],
        // The live payload carries every target that already settled, so a
        // finished lane paints its facts before the batch ends (spec §4.4).
        pages: [page({ targetId: "t1", requestedUrl: "https://example.com/missing", usable: false, finalStatus: 404, finalReason: "Not Found", deadEndReason: "not found", receivedBytes: 1228, extractedBytes: null })],
        attempts: [
          ...climbed.slice(0, 2),
          attempt({ targetId: "t1", status: 404, reason: "Not Found", latencyMs: 95, startedAt: 1100, completedAt: 1195 }),
        ],
        autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: { "www.reddit.com": 1200 } },
        browserMode: "local",
        pending: true,
      }),
    }, true));
    expect(text).toContain("  ├─ www.reddit.com/r/SillyTavernAI/comments/1w3…reset/");
    expect(text).toContain("  │    ◐ rung 3 of 3");
    expect(text).toContain("  │    └ 403 cloudflare 312ms → 403 cloudflare 287ms");
    expect(text).toContain("  └─ example.com/missing  ✗ 404 → not found · 1.2KB · 95ms");
    expect(text).toContain("  ── ");
    expect(text).toContain("elapsed 5.0s");
  });

  it("frame 2 — the same pages settled, quiet pages costing one line", () => {
    const text = plain(row({ targets: [{ url: "https://en.wikipedia.org/wiki/Scrapling" }] }, {
      details: details({
        pages: [
          reddit,
          page({ targetId: "t1", requestedUrl: "https://en.wikipedia.org/wiki/Scrapling", receivedBytes: 88_473, extractedBytes: 43_111 }),
        ],
        attempts: [
          ...climbed,
          attempt({ targetId: "t1", status: 200, latencyMs: 180, startedAt: 1100, completedAt: 1280 }),
        ],
        autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: { "www.reddit.com": 1200 } },
        browserMode: "local",
      }),
    }));
    // The rung strip is the first fact the width rule drops (spec §4.9), so this
    // lane's strip lives in its rung line at 120 columns, not on the lane line.
    expect(text).toContain("  ├─ www.reddit.com/r/SillyTavernAI/comments/1w3…reset/  ✓ 200 OK · 84.2KB → 42.1KB main · 5.4s");
    expect(text).not.toContain("http 403 ⟶ http 403 ⟶ stealth 200 ✓");
    expect(text).toContain("  │    └ 403 cloudflare 312ms → 403 cloudflare 287ms → 200 4.8s");
    expect(text).toContain("  └─ en.wikipedia.org/wiki/Scrapling  ✓ 200 OK · 86.4KB → 42.1KB main · 180ms   http 200 ✓");
    expect(text).not.toContain("en.wikipedia.org/wiki/Scrapling\n       └");
    expect(text).toContain("throttle 1.2s on www.reddit.com · browser local · 2 blocks · total 8.0s");
  });

  it("frame 3 — a batch that behaved gets no receipt and no rung lines", () => {
    const text = plain(row({ targets: [{ url: "https://example.com/" }] }, {
      details: details({
        pages: [page({ receivedBytes: 12_288, extractedBytes: 9216 })],
        attempts: [attempt({ latencyMs: 300, startedAt: 1000, completedAt: 1300 })],
      }),
    }));
    expect(text).toContain("  └─ example.com/  ✓ 200 OK · 12.0KB → 9.0KB main · 300ms   http 200 ✓");
    expect(text).not.toContain("AutoThrottle");
    expect(text).not.toContain("──");
  });

  it("frame 4 — one URL: the call row names it and no meter exists in the row", () => {
    const lines = row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, { details: details({ pages: [reddit], attempts: climbed, browserMode: "local", autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: {} } }) });
    const text = plain(lines);
    expect(text).toContain("● Fetch(www.reddit.com/r/X/)");
    expect(text).not.toContain("█");
    expect(text).not.toContain("of 1 settled");
  });

  it("frame 5 — a 60-column terminal moves the state to its own line and drops the strip", () => {
    const text = plain(row({ targets: [{ url: "https://en.wikipedia.org/wiki/Scrapling" }] }, {
      details: details({ pages: [page({ requestedUrl: "https://en.wikipedia.org/wiki/Scrapling" })], attempts: [attempt()] }),
    }, false, 60));
    expect(text).toContain("  └─ en.wikipedia.org/wiki/Scrapling");
    expect(text).toContain("       ✓ 200 OK");
    expect(text).not.toContain("http 200 ✓");
  });

  it("states the state of a settled lane whose page record never arrived", () => {
    const text = plain(row({ targets: [{ url: "https://example.com/" }] }, {
      details: details({ live: [{ targetId: "t0", requestedUrl: "https://example.com/", settled: true, kind: "bad" }], pending: true }),
    }, true));
    // The state is known and the facts are not, so it stays one line.
    expect(text).toContain("  └─ example.com/  ✗ failed");
  });

  it("keeps a cancelled batch's settled lanes and states its final duration", () => {
    const text = plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }, { url: "https://example.com/slow" }] }, {
      details: details({
        cancelled: true,
        live: [
          { targetId: "t0", requestedUrl: "https://www.reddit.com/r/SillyTavernAI/comments/1w3z0bb/marinara_preset/", settled: true, kind: "ok" },
          { targetId: "t1", requestedUrl: "https://example.com/slow", settled: false, kind: "pending" },
        ],
        pages: [reddit],
        attempts: [...climbed, attempt({ targetId: "t1", tier: "stealth", status: 403, blockedSignal: "cloudflare-challenge-platform", latencyMs: 900 })],
      }),
    }));
    expect(text).toContain("  ├─ www.reddit.com/r/SillyTavernAI/comments/1w3…reset/");
    expect(text).toContain("✓ 200 OK · 84.2KB → 42.1KB main");
    expect(text).toContain("  └─ example.com/slow");
    expect(text).toContain("  └─ example.com/slow  ✗ cancelled");
    expect(text).not.toContain("◐");
    // A cancelled lane must not keep claiming that it is still climbing.
    expect(text).not.toContain("stealth 403 …");
    expect(text).toContain("3 blocks");
    expect(text).toContain("total 8.0s");
  });

  it("shows the climb on a lane that is still climbing", () => {
    const text = plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, {
      details: details({
        live: [{ targetId: "t0", requestedUrl: "https://www.reddit.com/r/X/", settled: false, kind: "pending" }],
        attempts: climbed.slice(0, 2),
        pending: true,
      }),
    }, true));
    expect(text).toContain("  └─ www.reddit.com/r/X/");
    expect(text).toContain("       ◐ rung 3 of 3   http 403 ⟶ http 403 …");
  });

  it("keeps sizes and durations when the narrow state line has room", () => {
    const text = plain(row({ targets: [{ url: "https://example.com/" }] }, {
      details: details({ pages: [page({ receivedBytes: 12_288, extractedBytes: 9216 })], attempts: [attempt({ latencyMs: 300, startedAt: 1000, completedAt: 1300 })] }),
    }, false, 60));
    expect(text).toContain("       ✓ 200 OK · 12.0KB → 9.0KB main · 300ms");
  });

  it("drops the receipt whole rather than cutting it", () => {
    const loaded = details({
      pages: [page()],
      attempts: [attempt({ blockedSignal: "cloudflare" })],
      browserMode: "local",
      autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: { "example.com": 1200 } },
    });
    const wide = plain(row({ targets: [{ url: "https://example.com/" }] }, { details: loaded }, false, 120));
    expect(wide).toContain("  ── throttle 1.2s on example.com · browser local · 1 block · total 8.0s");
    const narrow = plain(row({ targets: [{ url: "https://example.com/" }] }, { details: loaded }, false, 40));
    expect(narrow).not.toContain("──");
    expect(narrow).toContain("  └─ example.com/");
  });

  it("reads the settled block count from the helper's own receipt", () => {
    const withStats = details({
      pages: [page()],
      attempts: climbed,
      browserMode: "local",
      stats: { blockedCount: 1, failedCount: 0, requestCount: 3 },
    });
    expect(plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, { details: withStats }))).toContain("1 block ·");
    // While the batch runs nothing has settled, so the attempts are the source.
    const live = plain(row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, {
      details: details({ live: [{ targetId: "t0", requestedUrl: "https://www.reddit.com/r/X/", settled: false, kind: "pending" }], attempts: climbed.slice(0, 2), browserMode: "local", pending: true }),
    }, true));
    expect(live).toContain("2 blocks ·");
  });

  it("names the ladder in use when one call carries several pages", () => {
    const text = plain(row({ targets: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }] }, { details: details() }));
    expect(text).toContain("● Fetch(2 URLs concurrently · http → dynamic → stealth)");
    expect(plain(row({ targets: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }], captureXhr: "/api/" }, { details: details() })))
      .toContain("● Fetch(2 URLs concurrently · dynamic → stealth)");
  });

  it("paints no background, marks the running state violet, and strips control sequences", () => {
    const running = row({ targets: [{ url: "https://example.com/" }] }, {
      details: details({ live: [{ targetId: "t0", requestedUrl: "https://example.com/\u001b[2J", settled: false, kind: "pending" }], pending: true }),
    }, true);
    expect(running.join("\n")).toContain("\x1b[38;2;185;165;232m");
    expect(running.join("\n")).not.toContain("\x1b[48;");
    expect(plain(running)).not.toContain("\u001b");

    const settled = row({ targets: [{ url: "https://example.com/" }] }, { details: details({ pages: [page()], attempts: [attempt()] }) });
    expect(plain(settled)).toContain("✓");
    const failed = row({ targets: [{ url: "https://example.com/" }] }, {
      details: details({ pages: [page({ usable: false, finalStatus: null, finalReason: null, receivedBytes: null, extractedBytes: null, error: "connection reset" })], attempts: [attempt({ status: null, reason: "connection reset" })] }),
    });
    expect(plain(failed)).toContain("✗ failed: connection reset");
  });

  it("keeps every line inside the width at every size", () => {
    const loaded = details({
      pages: [reddit, page({ targetId: "t1", requestedUrl: "https://example.com/missing", usable: false, finalStatus: 404, finalReason: "Not Found", deadEndReason: "not found", receivedBytes: 1228, extractedBytes: null, truncation: { truncated: true, keptBytes: 16_384, totalBytes: 43_000, outputPath: "p/t0.md" }, capturedXhr: [{ url: "https://www.reddit.com/svc/shreddit/comments/x", status: 200, bytes: 18_637, truncated: true, content: "{}" }] })],
      attempts: [...climbed, attempt({ targetId: "t1", status: 404, reason: "Not Found", latencyMs: 95, startedAt: 1100, completedAt: 1195 })],
      browserMode: "local",
      autoThrottle: { enabled: true, startDelayMs: 250, maxDelayMs: 30_000, blockBackoff: true, observedDelays: { "www.reddit.com": 1200 } },
    });
    for (const width of [120, 80, 60, 40, 20, 1]) {
      for (const line of row({ targets: [{ url: "https://www.reddit.com/r/X/" }] }, { details: loaded }, false, width)) {
        expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });
});
