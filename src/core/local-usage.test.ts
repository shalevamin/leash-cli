import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseLocalLine,
  mergeLocalUsage,
  localCost,
  localEventKey,
  pricingVersion,
  type LocalParserState,
  type LocalTool,
  type LocalUsageEvent,
} from "./local-usage.js";
import { cost } from "./pricing.js";

function parse(tool: LocalTool, file: string, state: LocalParserState = {}) {
  const events: LocalUsageEvent[] = [];
  for (const line of readFileSync(`fixtures/local-agent/${file}`, "utf8").split(
    "\n",
  )) {
    const e = parseLocalLine(tool, line, state);
    if (e) events.push(e);
  }
  return { events, state };
}

describe("Claude Code session logs", () => {
  it("emits one usage event per log line with stable message ids", () => {
    const { events } = parse("claude-code", "claude-session.jsonl");
    expect(events.map((e) => e.eventId)).toEqual([
      "msg_fixture_1",
      "msg_fixture_1",
      "msg_fixture_2",
    ]);
    const [first, second, third] = events;
    expect(first).toMatchObject({
      tool: "claude-code",
      surface: "claude-desktop",
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "claude-opus-5-5",
      provider: "anthropic",
      ts: "2026-10-18T10:00:03.000Z",
    });
    expect(second.usage).toEqual({
      input: 2,
      output: 631,
      cacheRead: 41111,
      cacheWrite: 30905,
      cacheWrite1h: 30905,
      reasoning: 176,
    });
    expect(third.usage.cacheWrite1h).toBeUndefined();
  });
  it("never carries prompt, response or tool content", () => {
    const { events } = parse("claude-code", "claude-session.jsonl");
    expect(JSON.stringify(events)).not.toMatch(/FIXTURE/);
  });
  it("skips synthetic, malformed and cost-state lines", () => {
    const state: LocalParserState = {};
    expect(parseLocalLine("claude-code", "not json", state)).toBeNull();
    expect(parseLocalLine("claude-code", "[1,2]", state)).toBeNull();
    expect(
      parseLocalLine(
        "claude-code",
        '{"type":"assistant","sessionId":"s1","message":{"id":"m","model":"<synthetic>","usage":{"output_tokens":1}}}',
        state,
      ),
    ).toBeNull();
    expect(
      parseLocalLine(
        "claude-code",
        '{"type":"assistant","sessionId":"bad id with spaces","message":{"id":"m","model":"claude-opus-5-5","usage":{"output_tokens":1}}}',
        {},
      ),
    ).toBeNull();
  });
});

describe("Codex rollout logs", () => {
  it("uses per-response records and ignores the duplicate token_count", () => {
    const { events } = parse("codex", "codex-rollout.jsonl");
    expect(events.map((e) => e.eventId)).toEqual([
      "resp_fixture_1",
      "resp_fixture_2",
      "resp_fixture_3",
    ]);
    expect(events[0]).toMatchObject({
      tool: "codex",
      surface: "Codex Desktop",
      sessionId: "22222222-2222-4222-8222-222222222222",
      model: "gpt-6-sol",
      provider: "openai",
    });
    expect(events[1].usage).toEqual({
      input: 29522 - 19712,
      output: 426,
      cacheRead: 19712,
      cacheWrite: 0,
      reasoning: 159,
    });
    expect(events[2].model).toBe("codex-auto-review");
    expect(JSON.stringify(events)).not.toMatch(/FIXTURE/);
  });
  it("derives deltas from cumulative totals in legacy files", () => {
    const { events, state } = parse("codex", "codex-legacy.jsonl");
    expect(state.mode).toBe("totals");
    expect(events.map((e) => e.eventId)).toEqual(["total:1050", "total:2590"]);
    expect(events[0].usage).toEqual({
      input: 800,
      output: 50,
      cacheRead: 200,
      cacheWrite: 0,
      reasoning: 10,
    });
    expect(events[1].usage).toEqual({
      input: 500,
      output: 40,
      cacheRead: 1000,
      cacheWrite: 0,
      reasoning: 0,
    });
  });
  it("resumes from persisted state without re-emitting earlier totals", () => {
    const lines = readFileSync(
      "fixtures/local-agent/codex-legacy.jsonl",
      "utf8",
    ).split("\n");
    const state: LocalParserState = {};
    for (const line of lines.slice(0, 3)) parseLocalLine("codex", line, state);
    const restored: LocalParserState = JSON.parse(JSON.stringify(state));
    const later = lines
      .slice(3)
      .map((l) => parseLocalLine("codex", l, restored))
      .filter(Boolean);
    expect(later.map((e) => e!.eventId)).toEqual(["total:2590"]);
  });
  it("treats a counter reset as a new run", () => {
    const state: LocalParserState = {
      sessionId: "s1",
      model: "gpt-5.5",
      mode: "totals",
      lastTotal: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
    };
    const e = parseLocalLine(
      "codex",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      }),
      state,
    );
    expect(e?.usage).toMatchObject({ input: 10, output: 2 });
  });
});

describe("Cursor hook spool", () => {
  it("reads usage the Leash afterAgentResponse hook recorded", () => {
    const { events } = parse("cursor", "cursor-spool.jsonl");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool: "cursor",
      surface: "cursor-agent",
      sessionId: "44444444-4444-4444-8444-444444444444",
      eventId: "55555555-5555-4555-8555-555555555555",
      provider: "anthropic",
      usage: { input: 1200, output: 300, cacheRead: 5000 },
    });
    expect(events[1].provider).toBe("unknown");
  });
});

describe("pricing", () => {
  it("prices known models and leaves unknown ones unpriced", () => {
    const usage = {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };
    expect(localCost("claude-sonnet-4-6", usage)).toBe(
      cost("claude-sonnet-4-6", usage),
    );
    expect(localCost("claude-sonnet-4-6", usage)).toBeCloseTo(0.018, 9);
    expect(localCost("codex-auto-review", usage)).toBeNull();
  });
  it("prices 1h cache writes at the 1h rate", () => {
    const base = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      reasoning: 0,
    };
    expect(
      localCost("claude-opus-5-5", { ...base, cacheWrite1h: 1_000_000 })!,
    ).toBeGreaterThan(localCost("claude-opus-5-5", base)!);
  });
  it("has a stable, content-derived pricing version", () => {
    expect(pricingVersion).toMatch(/^prices-[0-9a-f]{8}$/);
  });
});

describe("merging and keys", () => {
  it("keeps the largest value of every counter", () => {
    expect(
      mergeLocalUsage(
        { input: 2, output: 120, cacheRead: 5, cacheWrite: 0, reasoning: 100 },
        {
          input: 2,
          output: 631,
          cacheRead: 5,
          cacheWrite: 7,
          reasoning: 90,
          cacheWrite1h: 7,
        },
      ),
    ).toEqual({
      input: 2,
      output: 631,
      cacheRead: 5,
      cacheWrite: 7,
      reasoning: 100,
      cacheWrite1h: 7,
    });
  });
  it("keys events by tool, session and event id", () => {
    expect(localEventKey({ tool: "codex", sessionId: "s", eventId: "e" })).toBe(
      "codex|s|e",
    );
  });
});
