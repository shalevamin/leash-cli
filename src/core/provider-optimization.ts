import {
  MAX_TOOL_OUTPUT_CHARS,
  optimizeToolOutput,
  type ToolCompressionMode,
} from "./optimization.js";
import {
  safeToolName,
  type RequestOptimization,
  type ToolObservation,
  type ToolOptimizationReason,
} from "./token-xray.js";
type RecordValue = Record<string, any>;
const object = (v: unknown): v is RecordValue =>
  !!v && typeof v === "object" && !Array.isArray(v);
function unsafeReason(body: RecordValue): ToolOptimizationReason | undefined {
  const pending: unknown[] = [body];
  let visited = 0;
  while (pending.length) {
    if (++visited > 20_000) return "request-complexity";
    const value = pending.pop();
    if (value && typeof value === "object") {
      if (
        "cache_control" in value ||
        "prompt_cache_key" in value ||
        "prompt_cache_retention" in value
      )
        return "cache-control";
      if (
        "signature" in value ||
        ("type" in value &&
          ["thinking", "redacted_thinking"].includes(String(value.type)))
      )
        return "signed-content";
      for (const child of Object.values(value))
        if (child && typeof child === "object") pending.push(child);
    }
  }
}
/** The proxy and preview share this transform. Admit/fingerprint the ORIGINAL body first. */
export function optimizeProviderToolOutputs(
  body: RecordValue,
  options: {
    provider: string;
    endpoint: string;
    mode?: ToolCompressionMode;
    /** Optional local observer. Only a boolean is retained; no input or hash enters metadata. */
    observeRepeat?: (name: string, protocol: string, text: string) => boolean;
  },
) {
  const summary = {
    mode: options.mode ?? "lossless",
    changedOutputs: 0,
    examinedOutputs: 0,
    beforeChars: 0,
    afterChars: 0,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    reason: "no-eligible-smaller-output",
  };
  const metadata: RequestOptimization = {
    version: 1,
    mode: summary.mode,
    observations: [],
    truncated: false,
  };
  const blocked = unsafeReason(body);
  if (summary.mode === "off") summary.reason = "disabled";
  else if (blocked) summary.reason = `${blocked}-passthrough`;
  let remaining = MAX_TOOL_OUTPUT_CHARS;
  const names = new Map<string, string>();
  const remember = (id: unknown, name: unknown) => {
    if (typeof id === "string" && names.size < 2048)
      names.set(id, safeToolName(name));
  };
  for (const message of (Array.isArray(body.messages)
    ? body.messages
    : []
  ).slice(0, 2048)) {
    if (!object(message)) continue;
    if (message.role === "assistant") {
      for (const call of (Array.isArray(message.tool_calls)
        ? message.tool_calls
        : []
      ).slice(0, 2048))
        if (object(call)) remember(call.id, call.function?.name);
      for (const call of (Array.isArray(message.content)
        ? message.content
        : []
      ).slice(0, 2048))
        if (object(call) && call.type === "tool_use")
          remember(call.id, call.name);
    }
  }
  for (const call of (Array.isArray(body.input) ? body.input : []).slice(
    0,
    2048,
  ))
    if (object(call) && call.type === "function_call")
      remember(call.call_id, call.name);
  const transform = (
    text: unknown,
    callId: unknown,
    protocol: ToolObservation["protocol"],
    error: boolean,
  ) => {
    if (metadata.observations.length >= 32) {
      metadata.truncated = true;
      return text;
    }
    const name = names.get(String(callId)) ?? "unknown-tool";
    const string = typeof text === "string";
    let reason: ToolOptimizationReason | undefined =
      blocked ?? (error ? "error-output" : !string ? "multimodal" : undefined);
    const measurable = string && text.length <= remaining;
    if (!measurable && string) reason = reason ?? "too-large";
    if (measurable) remaining -= text.length;
    if (!reason && string && /^Leash lossless (?:table|lines):/.test(text))
      reason = "already-optimized";
    const candidate = !reason && string ? optimizeToolOutput(text) : null;
    const changed = summary.mode === "lossless" && !!candidate?.changed;
    const output = changed ? candidate!.output : text;
    reason =
      reason ??
      (summary.mode === "off"
        ? "disabled"
        : (candidate?.reason ?? "unsupported"));
    const before = measurable ? text.length : null;
    const after = measurable ? String(output).length : null;
    const observation: ToolObservation = {
      name,
      protocol,
      originalChars: before,
      forwardedChars: after,
      originalBytes: measurable
        ? new TextEncoder().encode(text).byteLength
        : null,
      forwardedBytes: measurable
        ? new TextEncoder().encode(String(output)).byteLength
        : null,
      estimatedTokensBefore: before === null ? null : Math.ceil(before / 4),
      estimatedTokensAfter: after === null ? null : Math.ceil(after / 4),
      estimatedReducibleTokens:
        summary.mode === "off" ? (candidate?.estimatedTokenSavings ?? 0) : 0,
      reason,
      repeated: measurable
        ? (options.observeRepeat?.(name, protocol, text) ?? false)
        : false,
    };
    metadata.observations.push(observation);
    summary.examinedOutputs++;
    summary.beforeChars += before ?? 0;
    summary.afterChars += after ?? 0;
    summary.estimatedTokensBefore += observation.estimatedTokensBefore ?? 0;
    summary.estimatedTokensAfter += observation.estimatedTokensAfter ?? 0;
    if (changed) {
      summary.changedOutputs++;
      summary.reason = "optimized";
    }
    return output;
  };
  let rewritten = body;
  if (
    options.provider === "openai" &&
    options.endpoint === "v1/chat/completions" &&
    Array.isArray(body.messages)
  ) {
    const messages = body.messages.map((message: unknown) =>
      object(message) &&
      message.role === "tool" &&
      typeof message.tool_call_id === "string"
        ? {
            ...message,
            content: transform(
              message.content,
              message.tool_call_id,
              "openai-chat",
              !!message.is_error,
            ),
          }
        : message,
    );
    if (summary.changedOutputs) rewritten = { ...body, messages };
  } else if (
    options.provider === "openai" &&
    options.endpoint === "v1/responses" &&
    Array.isArray(body.input)
  ) {
    const input = body.input.map((item: unknown) =>
      object(item) &&
      item.type === "function_call_output" &&
      typeof item.call_id === "string"
        ? {
            ...item,
            output: transform(
              item.output,
              item.call_id,
              "openai-responses",
              !!item.is_error,
            ),
          }
        : item,
    );
    if (summary.changedOutputs) rewritten = { ...body, input };
  } else if (
    options.provider === "anthropic" &&
    options.endpoint === "v1/messages" &&
    Array.isArray(body.messages)
  ) {
    const messages = body.messages.map((message: unknown) => {
      if (
        !object(message) ||
        message.role !== "user" ||
        !Array.isArray(message.content)
      )
        return message;
      return {
        ...message,
        content: message.content.map((block: unknown) =>
          object(block) &&
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
            ? {
                ...block,
                content: transform(
                  block.content,
                  block.tool_use_id,
                  "anthropic-messages",
                  !!block.is_error,
                ),
              }
            : block,
        ),
      };
    });
    if (summary.changedOutputs) rewritten = { ...body, messages };
  }
  return { body: rewritten, summary, metadata };
}
