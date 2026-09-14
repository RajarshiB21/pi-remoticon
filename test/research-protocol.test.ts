import { describe, it, expect } from "vitest";
import {
  assertBatchId, pageLadder, parseHelperEvent, PROTOCOL_VERSION, ProtocolError,
} from "../lib/research/protocol.js";
import { attempt, page } from "./helpers/research-fixtures.js";

const envelope = (type: string, extra: Record<string, unknown> = {}, batchId: string | null = "b-1") =>
  JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, batchId, ...extra });

describe("parseHelperEvent", () => {
  it("accepts every envelope and rejects anything else", () => {
    expect(parseHelperEvent("")).toBeNull();
    expect(parseHelperEvent("   ")).toBeNull();
    expect(parseHelperEvent(envelope("batch_started"))?.type).toBe("batch_started");
    expect(parseHelperEvent(envelope("attempt_finished"))?.type).toBe("attempt_finished");
    expect(parseHelperEvent(envelope("target_finished"))?.type).toBe("target_finished");
    expect(parseHelperEvent(envelope("batch_finished"))?.type).toBe("batch_finished");
    expect(parseHelperEvent(envelope("fatal_error", { error: "x" }, null))?.type).toBe("fatal_error");
    expect(() => parseHelperEvent("not json")).toThrow(ProtocolError);
    expect(() => parseHelperEvent("[1,2]")).toThrow(/JSON object/);
    expect(() => parseHelperEvent(JSON.stringify({ protocolVersion: PROTOCOL_VERSION - 1, type: "batch_started", batchId: "b-1" }))).toThrow(/protocolVersion/);
    expect(() => parseHelperEvent(envelope("surprise"))).toThrow(/unknown event type/);
    expect(() => parseHelperEvent(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "batch_started" }))).toThrow(/no batchId/);
    expect(() => parseHelperEvent(envelope("batch_started", {}, ""))).toThrow(/no batchId/);
  });

  it("checks batch identity, allowing only a pre-batch fatal_error", () => {
    const started = parseHelperEvent(envelope("batch_started"))!;
    expect(() => assertBatchId(started, "b-1")).not.toThrow();
    expect(() => assertBatchId(started, "b-2")).toThrow(/batchId/);
    const fatal = parseHelperEvent(envelope("fatal_error", { error: "x" }, null))!;
    expect(() => assertBatchId(fatal, "b-1")).not.toThrow();
  });
});

describe("pageLadder", () => {
  it("derives escalation only from real attempt records", () => {
    expect(pageLadder(page(), [attempt()])).toBeNull();

    const blocked = [attempt({ blockedSignal: "cloudflare", status: 403, reason: "Forbidden" }), attempt({ attempt: 2, tier: "stealth" })];
    expect(pageLadder(page({ usedStealth: true }), blocked)).toEqual({
      firstStatus: 403, firstTier: "http", finalTier: "stealth", recovered: true, firstKind: "blocked",
    });

    const empty = [attempt({ unusableSignal: "empty content" }), attempt({ attempt: 2, tier: "dynamic" })];
    expect(pageLadder(page(), empty)?.firstKind).toBe("empty");

    const transport = [attempt({ status: null, reason: "connection reset" }), attempt({ attempt: 2, tier: "stealth" })];
    expect(pageLadder(page(), transport)?.firstKind).toBe("failed");

    const gaveUp = [attempt({ blockedSignal: "cloudflare", status: 403 }), attempt({ attempt: 2, tier: "stealth", blockedSignal: "cloudflare", status: 403 })];
    expect(pageLadder(page({ usable: false, deadEndReason: "blocked after 2 attempts, including stealth" }), gaveUp)?.recovered).toBe(false);
  });
});
