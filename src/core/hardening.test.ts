import { expect, it } from "vitest";
import { parseLog, requestFingerprint, UsageMeter } from "./index.js";
it("rejects primitive records and merges partial Claude usage without losing cache", () => {
  const rows = [
    null,
    12,
    [],
    {
      type: "assistant",
      sessionId: "s",
      message: {
        id: "m",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 80,
          output_tokens: 1,
        },
      },
    },
    {
      type: "assistant",
      sessionId: "s",
      message: {
        id: "m",
        model: "claude-sonnet-4-20250514",
        usage: { output_tokens: 20 },
      },
    },
  ];
  const r = parseLog(
    rows.map((x) => JSON.stringify(x)).join("\n"),
    "claude-code",
  );
  expect(r.warnings).toHaveLength(3);
  expect(r.events).toHaveLength(1);
  expect(r.events[0].usage).toMatchObject({
    input: 40,
    cacheRead: 80,
    output: 20,
  });
});
it("handles Codex counter resets and session boundaries", () => {
  const token = (i: number, o: number) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: i, output_tokens: o } },
    },
  });
  const r = parseLog(
    [
      { type: "session_meta", payload: { id: "a", model: "gpt-4o" } },
      token(100, 50),
      token(120, 5),
      { type: "session_meta", payload: { id: "b" } },
      token(10, 3),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
    "codex",
  );
  expect(r.events.map((x) => [x.usage.input, x.usage.output])).toEqual([
    [100, 50],
    [120, 5],
    [10, 3],
  ]);
});
it("normalizes identical tool calls despite argument order and changing IDs", () => {
  const make = (id: string, args: string) => ({
    model: "gpt-4o",
    input: [
      {
        type: "function_call",
        name: "read_file",
        call_id: id,
        arguments: args,
      },
    ],
  });
  expect(requestFingerprint(make("a", '{"path":"x","limit":3}'))).toBe(
    requestFingerprint(make("b", '{"limit":3,"path":"x"}')),
  );
  expect(requestFingerprint(make("a", '{"path":"x"}'))).not.toBe(
    requestFingerprint(make("a", '{"path":"y"}')),
  );
});
it("meters multiline CRLF SSE and changed cache usage at the end of Anthropic streams", () => {
  const m = new UsageMeter();
  const s =
    'data: {"type":"message_start",\r\ndata: "message":{"usage":{"input_tokens":100,"cache_read_input_tokens":5}}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":40,"cache_read_input_tokens":20}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n';
  for (const ch of s) m.feed(ch);
  expect(m.usage).toMatchObject({ input: 100, output: 40, cacheRead: 20 });
  expect(m.completed).toBe(true);
});
it("meters chat completion cache and reasoning without billing reasoning twice", () => {
  const m = new UsageMeter();
  m.feed(
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":30}}}\n\ndata: [DONE]\n\n',
  );
  expect(m.usage).toMatchObject({
    input: 80,
    cacheRead: 20,
    output: 50,
    reasoning: 30,
  });
  expect(m.completed).toBe(true);
});

it("measures repeated logged tools without retaining their arguments", async () => {
  const { longestToolRepeat } = await import("./log-loops.js");
  const line = (id: string) =>
    JSON.stringify({
      type: "assistant",
      sessionId: "s",
      timestamp: "2026-10-07T10:00:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Read",
            input: { file_path: "secret" },
          },
        ],
      },
    });
  expect(
    longestToolRepeat(
      [line("1"), line("1"), line("2"), line("3")].join("\n"),
      "claude-code",
    ),
  ).toBe(3);
  expect(
    longestToolRepeat(line("1"), "claude-code", Date.parse("2027-01-01")),
  ).toBe(0);
});

it("only relaxes a monetary cap when its own action is explicitly alert", async () => {
  const { evaluate, defaultPolicy } = await import("./policy.js");
  const state = {
    killed: false,
    spent: 30,
    reserved: 0,
    daily: 40,
    monthly: 40,
    requests: 0,
    subagents: 0,
    recent: [],
  };
  expect(evaluate("gpt-4o", "hash", 1, state, defaultPolicy).reason).toBe(
    "session_budget",
  );
  expect(
    evaluate("gpt-4o", "hash", 1, state, {
      ...defaultPolicy,
      sessionAction: "alert",
    }),
  ).toMatchObject({ allow: true, warning: "session_budget_alert" });
  expect(
    evaluate("gpt-4o", "hash", 1, state, {
      ...defaultPolicy,
      sessionAction: "alert",
      dailyCap: 20,
    }).reason,
  ).toBe("daily_budget");
});

it("rejects malformed price tiers and reserves the highest input bucket", async () => {
  const { reserveCost } = await import("./pricing.js");
  const base = {
    input: 1,
    output: 1,
    cacheRead: 50,
    cacheWrite: 1,
    context: 1000,
  };
  expect(
    reserveCost("custom", { max_tokens: 1 }, { custom: base }),
  ).toBeCloseTo(0.050001);
  expect(() =>
    reserveCost(
      "custom",
      { max_tokens: 1 },
      {
        custom: {
          ...base,
          tiers: [
            {
              threshold: 100,
              input: NaN,
              output: 1,
              cacheRead: 1,
              cacheWrite: 1,
              cacheWrite1h: 1,
            },
          ],
        },
      },
    ),
  ).toThrow("Invalid price tiers");
});
it("does not accept missing input/output accounting as complete usage", () => {
  const m = new UsageMeter();
  m.accept({ usage: {}, type: "response.completed" });
  expect(m.seen).toBe(false);
  m.accept({ usage: { output_tokens: 5 } });
  expect(m.seen).toBe(false);
  m.accept({ usage: { input_tokens: 100, output_tokens: 5 } });
  expect(m.seen).toBe(true);
});
