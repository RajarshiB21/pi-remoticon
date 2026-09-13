import { describe, expect, it } from "vitest";
import { CANCELLED_SUMMARY, runningSummary, settledSummary } from "../lib/research/summary.js";
import { page } from "./helpers/research-fixtures.js";

describe("group summaries", () => {
  it("names the three states in plain text", () => {
    expect(runningSummary(3)).toBe("Fetching 3 pages…");
    expect(runningSummary(1)).toBe("Fetching 1 page…");
    expect(CANCELLED_SUMMARY).toBe("Fetch cancelled");
    expect(settledSummary([page()])).toBe("Fetched 1 page");
    expect(settledSummary([page(), page({ targetId: "t1" })])).toBe("Fetched 2 pages");
    expect(settledSummary([page(), page({ targetId: "t1", usable: false, deadEndReason: "not found" })])).toBe("Fetched 2 pages · 1 dead end");
    expect(settledSummary([page(), page({ targetId: "t1", usable: false, error: "boom" }), page({ targetId: "t2", usable: false, error: "boom" })])).toBe("Fetched 3 pages · 2 failed");
    expect(settledSummary([page(), page({ targetId: "t1", usable: false, deadEndReason: "not found" }), page({ targetId: "t2", usable: false, error: "boom" })])).toBe("Fetched 3 pages · 1 dead end · 1 failed");
  });

  it("stays free of control characters and ANSI", () => {
    const strings = [runningSummary(2), settledSummary([page({ usable: false, deadEndReason: "x" })]), CANCELLED_SUMMARY];
    // eslint-disable-next-line no-control-regex
    for (const value of strings) expect(value).not.toMatch(/[\u0000-\u001f\u007f]|\x1b\[/);
  });
});
