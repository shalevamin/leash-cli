import { it, expect } from "vitest";
import { collectReport } from "./report.js";
it("collects real fixtures, groups model/day spend, and never retains prompts or source paths", () => {
  const r = collectReport({ claudeDir: "fixtures", codexDir: "fixtures" });
  expect(r.requests).toBeGreaterThan(2);
  expect(r.models.length).toBeGreaterThan(1);
  expect(r.days.length).toBeGreaterThan(0);
  const text = JSON.stringify(r);
  expect(text).not.toContain("This content must never");
  expect(text).not.toContain("fixtures/");
  expect(r.cost).toBeGreaterThan(0);
  expect(
    collectReport({
      claudeDir: "fixtures",
      codexDir: "fixtures",
      since: "2099-01-01",
    }).requests,
  ).toBe(0);
});
