import { describe, expect, it } from "vitest";
import { allTargetsFailed, buildDetails, buildModelResult, firstFailureSummary, summaryCounts } from "../lib/research/result.js";
import { PROTOCOL_VERSION, type HelperRequest } from "../lib/research/protocol.js";
import { attempt, batch, page } from "./helpers/research-fixtures.js";

const request: HelperRequest = {
  protocolVersion: PROTOCOL_VERSION,
  batchId: "b-test",
  outputDir: ".",
  targets: [{ id: "t0", url: "https://example.com/" }],
};

describe("buildModelResult", () => {
  it("carries the counts, the dead end and the batch stats", () => {
    const pages = [
      page(),
      page({ targetId: "t1", requestedUrl: "https://example.com/missing", usable: false, finalStatus: 404, finalReason: "Not Found", deadEndReason: "not found" }),
    ];
    const { text } = buildModelResult(batch(pages), [attempt(), attempt({ targetId: "t1", status: 404, reason: "Not Found" })]);
    expect(text).toContain("fetch: 2 targets (1 usable, 1 dead end, 0 failed) | browser mode: none");
    expect(text).toContain("[2/2] https://example.com/missing");
    expect(text).toContain("status dead end: not found");
    expect(text).toContain("http 404 Not Found");
    expect(text).toContain("batch stats: responses 2 | blocks 0 | failed 0");
  });

  it("names a real recovery and a per-target truncation with its saved path", () => {
    const recovered = page({ usedStealth: true });
    const truncated = page({ targetId: "t1", truncation: { truncated: true, keptBytes: 16_384, totalBytes: 43_000, outputPath: "t1.md" } });
    const attempts = [attempt({ blockedSignal: "cloudflare", status: 403, reason: "Forbidden" }), attempt({ attempt: 2, tier: "stealth" })];
    const { text, totalTruncated } = buildModelResult(batch([recovered, truncated]), attempts);
    expect(text).toContain("recovered: first 403 (http) -> final 200 (stealth)");
    expect(text).toContain("[truncated for the model: kept 16.0KB of 42.0KB; full sanitized markdown saved to t1.md]");
    expect(totalTruncated).toBe(false);
  });

  it("bounds the whole result and says so", () => {
    const huge = page({ content: "line\n".repeat(3_000) });
    const { text, totalTruncated } = buildModelResult(batch([huge]), []);
    expect(totalTruncated).toBe(true);
    expect(text).toContain("[fetch output truncated for the model:");
  });
});

describe("details and failure helpers", () => {
  it("builds the receipt and names the first failure", () => {
    const pages = [page({ usable: false, error: "connection reset" })];
    const details = buildDetails(request, null, batch(pages), [], false);
    expect(details.batchId).toBe("b-test");
    expect(details.pages).toHaveLength(1);
    expect(details.browserMode).toBe("none");
    expect(allTargetsFailed(pages)).toBe(true);
    expect(firstFailureSummary(pages)).toBe("https://example.com/");
    expect(firstFailureSummary([page({ usable: false, error: "boom", requestedUrl: "https://example.com/\u001b[2Jx" })])).toBe("https://example.com/x");
    expect(summaryCounts(pages)).toBe("0 usable, 0 dead ends, 1 failed");
    expect(allTargetsFailed([page()])).toBe(false);
  });
});
