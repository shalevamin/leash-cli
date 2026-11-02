import { priceFor, type Price } from "./pricing.js";

// The local adapter supports metered text chat only. Unknown extensions must
// not quietly turn a token reservation into an unbounded paid operation.
const fields = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "min_p",
  "top_a",
  "seed",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "user",
  "provider",
  "n",
  "reasoning",
]);
const providerFields = new Set([
  "order",
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "zdr",
  "enforce_distillable_text",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "preferred_min_throughput",
  "preferred_max_latency",
  "max_price",
]);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, any>, allowed: Set<string>) =>
  Object.keys(value).every((key) => allowed.has(key));
export function guardOpenRouterRequest(
  body: Record<string, any>,
  overrides: Record<string, Price> = {},
): Record<string, any> {
  if (!object(body)) throw new Error("OpenRouter request must be an object");
  if (Object.keys(body).some((key) => !fields.has(key)))
    throw new Error(
      "OpenRouter supports text chat and function tools only; plugins, model fallbacks, presets and paid extensions are blocked",
    );
  if (
    typeof body.model !== "string" ||
    !/^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(body.model)
  )
    throw new Error(
      "Choose an explicitly priced provider/model ID; automatic routers and model variants are not supported",
    );
  const price = priceFor(body.model, overrides);
  if (
    body.max_tokens !== undefined &&
    body.max_completion_tokens !== undefined &&
    body.max_tokens !== body.max_completion_tokens
  )
    throw new Error("Conflicting output ceilings; send one max_tokens value");
  const max = body.max_tokens ?? body.max_completion_tokens ?? 4096;
  if (!Number.isSafeInteger(max) || max <= 0 || max > price.context)
    throw new Error("Invalid output token ceiling");
  // OpenRouter's canonical ceiling covers visible output and supported reasoning.
  // Keeping two aliases can cause a provider to choose a different limit.
  const normalized: Record<string, any> = { ...body, max_tokens: max };
  delete normalized.max_completion_tokens;
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw new Error("OpenRouter messages are required");
  const inspect = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (
      value.type &&
      !["text", "function", "json_schema", "json_object"].includes(value.type)
    )
      throw new Error(
        "OpenRouter media, server tools and cache extensions are not supported",
      );
    if (
      Object.keys(value).some((key) => /^(?:cache_|prompt_cache_)/.test(key)) ||
      "file" in value ||
      "audio" in value ||
      "image_url" in value
    )
      throw new Error(
        "OpenRouter cache writes and non-text inputs need separate pricing support",
      );
    for (const nested of Object.values(value)) inspect(nested);
  };
  // Tool JSON schemas contain arbitrary `type` values; inspect messages only.
  inspect(body.messages);
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool: any) =>
          !object(tool) ||
          tool.type !== "function" ||
          !keys(tool, new Set(["type", "function"])) ||
          !object(tool.function) ||
          !keys(
            tool.function,
            new Set(["name", "description", "parameters", "strict"]),
          ),
      ))
  )
    throw new Error("OpenRouter supports client function tools only");
  if (body.reasoning !== undefined) {
    const reasoning = body.reasoning;
    if (
      !object(reasoning) ||
      !keys(
        reasoning,
        new Set(["enabled", "effort", "max_tokens", "exclude"]),
      ) ||
      !/^(?:openai|anthropic)\//.test(body.model)
    )
      throw new Error(
        "Unreviewed reasoning modes or model-changing extensions are blocked",
      );
    if (
      ["enabled", "exclude"].some(
        (key) =>
          reasoning[key] !== undefined && typeof reasoning[key] !== "boolean",
      ) ||
      (reasoning.effort !== undefined &&
        !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          reasoning.effort,
        )) ||
      (reasoning.max_tokens !== undefined &&
        (!Number.isSafeInteger(reasoning.max_tokens) ||
          reasoning.max_tokens < 0 ||
          reasoning.max_tokens >= max))
    )
      throw new Error("Reasoning must fit within the output token ceiling");
  }
  const selected = body.provider ?? {};
  if (!object(selected) || !keys(selected, providerFields))
    throw new Error("Unreviewed provider preferences are blocked");
  const maxPrice = selected.max_price ?? {};
  if (
    !object(maxPrice) ||
    !keys(maxPrice, new Set(["prompt", "completion", "request", "image"]))
  )
    throw new Error("Invalid provider price ceilings");
  const ceiling = (name: string, maximum: number) => {
    const requested = maxPrice[name];
    if (
      requested !== undefined &&
      (typeof requested !== "number" ||
        !Number.isFinite(requested) ||
        requested < 0)
    )
      throw new Error(
        "Provider price ceilings must be finite nonnegative numbers",
      );
    return Math.min(requested ?? maximum, maximum);
  };
  return {
    ...normalized,
    provider: {
      ...selected,
      allow_fallbacks: false,
      require_parameters: true,
      max_price: {
        prompt: ceiling("prompt", price.input),
        completion: ceiling("completion", price.output),
        request: 0,
        image: 0,
      },
    },
  };
}
