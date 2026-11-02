import { describe, expect, it } from "vitest";
import { normalizeUsage, UsageMeter } from "./usage.js";

describe("router usage accounting", () => {
  it("subtracts cached reads and writes from inclusive prompt counts", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
        completion_tokens_details: { reasoning_tokens: 60 },
      }),
    ).toEqual({
      input: 500,
      output: 100,
      cacheRead: 200,
      cacheWrite: 300,
      reasoning: 60,
    });
    expect(
      normalizeUsage(
        {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 300,
        },
        true,
      ),
    ).toMatchObject({ input: 500, cacheRead: 200, cacheWrite: 300 });
  });
  it("records router account cost without deriving or mutating token counts", () => {
    const meter = new UsageMeter();
    const payload =
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"cost":0.0123}}\n\ndata: [DONE]\n\n';
    for (const character of payload) meter.feed(character);
    expect(meter.reportedCost).toBe(0.0123);
    expect(meter.seen && meter.completed).toBe(true);
    expect(meter.usage.input).toBe(100);
    meter.accept({ usage: { cost: 0.001 } });
    expect(meter.reportedCost).toBe(0.0123);
  });
  it("rejects invalid cost values and preserves zero as valid reported cost", () => {
    const meter = new UsageMeter();
    for (const cost of [null, "0.5", NaN, Infinity, -1])
      meter.accept({ usage: { cost } });
    expect(meter.reportedCost).toBeUndefined();
    meter.accept({ usage: { cost: 0 } });
    expect(meter.reportedCost).toBe(0);
    expect(meter.seen).toBe(false);
  });
});
