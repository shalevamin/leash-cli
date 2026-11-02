import { describe, it, expect } from "vitest";
import {
  assessConversation,
  createHandoff,
  continuationPrompt,
  type Conversation,
} from "./handoff.js";
const now = Date.parse("2026-10-08T12:00:00Z");
const session: Conversation = {
  id: "session-one",
  agent: "codex",
  status: "active",
  startedAt: new Date(now - 600000).toISOString(),
  requests: 10,
  spent: 1,
  cap: 10,
};
describe("conversation checkpoints", () => {
  it("continues a short session and reports each independent threshold", () => {
    expect(assessConversation(session, now).level).toBe("continue");
    for (const change of [
      { requests: 80 },
      { spent: 8 },
      { latestInputTokens: 60000 },
      { startedAt: new Date(now - 90 * 60000).toISOString() },
    ])
      expect(assessConversation({ ...session, ...change }, now).level).toBe(
        "handoff",
      );
  });
  it("does not count output or total lifetime tokens as a context window", () => {
    expect(
      assessConversation({ ...session, latestInputTokens: 59999 }, now).level,
    ).toBe("continue");
    expect(assessConversation({ ...session, cap: 0 }, now).reasons).toEqual([]);
  });
  it("keeps stopped sessions stopped and never mutates caps", () => {
    const killed = { ...session, status: "killed" };
    const before = JSON.stringify(killed);
    expect(assessConversation(killed, now).level).toBe("stopped");
    createHandoff(killed, {}, now);
    expect(JSON.stringify(killed)).toBe(before);
  });
  it("exports supplied context with explicit missing fields and measured facts", () => {
    const output = createHandoff(
      session,
      {
        goal: "Fix CI",
        completed: "Unit checks pass",
        next: "Run browser suite",
      },
      now,
    );
    expect(output).toContain("Fix CI");
    expect(output).toContain("[Fill in before starting the next conversation]");
    expect(output).toContain("$1.0000 / $10.00");
    expect(output).toContain("does not stop or resume");
    expect(continuationPrompt()).toContain("HANDOFF.md");
  });
});
