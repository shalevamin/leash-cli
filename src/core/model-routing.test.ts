import { describe, expect, it } from "vitest";
import {
  modelRoutingCandidates,
  modelRoutingFromEnv,
  normalizeModelRouting,
  routeProviderModel,
} from "./model-routing.js";

const body = {
  model: "gpt-4.1",
  input: "Return a short title for this project.",
  max_output_tokens: 200,
};
const base = {
  provider: "openai",
  endpoint: "v1/responses",
  config: {
    mode: "balanced" as const,
    allowlist: ["gpt-4.1-mini"],
    pinnedModels: [],
  },
};
describe("explicit, compatible model routing", () => {
  it("preserves by default and never mutates the original prompt", () => {
    expect(
      routeProviderModel(body, { provider: "openai", endpoint: "v1/responses" })
        .body,
    ).toBe(body);
    const result = routeProviderModel(body, base);
    expect(result.body).toEqual({ ...body, model: "gpt-4.1-mini" });
    expect(body.model).toBe("gpt-4.1");
    expect(result.decision).toMatchObject({
      requestedModel: "gpt-4.1",
      usedModel: "gpt-4.1-mini",
      changed: true,
      reason: "short-text-policy",
    });
    expect(JSON.stringify(result.decision)).not.toContain(body.input);
  });
  it("uses a lower-cost approved candidate for economy and never increases prices", () => {
    const config = {
      mode: "economy" as const,
      allowlist: [...modelRoutingCandidates.openai.economy],
      pinnedModels: [],
    };
    expect(routeProviderModel(body, { ...base, config }).body.model).toBe(
      "gpt-4o-mini",
    );
    expect(
      routeProviderModel({ ...body, model: "gpt-4o-mini" }, base).decision
        .reason,
    ).toBe("not-cheaper");
    const prices = {
      "gpt-4.1-mini": {
        input: 100,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
        context: 100000,
      },
    };
    expect(routeProviderModel(body, { ...base, prices }).body).toBe(body);
  });
  it("requires exact candidate approval and checks both requested and selected model scopes", () => {
    expect(
      routeProviderModel(body, {
        ...base,
        config: { ...base.config, allowlist: [] },
      }).decision.reason,
    ).toBe("no-approved-candidate");
    expect(
      routeProviderModel(body, { ...base, allowedModels: ["gpt-4.1"] }).body,
    ).toBe(body);
    expect(
      routeProviderModel(body, { ...base, allowedModels: ["gpt-4.1-mini"] })
        .decision.reason,
    ).toBe("scope-restricted");
    expect(
      routeProviderModel(body, {
        ...base,
        allowedModels: ["gpt-4.1", "gpt-4.1-mini"],
      }).decision.changed,
    ).toBe(true);
    expect(
      routeProviderModel(body, {
        ...base,
        allowedModels: ["gpt-*"],
        allowScopePrefixes: true,
      }).decision.changed,
    ).toBe(true);
    expect(
      routeProviderModel(body, { ...base, allowedModels: ["gpt-*"] }).decision
        .changed,
    ).toBe(false);
  });
  it("preserves explicitly pinned snapshots and unknown models", () => {
    expect(
      routeProviderModel(body, {
        ...base,
        config: { ...base.config, pinnedModels: [body.model] },
      }).decision.reason,
    ).toBe("pinned-model");
    expect(
      routeProviderModel({ ...body, model: "gpt-5.4-codex" }, base).decision
        .reason,
    ).toBe("unsupported-model");
  });
  it.each([
    { tools: [{ type: "function", name: "search" }] },
    { previous_response_id: "resp_1" },
    { reasoning: { effort: "high" } },
    { thinking: { type: "enabled" } },
    { prompt_cache_key: "private" },
    {
      input: [{ type: "input_image", image_url: "https://example.com/a.png" }],
    },
    { text: { format: { type: "json_schema" } } },
    { mystery_future_option: true },
    { input: [{ type: "function_call_output", output: "result" }] },
    { service_tier: "priority" },
  ])("preserves incompatible or uncertain request surfaces: %j", (change) => {
    const input = { ...body, ...change };
    expect(routeProviderModel(input, base).body).toBe(input);
  });
  it("bounds structural complexity instead of guessing task quality", () => {
    const long = { ...body, input: "x".repeat(5000) };
    expect(routeProviderModel(long, base).decision.reason).toBe(
      "complex-request",
    );
    expect(
      routeProviderModel(long, {
        ...base,
        config: { ...base.config, mode: "economy" },
      }).decision.changed,
    ).toBe(true);
    expect(
      routeProviderModel(body, { ...base, providerExtensions: true }).decision
        .changed,
    ).toBe(false);
  });
  it("routes only plain Anthropic messages to an explicitly approved same-provider model", () => {
    const request = {
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "Write a short title." }],
      system: "Be concise",
      max_tokens: 100,
    };
    const options = {
      provider: "anthropic",
      endpoint: "v1/messages",
      config: {
        mode: "balanced" as const,
        allowlist: [...modelRoutingCandidates.anthropic.balanced],
        pinnedModels: [],
      },
    };
    expect(routeProviderModel(request, options).body.model).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(
      routeProviderModel(
        {
          ...request,
          system: [
            {
              type: "text",
              text: "keep",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        options,
      ).decision.changed,
    ).toBe(false);
    expect(
      routeProviderModel(
        {
          ...request,
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", signature: "signed" }],
            },
          ],
        },
        options,
      ).decision.changed,
    ).toBe(false);
    expect(
      routeProviderModel(request, { ...options, config: base.config }).decision
        .changed,
    ).toBe(false);
  });
  it("validates configuration and allows an explicit env disable", () => {
    expect(normalizeModelRouting()).toEqual({
      mode: "preserve",
      allowlist: [],
      pinnedModels: [],
    });
    expect(() => normalizeModelRouting({ mode: "magic" as any })).toThrow();
    expect(() => normalizeModelRouting({ allowlist: ["gpt-*"] })).toThrow();
    expect(() =>
      normalizeModelRouting({ allowlist: ["unreviewed-model"] }),
    ).toThrow();
    expect(
      modelRoutingFromEnv({ LEASH_MODEL_ROUTING: "preserve" }, base.config)
        .mode,
    ).toBe("preserve");
  });
});
