import { zeroUsage, type Usage } from "./pricing.js";
type Obj = Record<string, any>;
const n = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
export function normalizeUsage(raw: Obj, anthropic = false): Usage {
  const cacheRead = n(
    raw.cache_read_input_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.cached_input_tokens,
  );
  const cacheWrite = n(
    raw.cache_creation_input_tokens ??
      raw.prompt_tokens_details?.cache_write_tokens ??
      raw.input_tokens_details?.cache_write_tokens,
  );
  return {
    ...(raw.cache_creation?.ephemeral_1h_input_tokens
      ? { cacheWrite1h: n(raw.cache_creation.ephemeral_1h_input_tokens) }
      : {}),
    input: Math.max(
      0,
      n(raw.input_tokens ?? raw.prompt_tokens) -
        (anthropic ? 0 : cacheRead + cacheWrite),
    ),
    output: n(raw.output_tokens ?? raw.completion_tokens),
    cacheRead,
    cacheWrite,
    reasoning: n(
      raw.output_tokens_details?.reasoning_tokens ??
        raw.completion_tokens_details?.reasoning_tokens ??
        raw.reasoning_output_tokens,
    ),
  };
}
export class UsageMeter {
  usage: Usage = zeroUsage();
  // Optional router account charge, not a provider invoice or an inferred cost.
  // Callers must opt into using this field for protocols that define its units.
  reportedCost: number | undefined;
  seen = false;
  private seenInput = false;
  private seenOutput = false;
  completed = false;
  private buffer = "";
  private data: string[] = [];
  private dataSize = 0;
  accept(obj: Obj) {
    if (!obj || typeof obj !== "object") return;
    const raw = obj.usage ?? obj.message?.usage ?? obj.response?.usage;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (
        typeof raw.cost === "number" &&
        Number.isFinite(raw.cost) &&
        raw.cost >= 0
      )
        this.reportedCost = Math.max(this.reportedCost ?? 0, raw.cost);
      const anthropic =
        obj.type === "message_start" ||
        obj.type === "message_delta" ||
        obj.type === "message";
      const u = normalizeUsage(raw, anthropic);
      if (obj.type === "message_delta") {
        if (raw.output_tokens !== undefined) this.usage.output = u.output;
        if (raw.input_tokens !== undefined) this.usage.input = u.input;
        if (raw.cache_read_input_tokens !== undefined)
          this.usage.cacheRead = u.cacheRead;
        if (raw.cache_creation_input_tokens !== undefined)
          this.usage.cacheWrite = u.cacheWrite;
        if (u.cacheWrite1h !== undefined)
          this.usage.cacheWrite1h = u.cacheWrite1h;
      } else this.usage = u;
      const valid = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0;
      this.seenInput ||= valid(raw.input_tokens ?? raw.prompt_tokens);
      this.seenOutput ||= valid(raw.output_tokens ?? raw.completion_tokens);
      this.seen = anthropic
        ? this.seenInput && this.seenOutput
        : valid(raw.input_tokens ?? raw.prompt_tokens) &&
          valid(raw.output_tokens ?? raw.completion_tokens);
    }
    if (
      ["message_stop", "response.completed"].includes(obj.type) ||
      (!obj.type && obj.usage)
    )
      this.completed = true;
  }
  feed(text: string) {
    this.buffer += text;
    if (this.buffer.length > 8_000_000)
      throw new Error("SSE event exceeds safety limit");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        this.dataSize += line.length;
        if (this.dataSize > 8_000_000)
          throw new Error("SSE event exceeds safety limit");
        this.data.push(line.slice(5).trimStart());
      }
      if (line === "" && this.data.length) {
        const data = this.data.join("\n").trim();
        this.data = [];
        this.dataSize = 0;
        if (data === "[DONE]") {
          this.completed = true;
          continue;
        }
        try {
          this.accept(JSON.parse(data));
        } catch {}
      }
    }
  }
}
