import { describe, expect, it } from "vitest";
import { optimizeProviderToolOutputs } from "./tool-compression.js";
const text = JSON.stringify(
  Array(40).fill({ resource_name: "prod", resource_state: "ready" }),
  null,
  2,
);
const opts = {
  provider: "openai",
  endpoint: "v1/chat/completions",
  mode: "lossless",
} as const;

describe("provider tool-only compression", () => {
  it("leaves instructions, tool definitions, thinking and original body untouched", () => {
    const body = {
      model: "gpt-4o",
      tools: [{ type: "function", function: { description: text } }],
      messages: [
        { role: "system", content: text },
        { role: "user", content: text },
        { role: "assistant", content: text, thinking: text },
        { role: "tool", tool_call_id: "call-1", content: text },
      ],
    };
    const before = JSON.stringify(body),
      r = optimizeProviderToolOutputs(body, opts);
    expect(JSON.stringify(body)).toBe(before);
    expect(r.summary.changedOutputs).toBe(1);
    expect(r.body.tools).toBe(body.tools);
    expect(r.body.messages.slice(0, 3)).toEqual(body.messages.slice(0, 3));
    expect(r.body.messages[3].content.length).toBeLessThan(text.length);
    expect(
      optimizeProviderToolOutputs(body, { ...opts, mode: "off" }).body,
    ).toBe(body);
  });
  it("supports Responses string function outputs and leaves other input items alone", () => {
    const body = {
      input: [
        { type: "function_call_output", call_id: "c", output: text },
        { type: "message", role: "user", content: text },
        {
          type: "function_call_output",
          call_id: "other",
          output: [{ type: "input_text", text }],
        },
      ],
    };
    const r = optimizeProviderToolOutputs(body, {
      ...opts,
      endpoint: "v1/responses",
    });
    expect(r.summary.changedOutputs).toBe(1);
    expect(r.body.input[1]).toEqual(body.input[1]);
    expect(r.body.input[2]).toEqual(body.input[2]);
  });
  it("skips an entire Anthropic request containing signed thinking", () => {
    const thinking = {
      type: "thinking",
      thinking: text,
      signature: "unchanged",
    };
    const body = {
      system: text,
      messages: [
        { role: "assistant", content: [thinking] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: text },
            {
              type: "tool_result",
              tool_use_id: "b",
              content: text,
              is_error: true,
            },
            { type: "text", text },
            {
              type: "tool_result",
              tool_use_id: "c",
              content: [{ type: "text", text }],
            },
          ],
        },
      ],
    };
    const r = optimizeProviderToolOutputs(body, {
      provider: "anthropic",
      endpoint: "v1/messages",
      mode: "lossless",
    });
    expect(r.summary.changedOutputs).toBe(0);
    expect(r.metadata.observations[0].reason).toBe("signed-content");
    expect(r.body).toBe(body);
    expect(r.body.messages[0].content[0]).toBe(thinking);
    expect(r.body.messages[1].content.slice(1)).toEqual(
      body.messages[1].content.slice(1),
    );
    expect(r.body.system).toBe(text);
  });
  it("skips whole cached-prefix requests and unsupported protocols", () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "a", content: text }],
      system: [
        { type: "text", text: "private", cache_control: { type: "ephemeral" } },
      ],
    };
    expect(optimizeProviderToolOutputs(body, opts).body).toBe(body);
    expect(
      optimizeProviderToolOutputs(
        { ...body, system: undefined, prompt_cache_key: "prefix" },
        opts,
      ).summary.reason,
    ).toContain("passthrough");
    expect(
      optimizeProviderToolOutputs(body, { ...opts, endpoint: "unknown" }).body,
    ).toBe(body);
  });
  it("bounds outputs and leaves malformed messages unchanged", () => {
    const body = {
      messages: [
        null,
        12,
        {},
        { role: "tool", content: text },
        ...Array(50).fill({ role: "tool", tool_call_id: "a", content: text }),
      ],
    };
    const r = optimizeProviderToolOutputs(body, opts);
    expect(r.summary.examinedOutputs).toBe(32);
    expect(r.body.messages.slice(0, 4)).toEqual(body.messages.slice(0, 4));
    expect(r.body.messages.at(-1).content).toBe(text);
    expect(JSON.stringify(r.summary)).not.toContain("resource_name");
  });
});
