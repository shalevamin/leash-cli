import { cost, prices, type Usage } from "./pricing.js";

export const localTools = ["claude-code", "codex", "cursor"] as const;
export type LocalTool = (typeof localTools)[number];
/** One model response read from an agent's own local log. Metadata only. */
export type LocalUsageEvent = {
  tool: LocalTool;
  surface: string;
  sessionId: string;
  eventId: string;
  model: string;
  provider: string;
  usage: Usage;
  ts: string;
  /** Identical consecutive tool calls so far in this session (a loop signal). */
  toolRepeat: number;
};
/** Per-file parser state. Persisted with the file offset so restarts resume exactly. */
export type LocalParserState = {
  sessionId?: string;
  model?: string;
  surface?: string;
  /** Codex: "records" reads token_usage_record, "totals" derives deltas from token_count. */
  mode?: "records" | "totals";
  lastTotal?: Record<string, number>;
  /** First fork header owns the file; replayed parent headers must not replace it. */
  forkSessionId?: string;
  forkTimestamp?: string;
  forkParentId?: string;
  codexOrdinal?: number;
  codexReplayVersion?: 1;
  /** Rebuild ancestry on upgrade without re-reporting already-accounted bytes. */
  replayBackfillThrough?: number;
  replayDone?: boolean;
  /** Hash of the last tool call (name and input). Never leaves the machine. */
  lastTool?: string;
  toolRepeat?: number;
  /** Recent tool IDs suppress repeated log records, bounded for persisted state. */
  seenTools?: string[];
  /** Codex working directory, kept locally; only a keyed hash is reported. */
  cwd?: string;
};
export const LOCAL_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function fnv1a(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
/** Changes whenever the pricing table changes; recorded with every local event. */
export const pricingVersion = `prices-${fnv1a(JSON.stringify(prices))}`;

const n = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const text = (v: unknown, max = 80) =>
  typeof v === "string" ? v.slice(0, max) : undefined;

export function providerFor(model: string) {
  if (/^claude|^anthropic\//.test(model)) return "anthropic";
  if (/^(gpt|o\d|codex|openai\/)/.test(model)) return "openai";
  return "unknown";
}
function versionAtLeast(version: string | undefined, min: [number, number]) {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}
function codexUsage(raw: Record<string, unknown>): Usage {
  const cacheRead = n(raw.cached_input_tokens);
  const cacheWrite = n(raw.cache_write_input_tokens);
  return {
    // Codex input_tokens include cached reads and writes.
    input: Math.max(0, n(raw.input_tokens) - cacheRead - cacheWrite),
    output: n(raw.output_tokens),
    cacheRead,
    cacheWrite,
    reasoning: n(raw.reasoning_output_tokens),
  };
}
function event(
  tool: LocalTool,
  state: LocalParserState,
  eventId: unknown,
  ts: unknown,
  usage: Usage,
  model = state.model,
): LocalUsageEvent | null {
  const sessionId = state.sessionId;
  if (
    !sessionId ||
    !LOCAL_ID.test(sessionId) ||
    typeof eventId !== "string" ||
    !LOCAL_ID.test(eventId) ||
    !model ||
    model === "<synthetic>"
  )
    return null;
  const time = typeof ts === "string" ? Date.parse(ts) : NaN;
  return {
    tool,
    surface: state.surface ?? "unknown",
    sessionId,
    eventId,
    model: model.slice(0, 200),
    provider: providerFor(model),
    usage,
    ts: Number.isFinite(time) ? new Date(time).toISOString() : "",
    toolRepeat: state.toolRepeat ?? 0,
  };
}
/** Counts identical consecutive tool calls; a different call resets the run. */
function observeTool(
  state: LocalParserState,
  name: unknown,
  input: unknown,
  id?: string,
) {
  if (typeof name !== "string") return;
  if (id) {
    if (state.seenTools?.includes(id)) return;
    state.seenTools = [...(state.seenTools ?? []), id].slice(-128);
  }
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? null);
  const hash = fnv1a(`${name}\u0000${raw.slice(0, 65536)}`);
  state.toolRepeat = hash === state.lastTool ? (state.toolRepeat ?? 1) + 1 : 1;
  state.lastTool = hash;
}
function claudeLine(r: any, state: LocalParserState) {
  if (typeof r.sessionId === "string" && state.sessionId !== r.sessionId) {
    state.sessionId = r.sessionId;
    delete state.lastTool;
    delete state.toolRepeat;
    delete state.seenTools;
  }
  if (typeof r.entrypoint === "string") state.surface = text(r.entrypoint);
  if (r.type !== "assistant" || !r.message?.usage) return null;
  if (Array.isArray(r.message.content))
    for (const [index, block] of r.message.content.entries())
      if (block?.type === "tool_use")
        observeTool(
          state,
          block.name,
          block.input,
          block.id ?? `${r.message.id}:${index}`,
        );
  const u = r.message.usage;
  if (typeof u !== "object" || Array.isArray(u)) return null;
  const long = n(u.cache_creation?.ephemeral_1h_input_tokens);
  return event(
    "claude-code",
    state,
    r.message.id,
    r.timestamp,
    {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      reasoning: n(u.output_tokens_details?.thinking_tokens),
      ...(long ? { cacheWrite1h: long } : {}),
    },
    typeof r.message.model === "string" ? r.message.model : undefined,
  );
}
export type CodexTotalObserver = (
  state: LocalParserState,
  signature: string,
  timestamp: string,
) => boolean;
function codexLine(
  r: any,
  state: LocalParserState,
  observeTotal?: CodexTotalObserver,
) {
  const p = r.payload;
  if (!p || typeof p !== "object") return null;
  if (r.type === "session_meta") {
    if (state.forkSessionId) return null;
    const parent =
      p.forked_from_id ??
      p.parent_thread_id ??
      p.source?.subagent?.thread_spawn?.parent_thread_id;
    if (typeof parent === "string" && parent !== p.id) {
      state.forkSessionId = p.id;
      state.forkParentId = parent;
      state.forkTimestamp = text(p.timestamp ?? r.timestamp);
    }
    if (typeof p.id === "string" && p.id !== state.sessionId) {
      state.sessionId = p.id;
      delete state.lastTotal;
      delete state.lastTool;
      delete state.toolRepeat;
      delete state.seenTools;
    }
    state.surface = text(p.originator) ?? state.surface;
    if (typeof p.cwd === "string") state.cwd = p.cwd.slice(0, 4096);
    // Files written by 0.150+ carry per-response records; older ones only totals.
    state.mode ??= versionAtLeast(p.cli_version, [0, 150])
      ? "records"
      : "totals";
    return null;
  }
  if (
    r.type === "response_item" &&
    (p.type === "function_call" || p.type === "custom_tool_call")
  ) {
    observeTool(state, p.name, p.arguments ?? p.input, p.call_id ?? p.id);
    return null;
  }
  if (r.type === "turn_context") {
    if (typeof p.model === "string") state.model = p.model;
    return null;
  }
  if (r.type === "token_usage_record") {
    state.mode = "records";
    // Records carry their original session identity, including replayed responses.
    // Do not let that identity overwrite the file's session for subsequent records.
    const recordState = {
      ...state,
      sessionId:
        typeof p.session_id === "string" ? p.session_id : state.sessionId,
    };
    if (!p.usage || typeof p.usage !== "object") return null;
    return event(
      "codex",
      recordState,
      p.response_id,
      r.timestamp,
      codexUsage(p.usage),
    );
  }
  if (r.type !== "event_msg" || p.type !== "token_count") return null;
  const total = p.info?.total_token_usage;
  if (!total || typeof total !== "object" || Array.isArray(total)) return null;
  const fields = [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  const signature = JSON.stringify(
    [total, p.info.last_token_usage ?? {}].map((u) =>
      fields.map((k) => n(u[k])),
    ),
  );
  // The watcher matches the immutable parent prefix, independent of rewritten timestamps.
  const replay =
    observeTotal?.(state, signature, r.timestamp) ?? !!state.forkParentId;
  state.codexOrdinal = (state.codexOrdinal ?? 0) + 1;
  if (state.mode === "records") return null;
  const last = state.lastTotal;
  const reset =
    !!last &&
    ["input_tokens", "output_tokens", "cached_input_tokens"].some(
      (k) => n(total[k]) < (last[k] ?? 0),
    );
  const delta: Record<string, number> = {};
  for (const k of Object.keys(total))
    delta[k] = reset
      ? n(total[k])
      : Math.max(0, n(total[k]) - (last?.[k] ?? 0));
  // A fork may start at the inherited cumulative total without replaying its prefix.
  // Only last_token_usage belongs to that first new response in that case.
  const raw =
    reset || (!last && state.forkSessionId)
      ? (p.info.last_token_usage ?? (state.forkSessionId ? {} : total))
      : delta;
  state.lastTotal = Object.fromEntries(
    Object.keys(total).map((k) => [k, n(total[k])]),
  );
  // Replay still advances the baseline, but contributes no new usage in the child.
  if (replay) return null;
  if (!Object.values(delta).some((v) => v > 0) && !reset) return null;
  const sum =
    n(total.total_tokens) || n(total.input_tokens) + n(total.output_tokens);
  return event("codex", state, `total:${sum}`, r.timestamp, codexUsage(raw));
}
/** Lines Leash's own Cursor afterAgentResponse hook appends to its spool. */
function cursorLine(r: any, state: LocalParserState) {
  if (r.v !== 1) return null;
  state.sessionId =
    typeof r.conversationId === "string" ? r.conversationId : undefined;
  state.surface = "cursor-agent";
  return event(
    "cursor",
    state,
    r.generationId,
    r.ts,
    {
      input: n(r.input),
      output: n(r.output),
      cacheRead: n(r.cacheRead),
      cacheWrite: n(r.cacheWrite),
      reasoning: 0,
    },
    typeof r.model === "string" ? r.model : undefined,
  );
}
/** Parses one JSONL line, updating per-file state. Returns null for non-usage lines. */
export function parseLocalLine(
  tool: LocalTool,
  line: string,
  state: LocalParserState,
  observeCodexTotal?: CodexTotalObserver,
): LocalUsageEvent | null {
  if (!line.trim()) return null;
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  return tool === "claude-code"
    ? claudeLine(r, state)
    : tool === "codex"
      ? codexLine(r, state, observeCodexTotal)
      : cursorLine(r, state);
}
/** A streaming response is logged repeatedly with growing counters: keep the maximum. */
export function mergeLocalUsage(a: Usage, b: Usage): Usage {
  const long = Math.max(a.cacheWrite1h ?? 0, b.cacheWrite1h ?? 0);
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    reasoning: Math.max(a.reasoning, b.reasoning),
    ...(long ? { cacheWrite1h: long } : {}),
  };
}
/** API-equivalent cost, or null when the model has no price in this table. */
export function localCost(model: string, usage: Usage): number | null {
  try {
    return cost(model, usage);
  } catch {
    return null;
  }
}
export const localEventKey = (e: {
  tool: string;
  sessionId: string;
  eventId: string;
}) => `${e.tool}|${e.sessionId}|${e.eventId}`;
