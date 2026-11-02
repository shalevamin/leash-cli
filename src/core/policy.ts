export type Policy = {
  sessionCap: number;
  dailyCap: number;
  monthlyCap: number;
  repeatThreshold: number;
  repeatWindowMs: number;
  maxRequests: number;
  spawnLimit: number;
  velocityMultiplier: number;
  baseline: number;
  modelAllowlist: string[];
  learningMode: boolean;
  sessionAction?: "block" | "alert";
  dailyAction?: "block" | "alert";
  monthlyAction?: "block" | "alert";
};
export const defaultPolicy: Policy = {
  sessionCap: 20,
  dailyCap: 100,
  monthlyCap: 1000,
  repeatThreshold: 8,
  repeatWindowMs: 180000,
  maxRequests: 800,
  spawnLimit: 10,
  velocityMultiplier: 6,
  baseline: 0.5,
  modelAllowlist: [],
  learningMode: false,
  sessionAction: "block",
  dailyAction: "block",
  monthlyAction: "block",
};
export type PolicyState = {
  killed: boolean;
  spent: number;
  reserved: number;
  daily: number;
  monthly: number;
  requests: number;
  subagents: number;
  recent: { hash: string; ts: number; cost: number }[];
};
export function evaluate(
  model: string,
  hash: string,
  reservation: number,
  state: PolicyState,
  p: Policy,
  now = Date.now(),
): { allow: boolean; reason?: string; warning?: string } {
  if (state.killed) return { allow: false, reason: "session_killed" };
  const match = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .split("*")
          .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    ).test(model);
  let reason: string | undefined, warning: string | undefined;
  const exceeded = (
    scope: string,
    amount: number,
    cap: number,
    action?: string,
  ) => {
    if (amount > cap + 1e-9) {
      if (action === "alert") {
        warning = `${scope}_budget_alert`;
        return false;
      }
      return true;
    }
    return false;
  };
  if (p.modelAllowlist.length && !p.modelAllowlist.some(match))
    reason = "model_not_allowed";
  else if (
    exceeded(
      "session",
      state.spent + state.reserved + reservation,
      p.sessionCap,
      p.sessionAction,
    )
  )
    reason = "session_budget";
  else if (
    exceeded("daily", state.daily + reservation, p.dailyCap, p.dailyAction)
  )
    reason = "daily_budget";
  else if (
    exceeded(
      "monthly",
      state.monthly + reservation,
      p.monthlyCap,
      p.monthlyAction,
    )
  )
    reason = "monthly_budget";
  else if (state.requests >= p.maxRequests) reason = "max_requests";
  else if (state.subagents > p.spawnLimit) reason = "spawn_limit";
  else if (
    state.recent.filter((e) => e.hash === hash && e.ts > now - p.repeatWindowMs)
      .length +
      1 >=
    p.repeatThreshold
  )
    reason = "loop_repeat";
  else {
    const velocity =
      state.recent
        .filter((e) => e.ts > now - 300000)
        .reduce((a, e) => a + e.cost, 0) / 5;
    if (velocity > Math.max(1, p.baseline * p.velocityMultiplier))
      reason = "velocity";
  }
  if (
    reason &&
    p.learningMode &&
    ["loop_repeat", "velocity", "max_requests"].includes(reason)
  )
    return { allow: true, warning: reason };
  return reason
    ? { allow: false, reason }
    : { allow: true, ...(warning ? { warning } : {}) };
}
