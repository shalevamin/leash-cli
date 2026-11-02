import { describe, it, expect } from "vitest";
import { commandOperation } from "./device.js";
import { randomUUID } from "node:crypto";
describe("device transport contract", () => {
  const sessionId = randomUUID();
  it("maps kill, panic and reset without implicitly resuming sessions", () => {
    expect(
      commandOperation({
        id: randomUUID(),
        type: "kill",
        payload: { sessionId },
      })?.path,
    ).toBe(`sessions/${sessionId}/kill`);
    expect(
      commandOperation({
        id: randomUUID(),
        type: "panic",
        payload: { active: false },
      })?.path,
    ).toBe("resume-all");
    expect(
      commandOperation({ id: randomUUID(), type: "noop", payload: {} }),
    ).toBeNull();
  });
  it("uses a stable operation ID for resume crash replay", () => {
    const cmd = {
      id: randomUUID(),
      type: "resume",
      payload: { sessionId, addUsd: 10 },
    };
    expect(commandOperation(cmd)).toEqual(commandOperation(cmd));
    expect(commandOperation(cmd)?.body).toMatchObject({
      operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it("maps daily and per-session budgets", () => {
    expect(
      commandOperation({
        id: randomUUID(),
        type: "set_budget",
        payload: {
          scopeType: "org",
          period: "day",
          limitUsd: 5,
          action: "block",
        },
      })?.body,
    ).toEqual({ dailyCap: 5, dailyAction: "block" });
    expect(
      commandOperation({
        id: randomUUID(),
        type: "set_budget",
        payload: {
          scopeType: "session",
          scopeId: sessionId,
          limitUsd: 5,
          action: "alert",
        },
      })?.path,
    ).toBe(`sessions/${sessionId}/cap`);
  });
  it("rejects malformed commands rather than acknowledging them", () => {
    for (const cmd of [
      { type: "panic", payload: { active: "yes" } },
      { type: "resume", payload: { sessionId: "../../kill-all" } },
      { type: "set_budget", payload: { limitUsd: -2 } },
    ])
      expect(() => commandOperation({ id: randomUUID(), ...cmd })).toThrow();
  });
});
