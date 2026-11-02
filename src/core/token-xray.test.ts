import { describe, expect, it } from "vitest";
import { optimizeProviderToolOutputs } from "./provider-optimization.js";
import { tokenXray } from "./token-xray.js";
const text = JSON.stringify(
  Array(40).fill({ resource_name: "PRIVATE_VALUE", health: "ready" }),
  null,
  2,
);
const body = {
  model: "gpt-4o",
  messages: [
    { role: "user", content: "PRIVATE_PROMPT" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "c1",
          function: { name: "read_diagnostics", arguments: "PRIVATE_ARGS" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: text },
  ],
};
const options = { provider: "openai", endpoint: "v1/chat/completions" };
describe("automatic metadata-only Token X-ray", () => {
  it("reduces eligible context automatically and records exact bytes without contents", () => {
    const r = optimizeProviderToolOutputs(body, {
      ...options,
      observeRepeat: () => true,
    });
    const o = r.metadata.observations[0];
    expect(o.name).toBe("read_diagnostics");
    expect(o.reason).toBe("optimized");
    expect(o.repeated).toBe(true);
    expect(o.originalBytes).toBe(new TextEncoder().encode(text).length);
    expect(o.forwardedBytes).toBe(
      new TextEncoder().encode(r.body.messages[2].content).length,
    );
    expect(JSON.stringify(r.metadata)).not.toContain("PRIVATE");
    expect(r.body.messages[0]).toBe(body.messages[0]);
    expect(r.body.messages[1]).toBe(body.messages[1]);
  });
  it("distinguishes UTF-8 bytes from UTF-16 characters and estimates", () => {
    const utf = {
      messages: [
        {
          role: "tool",
          tool_call_id: "u",
          content: ' { "emoji" : "🦆שלום" } ',
        },
      ],
    };
    const r = optimizeProviderToolOutputs(utf, options).metadata
      .observations[0];
    expect(r.originalBytes).toBeGreaterThan(r.originalChars!);
    expect(r.estimatedTokensBefore).toBe(Math.ceil(r.originalChars! / 4));
  });
  it("preserves cached, signed, error, multimodal, oversized and already encoded output", () => {
    for (const [extra, reason] of [
      [{ prompt_cache_key: "k" }, "cache-control"],
      [
        { system: [{ type: "thinking", signature: "signed" }] },
        "signed-content",
      ],
    ] as const) {
      const input = { ...body, ...extra };
      const r = optimizeProviderToolOutputs(input, options);
      expect(r.body).toBe(input);
      expect(r.metadata.observations[0].reason).toBe(reason);
    }
    for (const [content, error, reason] of [
      [text, true, "error-output"],
      [[{ type: "image", data: "secret" }], false, "multimodal"],
      ["x".repeat(1048577), false, "too-large"],
    ] as const) {
      const input = {
        messages: [
          { role: "tool", tool_call_id: "c", content, is_error: error },
        ],
      };
      const r = optimizeProviderToolOutputs(input, options);
      expect(r.body).toBe(input);
      expect(r.metadata.observations[0].reason).toBe(reason);
    }
    const once = optimizeProviderToolOutputs(body, options);
    const twice = optimizeProviderToolOutputs(once.body, options);
    expect(twice.body).toBe(once.body);
    expect(twice.metadata.observations[0].reason).toBe("already-optimized");
  });
  it("ranks real disabled opportunities, tracks missing coverage and deduplicates requests", () => {
    const on = optimizeProviderToolOutputs(body, options).metadata;
    const off = optimizeProviderToolOutputs(
      {
        ...body,
        messages: [{ role: "tool", tool_call_id: "c", content: text }],
      },
      { ...options, mode: "off" },
    ).metadata;
    const event = {
      id: "a",
      sessionId: "s",
      ts: "2026-10-08",
      optimization: on,
    };
    const r = tokenXray([
      event,
      event,
      { id: "b", sessionId: "s", ts: "2026-10-08", optimization: off },
      { id: "old", sessionId: "s", ts: "2026-10-08" },
    ]);
    expect(r.observedRequests).toBe(2);
    expect(r.uninstrumentedRequests).toBe(1);
    expect(r.tools[0].estimatedReducibleTokens).toBeGreaterThan(0);
    expect(r.tools[0].name).toBe("unknown-tool");
    expect(r.totals.observations).toBe(2);
    expect(r.totals.estimatedReducedTokens).toBeGreaterThan(0);
    expect(r.estimateMethod).toContain("not provider");
  });
  it("bounds inspection metadata and sanitizes malicious tool labels", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "c", function: { name: "PRIVATE TOOL PROMPT <script>" } },
          ],
        },
        ...Array(80).fill({ role: "tool", tool_call_id: "c", content: text }),
      ],
    };
    const r = optimizeProviderToolOutputs(input, options);
    expect(r.metadata.observations).toHaveLength(32);
    expect(r.metadata.truncated).toBe(true);
    expect(
      r.metadata.observations.every((x) => x.name === "unknown-tool"),
    ).toBe(true);
    expect(JSON.stringify(r.metadata)).not.toContain("PRIVATE");
  });
});
