import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cost,
  zeroUsage,
  reserveCost,
  parseLog,
  summarize,
  evaluate,
  defaultPolicy,
  UsageMeter,
} from "./index.js";
const state = {
  killed: false,
  spent: 0,
  reserved: 0,
  daily: 0,
  monthly: 0,
  requests: 0,
  subagents: 0,
  recent: [],
};
describe("pricing", () => {
  it("subtracts cache separately and does not double bill reasoning", () =>
    expect(
      cost("gpt-4o", {
        input: 800,
        output: 100,
        cacheRead: 200,
        cacheWrite: 0,
        reasoning: 50,
      }),
    ).toBeCloseTo(0.00325));
  it("fails closed for unknown models", () =>
    expect(() => cost("made-up", zeroUsage())).toThrow("Unknown"));
  it("bounds against full context and output limit", () =>
    expect(reserveCost("gpt-4o", { max_tokens: 100 })).toBeGreaterThan(0.3));
});
describe("real log formats", () => {
  it("deduplicates Claude assistant chunks by message/request IDs", () => {
    const r = parseLog(
      readFileSync("fixtures/claude-code.jsonl", "utf8"),
      "claude-code",
    );
    expect(r.events).toHaveLength(2);
    expect(r.events[0].usage.output).toBe(150);
    expect(r.warnings).toHaveLength(2);
    expect(r.events[0].usage.input).toBe(1000);
  });
  it("uses cumulative Codex deltas and skips repeated snapshots", () => {
    const r = parseLog(readFileSync("fixtures/codex.jsonl", "utf8"), "codex");
    expect(r.events).toHaveLength(4);
    expect(r.events[1].usage.input).toBe(1200);
    expect(summarize(r.events).requests).toBe(4);
    expect(r.events[1].usage.reasoning).toBe(50);
  });
  it("reports unknown prices instead of zero dollars", () => {
    const r = parseLog(
      '{"type":"assistant","message":{"id":"a","model":"new-model","usage":{"input_tokens":2}}}',
      "claude-code",
    );
    expect(r.events[0].cost).toBeNull();
    expect(summarize(r.events).unpriced).toBe(1);
  });
});
describe("policy", () => {
  it("includes concurrent reservations", () =>
    expect(
      evaluate("gpt-4o", "x", 2, { ...state, reserved: 19 }, defaultPolicy)
        .reason,
    ).toBe("session_budget"));
  it("blocks repeats at threshold and expires old requests", () => {
    const recent = Array.from({ length: 7 }, () => ({
      hash: "x",
      ts: 1000,
      cost: 0,
    }));
    expect(
      evaluate("gpt-4o", "x", 0, { ...state, recent }, defaultPolicy, 2000)
        .reason,
    ).toBe("loop_repeat");
    expect(
      evaluate("gpt-4o", "x", 0, { ...state, recent }, defaultPolicy, 200000)
        .allow,
    ).toBe(true);
  });
  it("learning mode cannot bypass hard caps or kills", () => {
    expect(
      evaluate("x", "h", 21, state, { ...defaultPolicy, learningMode: true })
        .allow,
    ).toBe(false);
    expect(
      evaluate("x", "h", 0, { ...state, killed: true }, defaultPolicy).allow,
    ).toBe(false);
  });
  it("matches wildcard model policies", () =>
    expect(
      evaluate("gpt-4o", "h", 0, state, {
        ...defaultPolicy,
        modelAllowlist: ["claude-*"],
      }).reason,
    ).toBe("model_not_allowed"));
  it("detects velocity and request ceilings", () => {
    expect(
      evaluate(
        "x",
        "h",
        0,
        { ...state, recent: [{ hash: "y", ts: 1000, cost: 20 }] },
        defaultPolicy,
        2000,
      ).reason,
    ).toBe("velocity");
    expect(
      evaluate("x", "h", 0, { ...state, requests: 800 }, defaultPolicy).reason,
    ).toBe("max_requests");
  });
});
it("meters fragmented Anthropic SSE and preserves cache", () => {
  const m = new UsageMeter();
  const s =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":30}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\ndata: {"type":"message_stop"}\n\n';
  for (const ch of s) m.feed(ch);
  expect(m.usage).toMatchObject({ input: 20, cacheRead: 30, output: 12 });
  expect(m.completed).toBe(true);
});

it("prices long context tiers and one-hour cache writes", () => {
  expect(
    cost("claude-sonnet-4-5", {
      input: 210000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 1000,
      cacheWrite1h: 1000,
      reasoning: 0,
    }),
  ).toBeCloseTo(1.27425);
  expect(reserveCost("claude-sonnet-4-5", { max_tokens: 100 })).toBeGreaterThan(
    7.5,
  );
});
