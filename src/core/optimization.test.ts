import { describe, expect, it } from "vitest";
import {
  analyzeToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
  optimizeToolOutput,
  restoreToolOutput,
} from "./optimization.js";

describe("local lossless tool-output optimization", () => {
  it("removes only JSON formatting while preserving unsafe numbers, duplicate keys and escapes", () => {
    const source =
      ' { "large" : 9007199254740993, "n":1e999, "dup":1, "dup":2, "minus":-0, "s":"\\ud800 \\n \\u0061 \\"" } \n';
    const result = optimizeToolOutput(source);
    expect(result.strategy).toBe("json-minify");
    expect(result.output).toBe(
      '{"large":9007199254740993,"n":1e999,"dup":1,"dup":2,"minus":-0,"s":"\\ud800 \\n \\u0061 \\""}',
    );
  });
  it("creates self-described tables that exactly restore canonical object arrays", () => {
    const values = Array.from({ length: 100 }, (_, i) => ({
      deployment_status: "healthy",
      deployment_region: "eu",
      deployment_index: i,
      allowed: true,
      optional: null,
    }));
    const source = JSON.stringify(values, null, 2),
      r = optimizeToolOutput(source);
    expect(r.strategy).toBe("json-table");
    expect(r.output).toContain("each row maps to columns in order");
    expect(restoreToolOutput(r.output, r.strategy)).toBe(
      JSON.stringify(values),
    );
    expect(r.afterChars).toBeLessThan(r.beforeChars);
  });
  it("never table-encodes precision loss, duplicate keys or normalized escapes", () => {
    for (const bad of [
      '{"long_column":9007199254740993}',
      '{"long_column":1e999}',
      '{"long_column":1,"long_column":2}',
      '{"long_column":"\\ud800"}',
      '{"long_column":-0}',
      '{"long_column":1e3}',
      '{"long_column":"\\u0061"}',
    ]) {
      const input = "[" + Array(100).fill(bad).join(",") + "]";
      const result = optimizeToolOutput(input);
      // A lone surrogate is already canonical; its exact lexical round-trip is safe.
      if (result.strategy === "json-table")
        expect(restoreToolOutput(result.output, result.strategy)).toBe(input);
      else expect(result.output).toBe(input);
    }
  });
  it("keeps nested, heterogeneous, differently ordered or sparse-shaped records intact", () => {
    for (const input of [
      '[{"x":1},{"y":2}]',
      '[{"x":1,"y":2},{"y":2,"x":1}]',
      '[{"x":{}},{"x":{}}]',
      "[null,null]",
      "[1,2,3]",
    ])
      expect(optimizeToolOutput(input).output).toBe(input);
  });
  it("preserves prototype-like keys without prototype mutation", () => {
    const input =
      "[" +
      Array(100)
        .fill('{"__proto__":"plain data","constructor":"also data"}')
        .join(",") +
      "]";
    const r = optimizeToolOutput(input);
    expect(r.strategy).toBe("json-table");
    expect(restoreToolOutput(r.output, r.strategy)).toBe(input);
    expect(Object.prototype).not.toHaveProperty("plain data");
  });
  it("compacts adjacent duplicate log lines and restores errors, blank lines and CRLF exactly", () => {
    for (const sep of ["\n", "\r\n"]) {
      const input = [
        "ERROR: connection refused",
        ...Array(100).fill("INFO: polling job with unchanged status"),
        "WARNING: deadline reached",
        "",
        "",
      ].join(sep);
      const r = optimizeToolOutput(input);
      expect(r.strategy).toBe("line-runs");
      expect(r.output).toContain("count,line");
      expect(r.output).toContain("ERROR: connection refused");
      expect(r.output).toContain("WARNING: deadline reached");
      expect(restoreToolOutput(r.output, r.strategy)).toBe(input);
    }
  });
  it("recognizes bracket-prefixed log lines when they are not JSON and restores their exact text", () => {
    for (const prefix of [
      "[INFO]",
      "[2026-10-08T14:10:00Z]",
      "{invalid-json}",
    ]) {
      const input = `${prefix} polling job with unchanged status\n`.repeat(100);
      const result = optimizeToolOutput(input);
      expect(result.strategy).toBe("line-runs");
      expect(restoreToolOutput(result.output, result.strategy)).toBe(input);
    }
  });
  it("does not rewrite arbitrary prose, invalid JSON, mixed line endings or already compact output", () => {
    for (const input of [
      "a\nb\na\nb",
      '{"invalid":NaN}',
      '{ "missing": }',
      "repeated\r\nrepeated\n".repeat(100),
      "Hello, world",
      '{"hello":"world"}',
      '{"text":"never alter this    string"}',
    ]) {
      const r = analyzeToolOutput(input);
      expect(r.output).toBe(input);
      expect(r.changed).toBe(false);
      expect(r.savedChars).toBe(0);
    }
  });
  it("never emits a longer representation, and estimates are transparently heuristic", () => {
    const r = optimizeToolOutput("line\nline");
    expect(r.output).toBe("line\nline");
    expect(r.estimatedTokensBefore).toBe(Math.ceil(r.beforeChars / 4));
    expect(r.estimateMethod).toContain("not provider token counts");
    expect(analyzeToolOutput("")).toMatchObject({
      reason: "empty",
      savedPercent: 0,
    });
  });
  it("bounds input size and nesting; off means byte-identical pass-through", () => {
    expect(
      optimizeToolOutput("x".repeat(MAX_TOOL_OUTPUT_CHARS + 1)).reason,
    ).toBe("too-large");
    expect(optimizeToolOutput(' {"x":1} ', { maxChars: 3 }).reason).toBe(
      "too-large",
    );
    const deep = "[".repeat(1000) + " 1 " + "]".repeat(1000);
    expect(optimizeToolOutput(deep).output).toBe(deep);
    expect(optimizeToolOutput(' {"x":1} ', { mode: "off" })).toMatchObject({
      output: ' {"x":1} ',
      reason: "disabled",
    });
    expect(() => optimizeToolOutput("a", { maxChars: 0 })).toThrow();
    expect(() => optimizeToolOutput("a", { mode: "lossy" as any })).toThrow();
  });
  it("rejects crafted decoder numbers, escapes and duplicate keys instead of normalizing them", () => {
    const r = optimizeToolOutput(
      JSON.stringify(Array(100).fill({ long_column_name: 1 })),
    );
    expect(r.strategy).toBe("json-table");
    for (const value of ["1e999", "9007199254740993", "-0", '"\\u0061"']) {
      const altered = r.output.replace("[1]", `[${value}]`);
      expect(() => restoreToolOutput(altered, "json-table")).toThrow(
        "Noncanonical",
      );
    }
    expect(() =>
      restoreToolOutput(
        r.output.replace('"rows":', '"extra":1,"extra":2,"rows":'),
        "json-table",
      ),
    ).toThrow("Noncanonical");
  });
  it("rejects malicious decoder expansion and malformed representations", () => {
    const r = optimizeToolOutput("polling job for updates\n".repeat(100));
    expect(() =>
      restoreToolOutput(r.output.replace("[100,", "[999999999,"), r.strategy),
    ).toThrow("size limit");
    expect(() => restoreToolOutput("{}", "json-table")).toThrow();
    const table = optimizeToolOutput(
      JSON.stringify(
        Array(20).fill({ really_long_column: "a", another_long_column: "b" }),
      ),
    );
    expect(table.strategy).toBe("json-table");
    expect(() =>
      restoreToolOutput(
        table.output.replace('"another_long_column"', '"really_long_column"'),
        "json-table",
      ),
    ).toThrow();
  });
});
