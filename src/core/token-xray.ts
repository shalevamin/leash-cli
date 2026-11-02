/** Metadata only. Token estimates never replace provider usage or invoices. */
export const toolOptimizationReasons = [
  "optimized",
  "disabled",
  "cache-control",
  "signed-content",
  "multimodal",
  "error-output",
  "too-large",
  "request-complexity",
  "already-optimized",
  "not-smaller",
  "unsupported",
  "empty",
] as const;
export type ToolOptimizationReason = (typeof toolOptimizationReasons)[number];
export type ToolObservation = {
  name: string;
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
  originalChars: number | null;
  forwardedChars: number | null;
  originalBytes: number | null;
  forwardedBytes: number | null;
  estimatedTokensBefore: number | null;
  estimatedTokensAfter: number | null;
  estimatedReducibleTokens: number;
  reason: ToolOptimizationReason;
  repeated: boolean;
};
export type RequestOptimization = {
  version: 1;
  mode: "off" | "lossless";
  observations: ToolObservation[];
  routing?: import("./model-routing.js").ModelRoutingDecision;
  truncated: boolean;
};
export function safeToolName(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
    ? value
    : "unknown-tool";
}
export function tokenXray(
  events: {
    id?: string;
    sessionId: string;
    ts: string | Date;
    optimization?: RequestOptimization | null;
  }[],
) {
  const groups = new Map<
    string,
    {
      name: string;
      protocol: string;
      observations: number;
      measuredOutputs: number;
      originalChars: number;
      forwardedChars: number;
      originalBytes: number;
      forwardedBytes: number;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      estimatedReducedTokens: number;
      estimatedReducibleTokens: number;
      compressed: number;
      repeatedOutputs: number;
      skipped: Record<string, number>;
      sessions: Set<string>;
    }
  >();
  const seen = new Set<string>();
  let observedRequests = 0,
    uninstrumentedRequests = 0,
    truncatedRequests = 0;
  for (const event of events) {
    if (event.id && seen.has(event.id)) continue;
    if (event.id) seen.add(event.id);
    const metadata = event.optimization;
    if (
      !metadata ||
      metadata.version !== 1 ||
      !Array.isArray(metadata.observations)
    ) {
      uninstrumentedRequests++;
      continue;
    }
    observedRequests++;
    if (metadata.truncated) truncatedRequests++;
    for (const item of metadata.observations.slice(0, 32)) {
      const name = safeToolName(item.name),
        key = `${item.protocol}:${name}`;
      const row = groups.get(key) ?? {
        name,
        protocol: item.protocol,
        observations: 0,
        measuredOutputs: 0,
        originalChars: 0,
        forwardedChars: 0,
        originalBytes: 0,
        forwardedBytes: 0,
        estimatedTokensBefore: 0,
        estimatedTokensAfter: 0,
        estimatedReducedTokens: 0,
        estimatedReducibleTokens: 0,
        compressed: 0,
        repeatedOutputs: 0,
        skipped: {},
        sessions: new Set<string>(),
      };
      row.observations++;
      row.sessions.add(event.sessionId);
      if (item.repeated) row.repeatedOutputs++;
      if (item.reason === "optimized") row.compressed++;
      else row.skipped[item.reason] = (row.skipped[item.reason] ?? 0) + 1;
      if (item.originalBytes !== null && item.forwardedBytes !== null) {
        row.measuredOutputs++;
        row.originalBytes += item.originalBytes;
        row.forwardedBytes += item.forwardedBytes;
        row.originalChars += item.originalChars ?? 0;
        row.forwardedChars += item.forwardedChars ?? 0;
        row.estimatedTokensBefore += item.estimatedTokensBefore ?? 0;
        row.estimatedTokensAfter += item.estimatedTokensAfter ?? 0;
        row.estimatedReducedTokens += Math.max(
          0,
          (item.estimatedTokensBefore ?? 0) - (item.estimatedTokensAfter ?? 0),
        );
      }
      row.estimatedReducibleTokens += item.estimatedReducibleTokens;
      groups.set(key, row);
    }
  }
  const tools = [...groups.values()]
    .map((row) => ({
      ...row,
      sessions: row.sessions.size,
      recommendation:
        row.estimatedReducibleTokens > 0
          ? "Compression is disabled for reducible output. Enable automatic compression on the device."
          : row.repeatedOutputs >= 3
            ? "This tool result was forwarded repeatedly. Check repeated reads or start a fresh conversation with a handoff."
            : row.skipped["cache-control"]
              ? "Cache-controlled output stays unchanged. Compare cache-hit cost before changing this tool."
              : row.skipped["too-large"]
                ? "Ask the tool for selected fields or fewer rows; oversized results bypass compression."
                : row.compressed > 0
                  ? "Automatic compression is reducing this tool's request context. Keep checking task quality."
                  : "No reversible reduction found. Consider a narrower tool query if this output dominates context.",
    }))
    .sort(
      (a, b) =>
        b.estimatedReducibleTokens - a.estimatedReducibleTokens ||
        b.estimatedReducedTokens - a.estimatedReducedTokens ||
        b.originalBytes - a.originalBytes,
    );
  return {
    observedRequests,
    uninstrumentedRequests,
    truncatedRequests,
    tools,
    totals: tools.reduce(
      (sum, row) => ({
        observations: sum.observations + row.observations,
        originalBytes: sum.originalBytes + row.originalBytes,
        forwardedBytes: sum.forwardedBytes + row.forwardedBytes,
        estimatedReducedTokens:
          sum.estimatedReducedTokens + row.estimatedReducedTokens,
        estimatedReducibleTokens:
          sum.estimatedReducibleTokens + row.estimatedReducibleTokens,
        repeatedOutputs: sum.repeatedOutputs + row.repeatedOutputs,
      }),
      {
        observations: 0,
        originalBytes: 0,
        forwardedBytes: 0,
        estimatedReducedTokens: 0,
        estimatedReducibleTokens: 0,
        repeatedOutputs: 0,
      },
    ),
    estimateMethod:
      "ceil(UTF-16 code units / 4); not provider token counts or invoice savings",
    scope:
      "Tool-result occurrences in forwarded requests, including replayed conversation history. Byte sizes measure UTF-8 tool text, not complete HTTP payloads. Repetition evidence is bounded and does not prove repeated execution.",
  };
}
export type TokenXrayReport = ReturnType<typeof tokenXray>;
