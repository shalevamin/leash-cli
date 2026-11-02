import { priceFor, type Price } from "./pricing.js";

export const modelRoutingModes = ["preserve", "balanced", "economy"] as const;
export type ModelRoutingMode = (typeof modelRoutingModes)[number];
export type ModelRoutingConfig = {
  mode: ModelRoutingMode;
  allowlist: string[];
  pinnedModels: string[];
};
/** Deliberately finite, reviewed candidates; never discover/enable a paid model automatically. */
export const modelRoutingCandidates = {
  openai: {
    balanced: ["gpt-4.1-mini"],
    economy: ["gpt-4o-mini", "gpt-4.1-mini"],
  },
  anthropic: {
    balanced: ["claude-haiku-4-5-20251001"],
    economy: ["claude-haiku-4-5-20251001"],
  },
} as const;
export const modelRoutingReasons = [
  "preserve-policy",
  "pinned-model",
  "scope-restricted",
  "unsupported-model",
  "unsupported-request",
  "complex-request",
  "no-approved-candidate",
  "not-cheaper",
  "short-text-policy",
  "client-routed",
] as const;
export type ModelRoutingDecision = {
  version: 1;
  policy: ModelRoutingMode;
  requestedModel: string;
  usedModel: string;
  changed: boolean;
  reason: (typeof modelRoutingReasons)[number];
};
const idPattern = /^[a-zA-Z0-9_.:/-]{1,100}$/;
const supportedCandidates = new Set<string>(
  Object.values(modelRoutingCandidates).flatMap((p) => [
    ...p.balanced,
    ...p.economy,
  ]),
);
export function normalizeModelRouting(
  value?: Partial<ModelRoutingConfig>,
): ModelRoutingConfig {
  const mode = value?.mode ?? "preserve";
  if (!modelRoutingModes.includes(mode))
    throw new Error("Model routing must be preserve, balanced or economy");
  const allowlist = value?.allowlist ?? [],
    pinnedModels = value?.pinnedModels ?? [];
  for (const list of [allowlist, pinnedModels])
    if (
      !Array.isArray(list) ||
      list.length > 100 ||
      !list.every((id) => typeof id === "string" && idPattern.test(id))
    )
      throw new Error(
        "Model routing lists require at most 100 explicit model IDs",
      );
  if (allowlist.some((id) => !supportedCandidates.has(id)))
    throw new Error(
      "Model routing candidate is not in the reviewed compatibility table",
    );
  return {
    mode,
    allowlist: [...new Set(allowlist)],
    pinnedModels: [...new Set(pinnedModels)],
  };
}
export function modelRoutingFromEnv(
  env: Record<string, string | undefined>,
  saved: Partial<ModelRoutingConfig> = {},
) {
  const list = (s: string) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  return normalizeModelRouting({
    mode: (env.LEASH_MODEL_ROUTING ?? saved.mode) as
      ModelRoutingMode | undefined,
    allowlist:
      env.LEASH_MODEL_ROUTING_ALLOWLIST !== undefined
        ? list(env.LEASH_MODEL_ROUTING_ALLOWLIST)
        : saved.allowlist,
    pinnedModels:
      env.LEASH_MODEL_ROUTING_PINNED_MODELS !== undefined
        ? list(env.LEASH_MODEL_ROUTING_PINNED_MODELS)
        : saved.pinnedModels,
  });
}
const knownRequests = {
  openai: new Set([
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
  ]),
  anthropic: new Set([
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
  ]),
};
/** Workspace policy uses '*' globs; gateway key scopes and candidate approval stay exact. */
export function routingScopeAllows(
  model: string,
  scope: string[] = [],
  prefix = false,
) {
  return (
    !scope.length ||
    scope.some(
      (id) =>
        id === model ||
        (prefix &&
          new RegExp(
            "^" +
              id
                .split("*")
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join(".*") +
              "$",
          ).test(model)),
    )
  );
}

/** A structural policy, not a quality classifier. Changes only body.model, never prompts. */
export function routeProviderModel<T extends Record<string, any>>(
  body: T,
  options: {
    provider: string;
    endpoint: string;
    config?: Partial<ModelRoutingConfig>;
    allowedModels?: string[];
    allowScopePrefixes?: boolean;
    workspaceModels?: string[];
    providerExtensions?: boolean;
    prices?: Record<string, Price>;
  },
): { body: T; decision: ModelRoutingDecision } {
  const config = normalizeModelRouting(options.config),
    requested = String(body.model ?? "");
  const keep = (reason: ModelRoutingDecision["reason"]) => ({
    body,
    decision: {
      version: 1 as const,
      policy: config.mode,
      requestedModel: requested,
      usedModel: requested,
      changed: false,
      reason,
    },
  });
  if (config.mode === "preserve") return keep("preserve-policy");
  if (config.pinnedModels.includes(requested)) return keep("pinned-model");
  const allowed = (model: string) =>
    routingScopeAllows(
      model,
      options.allowedModels,
      options.allowScopePrefixes,
    ) && routingScopeAllows(model, options.workspaceModels, true);
  if (!allowed(requested)) return keep("scope-restricted");
  if (!(["openai", "anthropic"] as string[]).includes(options.provider))
    return keep("unsupported-model");
  const provider = options.provider as "openai" | "anthropic";
  if (!knownRequests[provider].has(requested)) return keep("unsupported-model");
  const protocol =
    provider === "anthropic" && options.endpoint === "v1/messages"
      ? "anthropic"
      : provider === "openai" && options.endpoint === "v1/chat/completions"
        ? "chat"
        : provider === "openai" && options.endpoint === "v1/responses"
          ? "responses"
          : null;
  if (!protocol || options.providerExtensions)
    return keep("unsupported-request");
  // An allowlist of request fields makes new provider semantics preserve by default.
  const common = [
    "model",
    "stream",
    "temperature",
    "top_p",
    "metadata",
    "tools",
    "service_tier",
  ];
  const fields = new Set([
    ...common,
    ...(protocol === "responses"
      ? ["input", "instructions", "max_output_tokens", "store"]
      : protocol === "anthropic"
        ? ["messages", "system", "max_tokens", "stop_sequences"]
        : [
            "messages",
            "max_tokens",
            "max_completion_tokens",
            "stream_options",
            "stop",
            "n",
          ]),
  ]);
  if (
    Object.keys(body).some((key) => !fields.has(key)) ||
    (body.tools !== undefined &&
      (!Array.isArray(body.tools) || body.tools.length > 0)) ||
    (body.service_tier !== undefined && body.service_tier !== "default") ||
    (body.n !== undefined && body.n !== 1)
  )
    return keep("unsupported-request");
  let messages = 1;
  let text: string;
  if (protocol === "responses") {
    // Stateful, function-call and multipart inputs intentionally retain the requested model.
    if (
      typeof body.input !== "string" ||
      (body.instructions !== undefined && typeof body.instructions !== "string")
    )
      return keep("unsupported-request");
    text = body.input + (body.instructions ?? "");
  } else {
    if (
      !Array.isArray(body.messages) ||
      !body.messages.length ||
      body.messages.some(
        (m: any) =>
          !m ||
          typeof m !== "object" ||
          Object.keys(m).some((key) => !["role", "content"].includes(key)) ||
          !["system", "user", "assistant", "developer"].includes(m.role) ||
          typeof m.content !== "string",
      ) ||
      (body.system !== undefined && typeof body.system !== "string")
    )
      return keep("unsupported-request");
    messages = body.messages.length;
    text =
      body.messages.map((m: any) => m.content).join("") + (body.system ?? "");
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  const output =
    Math.max(
      ...[body.max_tokens, body.max_completion_tokens, body.max_output_tokens]
        .filter((v) => v !== undefined)
        .map(Number),
      0,
    ) || 4096;
  if (
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    output > (config.mode === "balanced" ? 4096 : 8192) ||
    messages > (config.mode === "balanced" ? 4 : 12) ||
    bytes > (config.mode === "balanced" ? 4000 : 16000)
  )
    return keep("complex-request");
  const candidates = modelRoutingCandidates[provider][config.mode].filter(
    (model) => config.allowlist.includes(model) && allowed(model),
  );
  if (!candidates.length) return keep("no-approved-candidate");
  const originalPrice = priceFor(requested, options.prices);
  const model = candidates.find((id) => {
    const p = priceFor(id, options.prices);
    return (
      id !== requested &&
      p.input <= originalPrice.input &&
      p.output <= originalPrice.output &&
      p.cacheRead <= originalPrice.cacheRead &&
      p.cacheWrite <= originalPrice.cacheWrite &&
      (p.input < originalPrice.input || p.output < originalPrice.output) &&
      bytes + output < p.context
    );
  });
  if (!model) return keep("not-cheaper");
  return {
    body: { ...body, model },
    decision: {
      version: 1,
      policy: config.mode,
      requestedModel: requested,
      usedModel: model,
      changed: true,
      reason: "short-text-policy",
    },
  };
}
