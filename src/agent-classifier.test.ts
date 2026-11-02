import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  agentClassifierInfo,
  classifyAgent,
  type AgentSignals,
} from "./agent-classifier.js";
const features = [
  "codexContext",
  "claudeContext",
  "codexExecutable",
  "codexConfig",
  "claudeExecutable",
  "claudeConfig",
] as const;
describe("original local learned marker classifier", () => {
  it("covers all finite marker combinations and abstains on conflicts", () => {
    for (let mask = 0; mask < 64; mask++) {
      const input = Object.fromEntries(
        features.map((f, i) => [f, !!(mask & (1 << i))]),
      ) as AgentSignals;
      const c = input.codexContext,
        a = input.claudeContext,
        ci = input.codexExecutable || input.codexConfig,
        ai = input.claudeExecutable || input.claudeConfig;
      const expected =
        c && a
          ? "needs-choice"
          : c
            ? "codex"
            : a
              ? "claude-code"
              : ci && !ai
                ? "codex"
                : ai && !ci
                  ? "claude-code"
                  : "needs-choice";
      expect(classifyAgent(input).label).toBe(expected);
    }
  });
  it("records its synthetic heldout scope and refuses malformed markers", () => {
    expect(agentClassifierInfo.kind).toBe("cart");
    expect(agentClassifierInfo.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(agentClassifierInfo.heldoutAccuracy).toBeGreaterThanOrEqual(0.75);
    expect(agentClassifierInfo.scope).toContain("synthetic");
    expect(classifyAgent({} as AgentSignals).label).toBe("needs-choice");
  });
  it("does bounded local inference without model calls or unbounded input", () => {
    const s = Object.fromEntries(
      features.map((f) => [f, false]),
    ) as AgentSignals;
    const start = performance.now();
    for (let i = 0; i < 10000; i++) classifyAgent(s);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
