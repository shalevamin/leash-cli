// Shared by the local watcher and the agent hooks. Hooks run on every prompt and
// tool call, so this module imports only Node built-ins.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const leashHome = () =>
  process.env.LEASH_HOME ?? join(homedir(), ".leash");
export const localDir = () => join(leashHome(), "local");
export const HOOK_MARKER = "--leash-local-hook";
/** A cached state younger than this is used without asking the API. */
export const FRESH_MS = 30_000;
/** On an API outage, a confirmed block stays in force this long, then hooks fail open. */
export const BLOCK_GRACE_MS = 300_000;
export const FETCH_TIMEOUT_MS = 1_500;

type Budget = {
  period: "day" | "month";
  spentUsd: number;
  reservedUsd: number;
  capUsd: number;
  action: string;
  exhausted: boolean;
};
export type WorkspaceState = {
  killed: boolean;
  blocked: boolean;
  reason: "workspace_killed" | "daily_budget" | "monthly_budget" | null;
  daily: Budget;
  monthly: Budget;
  checkedAt: string;
};
export type CachedState = { state: WorkspaceState; fetchedAt: number };
export type Decision = {
  block: boolean;
  message?: string;
  source: "cache" | "api" | "stale-block" | "fail-open" | "signed-out";
};

const statePath = () => join(localDir(), "state.json");
export function readCachedState(): CachedState | undefined {
  try {
    const c = JSON.parse(readFileSync(statePath(), "utf8"));
    return typeof c?.fetchedAt === "number" && c.state ? c : undefined;
  } catch {
    return undefined;
  }
}
export function writeCachedState(state: WorkspaceState, now = Date.now()) {
  mkdirSync(localDir(), { recursive: true, mode: 0o700 });
  const temp = `${statePath()}.${randomUUID()}`;
  writeFileSync(temp, JSON.stringify({ state, fetchedAt: now }), {
    mode: 0o600,
  });
  renameSync(temp, statePath());
}
/** The Leash CLI login (leash login). Never an agent's subscription credential. */
export function leashLogin(): { token: string; apiURL: string } | undefined {
  try {
    const c = JSON.parse(
      readFileSync(join(leashHome(), "credentials.json"), "utf8"),
    );
    if (typeof c.token !== "string" || !c.token.startsWith("lsh_")) return;
    if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return;
    const url = new URL(c.apiURL);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      return;
    return { token: c.token, apiURL: url.toString().replace(/\/$/, "") };
  } catch {
    return undefined;
  }
}
export async function fetchState(
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<WorkspaceState | undefined> {
  const login = leashLogin();
  if (!login) return undefined;
  const r = await fetch(`${login.apiURL}/v1/local/state`, {
    headers: { authorization: `Bearer ${login.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Leash state request failed: ${r.status}`);
  return (await r.json()) as WorkspaceState;
}
const usd = (n: number) => `$${n.toFixed(2)}`;
export function blockMessage(s: WorkspaceState) {
  if (s.reason === "workspace_killed")
    return "Leash stopped this agent: the workspace kill switch is on. Clear it in the Leash dashboard to continue.";
  const b = s.reason === "monthly_budget" ? s.monthly : s.daily;
  const label = b.period === "month" ? "monthly" : "daily";
  return `Leash stopped this agent: the workspace ${label} budget of ${usd(b.capUsd)} is used (${usd(b.spentUsd + b.reservedUsd)} metered spend). Raise the budget in the Leash dashboard or wait for the next ${b.period}.`;
}
function decide(s: WorkspaceState, source: Decision["source"]): Decision {
  return s.blocked
    ? { block: true, message: blockMessage(s), source }
    : { block: false, source };
}
/** Cached, short-timeout and fail-open: a Leash outage never bricks the agent. */
export async function currentDecision(
  now = Date.now(),
  fetcher: (
    timeoutMs: number,
  ) => Promise<WorkspaceState | undefined> = fetchState,
): Promise<Decision> {
  const cached = readCachedState();
  if (cached && now - cached.fetchedAt < FRESH_MS)
    return decide(cached.state, "cache");
  try {
    const fresh = await fetcher(FETCH_TIMEOUT_MS);
    if (!fresh) return { block: false, source: "signed-out" };
    writeCachedState(fresh, now);
    return decide(fresh, "api");
  } catch {
    if (cached?.state.blocked && now - cached.fetchedAt < BLOCK_GRACE_MS)
      return decide(cached.state, "stale-block");
    return { block: false, source: "fail-open" };
  }
}
