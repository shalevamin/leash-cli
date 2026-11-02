import { describe, expect, it } from "vitest";
import { guardOpenRouterRequest } from "./openrouter.js";
const body = {
  model: "openai/gpt-4.1-mini",
  messages: [{ role: "user", content: "Hello" }],
};
describe("OpenRouter bounded text adapter", () => {
  it("pins a priced model and tightens upstream provider price ceilings", () => {
    const next = guardOpenRouterRequest({
      ...body,
      provider: {
        only: ["openai"],
        max_price: { prompt: 100, completion: 0.8 },
        allow_fallbacks: true,
      },
    });
    expect(next.provider).toEqual({
      only: ["openai"],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: 0.4, completion: 0.8, request: 0, image: 0 },
    });
    expect(body).not.toHaveProperty("provider");
  });
  it("rejects unknown prices, model fallback and separately charged extensions", () => {
    for (const change of [
      { model: "openrouter/auto" },
      { model: "openai/gpt-4.1-mini:online" },
      { plugins: [] },
      { models: [body.model] },
      { preset: "hidden" },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/x" },
              },
            ],
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "x", cache_control: {} }],
          },
        ],
      },
      { provider: { max_price: { prompt: NaN } } },
    ])
      expect(() => guardOpenRouterRequest({ ...body, ...change })).toThrow();
  });
  it("allows ordinary function schemas without interpreting schema types as media", () => {
    expect(
      guardOpenRouterRequest({
        ...body,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { file: { type: "string" } },
              },
            },
          },
        ],
      }).model,
    ).toBe(body.model);
  });
  it("normalizes one output ceiling and refuses ambiguity or unbounded reasoning", () => {
    const next = guardOpenRouterRequest({ ...body, max_completion_tokens: 90 });
    expect(next.max_tokens).toBe(90);
    expect(next).not.toHaveProperty("max_completion_tokens");
    expect(
      guardOpenRouterRequest({
        ...body,
        max_tokens: 90,
        max_completion_tokens: 90,
      }).max_tokens,
    ).toBe(90);
    for (const change of [
      { max_tokens: 90, max_completion_tokens: 100 },
      { max_tokens: 0 },
      { max_tokens: "100" },
      { max_tokens: Infinity },
      { reasoning: { mode: "pro" } },
      { max_tokens: 100, reasoning: { max_tokens: 100 } },
      { provider: { unknown_extension: true } },
      { provider: { max_price: { future_paid_extension: 1 } } },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "x",
                prompt_cache_breakpoint: { mode: "explicit" },
              },
            ],
          },
        ],
      },
      {
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: {} },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
      expect(() => guardOpenRouterRequest({ ...body, ...change })).toThrow();
  });
});
