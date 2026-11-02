import snapshot from "./prices.json" with { type: "json" };
export type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: number;
  cacheWrite1h?: number;
  tiers?: {
    threshold: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
  }[];
};
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheWrite1h?: number;
};
export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});
export const prices: Record<string, Price> = snapshot;
export function priceFor(
  model: string,
  overrides: Record<string, Price> = {},
): Price {
  const p = overrides[model] ?? prices[model];
  if (!p)
    throw new Error(
      `Unknown model ${model}. Add an explicit price override before proxying.`,
    );
  if (
    ![p.input, p.output, p.cacheRead, p.cacheWrite, p.context].every(
      (v) => Number.isFinite(v) && v >= 0,
    ) ||
    p.context <= 0
  )
    throw new Error(`Invalid price for ${model}`);
  if (
    p.cacheWrite1h !== undefined &&
    (!Number.isFinite(p.cacheWrite1h) || p.cacheWrite1h < 0)
  )
    throw new Error(`Invalid cache price for ${model}`);
  if (
    p.tiers !== undefined &&
    (!Array.isArray(p.tiers) ||
      !p.tiers.every((t) =>
        [
          t.threshold,
          t.input,
          t.output,
          t.cacheRead,
          t.cacheWrite,
          t.cacheWrite1h,
        ].every((v) => Number.isFinite(v) && v >= 0),
      ))
  )
    throw new Error(`Invalid price tiers for ${model}`);
  return p;
}
// input excludes cached tokens; output includes reasoning tokens (never charge them twice).
export function cost(
  model: string,
  u: Usage,
  overrides: Record<string, Price> = {},
): number {
  const base = priceFor(model, overrides);
  const total = u.input + u.cacheRead + u.cacheWrite;
  const p =
    [...(base.tiers ?? [])]
      .sort((a, b) => b.threshold - a.threshold)
      .find((t) => total > t.threshold) ?? base;
  const long = Math.min(u.cacheWrite, u.cacheWrite1h ?? 0);
  return (
    Math.ceil(
      (u.input * p.input +
        u.output * p.output +
        u.cacheRead * p.cacheRead +
        (u.cacheWrite - long) * p.cacheWrite +
        long * (p.cacheWrite1h ?? p.cacheWrite)) *
        1e3,
    ) / 1e9
  );
}
export function reserveCost(
  model: string,
  body: Record<string, unknown>,
  overrides: Record<string, Price> = {},
): number {
  const p = priceFor(model, overrides);
  const max = Math.max(
    ...[body.max_tokens, body.max_completion_tokens, body.max_output_tokens]
      .filter((v) => v !== undefined)
      .map(Number),
    ...(body.max_tokens === undefined &&
    body.max_completion_tokens === undefined &&
    body.max_output_tokens === undefined
      ? [4096]
      : []),
  );
  if (!Number.isSafeInteger(max) || max <= 0 || max > p.context)
    throw new Error("Invalid output token ceiling");
  // Reserve the full supported input context: conservative, including server-side response history.
  // This deliberately trades utilization for a bound; text bytes are not a hard tokenizer bound.
  const rates = [p, ...(p.tiers ?? [])];
  const longCache = JSON.stringify(body).includes('"1h"');
  const inputRate = Math.max(
    ...rates.flatMap((r) => [
      r.input,
      r.cacheRead,
      r.cacheWrite,
      ...(longCache ? [r.cacheWrite1h ?? r.cacheWrite] : []),
    ]),
  );
  return (
    Math.ceil(
      (p.context * inputRate + max * Math.max(...rates.map((r) => r.output))) *
        1e3,
    ) / 1e9
  );
}
