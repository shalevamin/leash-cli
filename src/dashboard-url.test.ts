import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { blockMessage, type WorkspaceState } from "./local-state.js";

const budget = (period: "day" | "month") => ({
  period,
  spentUsd: 10,
  reservedUsd: 0,
  capUsd: 10,
  action: "block",
  exhausted: true,
});
const state = (reason: WorkspaceState["reason"]): WorkspaceState => ({
  killed: reason === "workspace_killed",
  blocked: true,
  reason,
  daily: budget("day"),
  monthly: budget("month"),
  checkedAt: "2026-01-01T00:00:00.000Z",
});

describe("dashboard links", () => {
  it("points every block message to the hosted dashboard", () => {
    for (const reason of [
      "workspace_killed",
      "daily_budget",
      "monthly_budget",
    ] as const)
      expect(blockMessage(state(reason))).toContain("https://useleash.dev");
  });
  it("never prints a loopback dashboard URL to users", () => {
    for (const file of ["report.ts", "local-state.ts", "index.ts", "auth.ts"])
      expect(
        readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
      ).not.toMatch(/http:\/\/(127\.0\.0\.1|localhost):3000/);
  });
});
