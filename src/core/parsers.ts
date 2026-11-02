import { normalizeUsage } from "./usage.js";
import { cost, type Usage } from "./pricing.js";
export type BurnEvent = {
  id: string;
  sessionId: string;
  timestamp: string;
  model: string;
  provider: string;
  usage: Usage;
  cost: number | null;
};
export type ParseResult = { events: BurnEvent[]; warnings: string[] };
export function parseLog(
  text: string,
  source: "claude-code" | "codex",
  fallbackId = "unknown",
): ParseResult {
  const records = new Map<string, BurnEvent>();
  const warnings: string[] = [];
  let sessionId = fallbackId;
  let model = "unknown";
  let previous: Record<string, number> | undefined;
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      warnings.push(`Line ${i + 1}: malformed JSON skipped`);
      continue;
    }
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      warnings.push(`Line ${i + 1}: non-object record skipped`);
      continue;
    }
    let raw: any;
    let id: string;
    if (source === "claude-code") {
      if (r.type !== "assistant" || !r.message?.usage || !r.message?.id)
        continue;
      sessionId = r.sessionId ?? sessionId;
      model = r.message.model ?? "unknown";
      raw = r.message.usage;
      id = `${sessionId}:${r.message.id}:${r.requestId ?? ""}`;
    } else {
      if (r.type === "session_meta") {
        const next = r.payload?.id ?? sessionId;
        if (next !== sessionId) previous = undefined;
        sessionId = next;
        model = r.payload?.model ?? model;
      }
      if (r.type === "turn_context") model = r.payload?.model ?? model;
      if (
        r.type !== "event_msg" ||
        r.payload?.type !== "token_count" ||
        !r.payload.info
      )
        continue;
      const info = r.payload.info;
      model = info.model ?? r.payload.model ?? model;
      if (info.total_token_usage) {
        const total = info.total_token_usage;
        if (typeof total !== "object" || Array.isArray(total)) {
          warnings.push(`Line ${i + 1}: invalid cumulative usage skipped`);
          continue;
        }
        raw = Object.fromEntries(
          Object.keys(total).map((k) => [
            k,
            Math.max(0, total[k] - (previous?.[k] ?? 0)),
          ]),
        );
        if (
          previous &&
          ["input_tokens", "output_tokens", "cached_input_tokens"].some(
            (k) =>
              typeof total[k] === "number" && total[k] < (previous?.[k] ?? 0),
          )
        )
          raw = info.last_token_usage ?? total;
        previous = total;
        if (!Object.values(raw).some((v) => Number(v) > 0)) continue;
      } else raw = info.last_token_usage;
      if (!raw) continue;
      id = `${sessionId}:${r.timestamp ?? i}:${JSON.stringify(raw)}`;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`Line ${i + 1}: invalid usage skipped`);
      continue;
    }
    const usage = normalizeUsage(raw, source === "claude-code");
    const prior = records.get(id);
    if (prior && source === "claude-code")
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "cacheWrite1h",
      ] as const) {
        usage[key] = Math.max(usage[key] ?? 0, prior.usage[key] ?? 0);
      }
    let amount: number | null = null;
    try {
      amount = cost(model, usage);
    } catch {
      warnings.push(`Unpriced model: ${model}`);
    }
    records.set(id, {
      id,
      sessionId,
      timestamp: prior?.timestamp || r.timestamp || "",
      model,
      provider: source === "claude-code" ? "anthropic" : "openai",
      usage,
      cost: amount,
    });
  }
  return { events: [...records.values()], warnings: [...new Set(warnings)] };
}
export function summarize(events: BurnEvent[]) {
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const sessions = new Map<
    string,
    { id: string; cost: number; requests: number; tokens: number }
  >();
  for (const e of unique) {
    const s = sessions.get(e.sessionId) ?? {
      id: e.sessionId,
      cost: 0,
      requests: 0,
      tokens: 0,
    };
    s.cost += e.cost ?? 0;
    s.requests++;
    s.tokens +=
      e.usage.input + e.usage.output + e.usage.cacheRead + e.usage.cacheWrite;
    sessions.set(s.id, s);
  }
  return {
    cost: unique.reduce((a, e) => a + (e.cost ?? 0), 0),
    requests: unique.length,
    unpriced: unique.filter((e) => e.cost === null).length,
    sessions: [...sessions.values()].sort((a, b) => b.cost - a.cost),
  };
}
