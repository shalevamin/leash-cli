import { it, expect, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimize } from "./optimize.js";
import { config } from "./config.js";

it("optimizes a UTF-8 file locally, reports honest estimates and creates private output without overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-optimize-"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const input = join(dir, "tool.json"),
      output = join(dir, "compact.json");
    writeFileSync(input, ' { "private_value" : "secret" } ');
    await optimize(input, { output, json: true });
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.strategy).toBe("json-minify");
    expect(report.estimateMethod).toContain("heuristic");
    expect(readFileSync(output, "utf8")).toBe('{"private_value":"secret"}');
    expect(statSync(output).mode & 0o777).toBe(0o600);
    await expect(optimize(input, { output })).rejects.toThrow();
    writeFileSync(input, Buffer.from([0xff]));
    await expect(
      optimize(input, { output: join(dir, "invalid") }),
    ).rejects.toThrow("UTF-8");
    expect(existsSync(join(dir, "invalid"))).toBe(false);
    await expect(optimize(input, { mode: "drop-errors" })).rejects.toThrow(
      "mode",
    );
  } finally {
    log.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("enables automatic compression by default, permits off and rejects invalid configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-opt-config-"));
  vi.stubEnv("LEASH_HOME", dir);
  vi.stubEnv("LEASH_TOOL_COMPRESSION", undefined);
  try {
    expect(config().toolCompression).toBe("lossless");
    vi.stubEnv("LEASH_TOOL_COMPRESSION", "off");
    expect(config().toolCompression).toBe("off");
    vi.stubEnv("LEASH_TOOL_COMPRESSION", "lossless");
    expect(config().toolCompression).toBe("lossless");
    vi.stubEnv("LEASH_TOOL_COMPRESSION", "lossy");
    expect(() => config()).toThrow("off or lossless");
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
