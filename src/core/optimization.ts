/** Local, deterministic representation changes. Never a billing/tokenizer guarantee. */
export type ToolCompressionMode = "off" | "lossless";
export type OptimizationStrategy =
  "none" | "json-minify" | "json-table" | "line-runs";
export type ToolOptimizationOptions = {
  mode?: ToolCompressionMode;
  maxChars?: number;
};
export type ToolOptimization = {
  output: string;
  changed: boolean;
  strategy: OptimizationStrategy;
  reason:
    | "optimized"
    | "disabled"
    | "empty"
    | "too-large"
    | "not-smaller"
    | "unsupported";
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  savedPercent: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokenSavings: number;
  estimateMethod: string;
};
export const MAX_TOOL_OUTPUT_CHARS = 1_048_576;
export const TOOL_TOKEN_ESTIMATE_METHOD =
  "ceil(UTF-16 code units / 4); heuristic, not provider token counts or invoice savings";
const TABLE_PREFIX =
  "Leash lossless table: each row maps to columns in order.\n";
const LINES_PREFIX =
  "Leash lossless lines: each [count,line] repeats that exact line count times; join with separator.\n";

function settings(options: ToolOptimizationOptions) {
  if (options.mode !== undefined && !["off", "lossless"].includes(options.mode))
    throw new Error("Tool compression mode must be off or lossless");
  if (
    options.maxChars !== undefined &&
    (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1)
  )
    throw new Error("maxChars must be a positive integer");
  return Math.min(
    options.maxChars ?? MAX_TOOL_OUTPUT_CHARS,
    MAX_TOOL_OUTPUT_CHARS,
  );
}

// Remove JSON whitespace only outside strings. Do not round numbers, collapse
// duplicate keys, normalize escapes, or stringify the parsed value.
function compactJson(input: string): string | undefined {
  let quoted = false,
    escaped = false,
    depth = 0,
    start = 0;
  const parts: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "[" || c === "{") {
      if (++depth > 64) return undefined;
    } else if (c === "]" || c === "}") depth--;
    else if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      if (start < i) parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start < input.length) parts.push(input.slice(start));
  try {
    JSON.parse(input); // Syntax validation only; the result is intentionally discarded.
    return parts.join("");
  } catch {
    return undefined;
  }
}

function tableJson(compact: string): string | undefined {
  if (!compact.startsWith("[")) return undefined;
  const records: unknown = JSON.parse(compact);
  if (!Array.isArray(records) || records.length < 2 || records.length > 5_000)
    return undefined;
  if (
    !records[0] ||
    Array.isArray(records[0]) ||
    typeof records[0] !== "object"
  )
    return undefined;
  const columns = Object.keys(records[0]);
  if (!columns.length || columns.length > 64) return undefined;
  const rows: unknown[][] = [];
  for (const record of records) {
    if (
      !record ||
      Array.isArray(record) ||
      typeof record !== "object" ||
      JSON.stringify(Object.keys(record)) !== JSON.stringify(columns)
    )
      return undefined;
    const row = columns.map((column) => record[column]);
    if (row.some((v) => v !== null && typeof v === "object")) return undefined;
    rows.push(row);
  }
  // Exact lexical round trip excludes duplicate keys, unsafe integers, -0,
  // exponent/escape normalization and non-finite parsed number values.
  if (JSON.stringify(records) !== compact) return undefined;
  return (
    TABLE_PREFIX + JSON.stringify({ format: "leash.table.v1", columns, rows })
  );
}

function compactLines(input: string): string | undefined {
  if (!input.includes("\n")) return undefined;
  const separator = input.includes("\r\n") ? "\r\n" : "\n";
  // Mixed endings and lone CRs pass through rather than being normalized.
  if (input.split(separator).some((line) => /[\r\n]/.test(line)))
    return undefined;
  const lines = input.split(separator);
  if (lines.length > 20_000) return undefined;
  const runs: [number, string][] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && last[1] === line) last[0]++;
    else runs.push([1, line]);
  }
  if (runs.length === lines.length) return undefined;
  return (
    LINES_PREFIX + JSON.stringify({ format: "leash.lines.v1", separator, runs })
  );
}

export function optimizeToolOutput(
  input: string,
  options: ToolOptimizationOptions = {},
): ToolOptimization {
  if (typeof input !== "string")
    throw new TypeError("Tool output must be a string");
  const max = settings(options);
  let output = input;
  let strategy: OptimizationStrategy = "none";
  let reason: ToolOptimization["reason"] = "not-smaller";
  if (options.mode === "off") reason = "disabled";
  else if (!input.length) reason = "empty";
  else if (input.length > max) reason = "too-large";
  else {
    const trimmed = input.trimStart();
    const jsonLike = trimmed.startsWith("{") || trimmed.startsWith("[");
    const compact = jsonLike ? compactJson(input) : undefined;
    const candidates: [OptimizationStrategy, string | undefined][] =
      compact !== undefined
        ? [
            ["json-minify", compact],
            [
              "json-table",
              compact === undefined ? undefined : tableJson(compact),
            ],
          ]
        : [["line-runs", compactLines(input)]];
    if (!candidates.some(([, value]) => value !== undefined))
      reason = "unsupported";
    for (const [kind, value] of candidates) {
      if (value !== undefined && value.length < output.length) {
        output = value;
        strategy = kind;
        reason = "optimized";
      }
    }
  }
  const beforeChars = input.length,
    afterChars = output.length;
  const estimatedTokensBefore = Math.ceil(beforeChars / 4),
    estimatedTokensAfter = Math.ceil(afterChars / 4);
  return {
    output,
    changed: strategy !== "none",
    strategy,
    reason,
    beforeChars,
    afterChars,
    savedChars: beforeChars - afterChars,
    savedPercent: beforeChars
      ? ((beforeChars - afterChars) / beforeChars) * 100
      : 0,
    estimatedTokensBefore,
    estimatedTokensAfter,
    estimatedTokenSavings: estimatedTokensBefore - estimatedTokensAfter,
    estimateMethod: TOOL_TOKEN_ESTIMATE_METHOD,
  };
}

/** Identical pure analysis, including preview output, with no network or persistence. */
export function analyzeToolOutput(
  input: string,
  options: ToolOptimizationOptions = {},
): ToolOptimization {
  return optimizeToolOutput(input, options);
}

/** Restores compact JSON (formatting whitespace excluded) or exact original log bytes. */
export function restoreToolOutput(
  output: string,
  strategy: OptimizationStrategy,
): string {
  if (output.length > MAX_TOOL_OUTPUT_CHARS)
    throw new Error("Encoded tool output exceeds size limit");
  if (strategy === "none" || strategy === "json-minify") return output;
  const prefix = strategy === "json-table" ? TABLE_PREFIX : LINES_PREFIX;
  if (!output.startsWith(prefix))
    throw new Error("Unsupported tool-output encoding");
  const encoded = output.slice(prefix.length);
  const value = JSON.parse(encoded);
  // Accept only canonical payloads emitted by this encoder. A crafted decoder
  // input must not silently round unsafe numbers, convert Infinity to null,
  // normalize -0/escapes or discard duplicate keys.
  if (JSON.stringify(value) !== encoded)
    throw new Error("Noncanonical tool-output encoding");
  if (strategy === "json-table") {
    if (
      value.format !== "leash.table.v1" ||
      !Array.isArray(value.columns) ||
      !Array.isArray(value.rows) ||
      value.columns.length > 64 ||
      value.rows.length > 5_000 ||
      value.columns.some((c: unknown) => typeof c !== "string") ||
      new Set(value.columns).size !== value.columns.length ||
      value.rows.some(
        (r: unknown) => !Array.isArray(r) || r.length !== value.columns.length,
      )
    )
      throw new Error("Invalid table encoding");
    let chars = 2;
    const objects: string[] = [];
    for (const row of value.rows as unknown[][]) {
      if (row.some((v) => v !== null && typeof v === "object"))
        throw new Error("Invalid table cell");
      const encoded = JSON.stringify(
        Object.fromEntries(
          value.columns.map((c: string, i: number) => [c, row[i]]),
        ),
      );
      chars += encoded.length + (objects.length ? 1 : 0);
      if (chars > MAX_TOOL_OUTPUT_CHARS)
        throw new Error("Decoded output exceeds size limit");
      objects.push(encoded);
    }
    return "[" + objects.join(",") + "]";
  }
  if (
    value.format !== "leash.lines.v1" ||
    !["\n", "\r\n"].includes(value.separator) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 20_000
  )
    throw new Error("Invalid line encoding");
  let chars = -value.separator.length;
  let lineCount = 0;
  for (const run of value.runs) {
    if (
      !Array.isArray(run) ||
      run.length !== 2 ||
      !Number.isSafeInteger(run[0]) ||
      run[0] < 1 ||
      typeof run[1] !== "string" ||
      /[\r\n]/.test(run[1])
    )
      throw new Error("Invalid line run");
    chars += run[0] * (run[1].length + value.separator.length);
    lineCount += run[0];
    if (chars > MAX_TOOL_OUTPUT_CHARS || lineCount > 20_000)
      throw new Error("Decoded output exceeds size limit");
  }
  return value.runs
    .flatMap(([count, line]: [number, string]) => Array(count).fill(line))
    .join(value.separator);
}
