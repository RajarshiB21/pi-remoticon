import { describe, expect, it } from "vitest";
import { meter, formatDuration, runningSummary, settledSummary, cancelledSummary } from "../lib/research/summary.js";
import { page } from "./helpers/research-fixtures.js";

describe("fetch group-line strings", () => {
  it("fills one meter cell per settled page and leaves the rest empty", () => {
    expect(meter(4, 0)).toBe("▁▁▁▁");
    expect(meter(4, 2)).toBe("██▁▁");
    expect(meter(4, 4)).toBe("████");
    expect(meter(8, 3)).toBe("███▁▁▁▁▁");
    expect(meter(2, 5)).toBe("██");
  });

  it("keeps the running line free of any clock, because it is only recomputed on an update", () => {
    const line = runningSummary(4, 2);
    expect(line).toBe("Fetch 4 pages ██▁▁ 2 of 4 settled");
    expect(line).not.toMatch(/\d+\.\d+s|\d+ms/);
  });

  it("names a single page without a meter", () => {
    expect(runningSummary(1, 0)).toBe("Fetching 1 page");
  });

  it("states a duration only once it is final, and counts dead ends and failures", () => {
    expect(settledSummary([page()], 5400)).toBe("Fetched 1 page · 5.4s");
    expect(settledSummary([page(), page({ usable: false, finalStatus: 404, deadEndReason: "not found" })], 9200))
      .toBe("Fetched 2 pages · 1 dead end · 9.2s");
    expect(settledSummary([page({ usable: false, error: "connection reset" })], null))
      .toBe("Fetched 1 page · 1 failed");
    expect(cancelledSummary(6400)).toBe("Fetch cancelled after 6.4s");
    expect(cancelledSummary(null)).toBe("Fetch cancelled");
  });

  it("uses one unit rule and no control characters", () => {
    expect(formatDuration(120)).toBe("120ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(12_340)).toBe("12.3s");
    for (const line of [runningSummary(8, 4), settledSummary([page()], 5400), cancelledSummary(6400)]) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(line).not.toContain("\x1b");
    }
  });
});
