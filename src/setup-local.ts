import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import TOML from "@iarna/toml";
import {
  parseSetupPlan,
  modelRoutingCandidates,
  modelRoutingFromEnv,
  normalizeModelRouting,
  type SetupPlan,
  type Policy,
  type ModelRoutingConfig,
} from "./core/index.js";
import { Store, type Session } from "./state.js";

export type SetupEnvelope = {
  id: string;
  orgId: string;
  userId: string;
  plan: SetupPlan;
};
export type SetupIdentity = {
  id: string;
  orgId: string;
  userId: string;
  agent: string;
};
export type AppliedSetup = {
  id: string;
  orgId: string;
  userId: string;
  agent: string;
  sessionCap: number;
  dailyCap: number;
  toolCompression: "lossless";
  modelRouting: ModelRoutingConfig;
  runtime: SetupPlan["runtime"];
  tightenedSessions: number;
};
export function validateSetupId(id: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
  )
    throw new Error("Setup must be the UUID from your account setup page");
  return id.toLowerCase();
}
export function validateSetupEnvelope(
  input: unknown,
  identity: SetupIdentity,
): SetupEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid account setup response");
  const data = input as Record<string, unknown>,
    plan = parseSetupPlan(data.plan);
  if (
    typeof data.id !== "string" ||
    validateSetupId(data.id) !== validateSetupId(identity.id) ||
    data.orgId !== identity.orgId ||
    data.userId !== identity.userId ||
    (plan.agent !== "auto" && plan.agent !== identity.agent)
  )
    throw new Error(
      "This setup belongs to a different account, workspace or agent; nothing was applied",
    );
  return {
    id: validateSetupId(data.id),
    orgId: identity.orgId,
    userId: identity.userId,
    plan,
  };
}
function minimumCap(values: unknown[]) {
  const defined = values.filter((v) => v !== undefined);
  if (
    !defined.length ||
    defined.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)
  )
    throw new Error(
      "Existing budget contains an invalid cap; repair it before applying a setup",
    );
  return Math.min(...(defined as number[]));
}
const sameList = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort().every((value, index) => value === [...b].sort()[index]);
const sameRouting = (a: ModelRoutingConfig, b: ModelRoutingConfig) =>
  a.mode === b.mode &&
  sameList(a.allowlist, b.allowlist) &&
  sameList(a.pinnedModels, b.pinnedModels);
export function planModelRouting(
  plan: SetupPlan,
  saved: Record<string, any>,
  env: Record<string, string | undefined>,
  actualAgent: string = plan.agent,
): ModelRoutingConfig {
  if (actualAgent === "openrouter-sdk" && plan.modelRouting !== "preserve")
    throw new Error(
      "OpenRouter setup preserves provider-qualified model IDs; choose preserve until an explicit reviewed OpenRouter routing policy is available",
    );
  const previous = normalizeModelRouting({
    mode: saved.modelRouting,
    allowlist: saved.modelRoutingAllowlist,
    pinnedModels: saved.modelRoutingPinnedModels,
  });
  const effective = modelRoutingFromEnv(env, previous);
  const provider =
    actualAgent === "claude-code" || actualAgent === "anthropic-sdk"
      ? "anthropic"
      : "openai";
  let allowlist: string[] =
    plan.modelRouting === "preserve"
      ? [...previous.allowlist]
      : [...modelRoutingCandidates[provider][plan.modelRouting]];
  if (plan.modelRouting !== "preserve") {
    if (env.LEASH_MODEL_ROUTING_ALLOWLIST !== undefined)
      allowlist = allowlist.filter((model) =>
        effective.allowlist.includes(model),
      );
  }
  const desired = normalizeModelRouting({
    mode: plan.modelRouting,
    allowlist,
    pinnedModels: [
      ...new Set([...previous.pinnedModels, ...effective.pinnedModels]),
    ],
  });
  if (!sameRouting(modelRoutingFromEnv(env, desired), desired))
    throw new Error(
      "LEASH_MODEL_ROUTING environment overrides conflict with this setup or existing model pins. Align or unset those overrides, then rerun connect --setup; no settings were changed",
    );
  return desired;
}
/** Apply only configuration and tighter admission limits. Never reset identity, spend or kill state. */
export function applyLocalSetup(
  input: unknown,
  options: SetupIdentity & {
    dir: string;
    effectivePolicy: Policy;
    env?: Record<string, string | undefined>;
  },
): AppliedSetup {
  const envelope = validateSetupEnvelope(input, options),
    plan = envelope.plan,
    env = options.env ?? process.env;
  if (
    env.LEASH_TOOL_COMPRESSION !== undefined &&
    env.LEASH_TOOL_COMPRESSION !== "lossless"
  )
    throw new Error(
      "LEASH_TOOL_COMPRESSION overrides the selected setup. Set it to lossless or unset it, then rerun connect --setup",
    );
  if (env.LEASH_LEARNING_MODE === "1")
    throw new Error(
      "LEASH_LEARNING_MODE=1 disables hard enforcement. Unset it before applying this protected setup",
    );
  const path = join(options.dir, "config.toml"),
    original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const saved: Record<string, any> = original ? TOML.parse(original) : {};
  if (
    saved.setup &&
    (saved.setup.orgId !== options.orgId ||
      saved.setup.userId !== options.userId ||
      saved.setup.agent !== options.agent)
  )
    throw new Error(
      "Existing setup belongs to another account, workspace or agent. Use a fresh LEASH_HOME; existing protection was preserved",
    );
  const routing = planModelRouting(plan, saved, env, options.agent),
    store = new Store(options.dir),
    temporary = path + ".setup-" + randomUUID();
  let renamed = false;
  try {
    return store.transaction(() => {
      const workspace = store.get<{ orgId: string }>("setting", "workspace");
      if (
        (workspace && workspace.orgId !== options.orgId) ||
        (!workspace &&
          (store.all("session").length ||
            store.all("report").length ||
            store.all("repo-budget").length ||
            store.all("event").length))
      )
        throw new Error(
          "This ledger is not assigned to the selected workspace. Use a fresh LEASH_HOME; existing spend cannot be reassigned",
        );
      const persisted = store.get<Partial<Policy>>("setting", "policy") ?? {};
      const dailyCap = minimumCap([
        plan.dailyCap,
        saved.policy?.dailyCap,
        options.effectivePolicy.dailyCap,
        persisted.dailyCap,
        env.LEASH_DAILY_CAP_USD !== undefined
          ? Number(env.LEASH_DAILY_CAP_USD)
          : undefined,
      ]);
      const sessionCap = minimumCap([
        plan.sessionCap,
        dailyCap,
        saved.policy?.sessionCap,
        options.effectivePolicy.sessionCap,
        persisted.sessionCap,
        env.LEASH_SESSION_CAP_USD !== undefined
          ? Number(env.LEASH_SESSION_CAP_USD)
          : undefined,
      ]);
      const protection = {
        sessionCap,
        dailyCap,
        sessionAction: "block" as const,
        dailyAction: "block" as const,
        learningMode: false,
      };
      const next = {
        ...saved,
        toolCompression: "lossless",
        modelRouting: routing.mode,
        modelRoutingAllowlist: routing.allowlist,
        modelRoutingPinnedModels: routing.pinnedModels,
        policy: { ...saved.policy, ...protection },
        setupRuntime: {
          ...saved.setupRuntime,
          mode: plan.runtime,
          allowedHosts: plan.allowedHosts,
          memoryMinMiB: plan.memoryMinMb,
          memoryMaxMiB: plan.memoryMaxMb,
        },
        setup: {
          id: envelope.id,
          orgId: options.orgId,
          userId: options.userId,
          agent: options.agent,
          goal: plan.goal,
          savedAt: new Date().toISOString(),
        },
      };
      let tightenedSessions = 0;
      for (const session of store.all<Session>("session")) {
        if (!["active", "killed"].includes(session.status)) continue;
        const cap = minimumCap([session.cap, sessionCap]);
        if (cap !== session.cap || session.budgetAction === "alert") {
          store.put("session", session.id, {
            ...session,
            cap,
            budgetAction: "block",
          });
          tightenedSessions++;
        }
      }
      store.put("setting", "policy", { ...persisted, ...protection });
      writeFileSync(temporary, TOML.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path);
      renamed = true;
      return {
        id: envelope.id,
        orgId: options.orgId,
        userId: options.userId,
        agent: options.agent,
        sessionCap,
        dailyCap,
        toolCompression: "lossless",
        modelRouting: routing,
        runtime: plan.runtime,
        tightenedSessions,
      };
    });
  } catch (error) {
    if (renamed) {
      if (original === undefined) rmSync(path, { force: true });
      else {
        writeFileSync(temporary, original, { mode: 0o600 });
        renameSync(temporary, path);
      }
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    store.db.close();
  }
}
/** Comparing observed proxy state avoids claiming a saved file is already active. */
export function assertSetupProxy(status: unknown, setup: AppliedSetup) {
  const stale = () =>
    new Error(
      "Setup saved, but the running proxy has older or different settings. Stop that proxy when safe, then run leash start and leash status --json. No work was automatically restarted; stricter persisted caps and kill latches were preserved",
    );
  if (!status || typeof status !== "object") throw stale();
  const data = status as Record<string, any>;
  let routing: ModelRoutingConfig;
  try {
    if (!data.modelRouting) throw new Error();
    routing = normalizeModelRouting(data.modelRouting);
  } catch {
    throw stale();
  }
  if (
    data.workspaceId !== setup.orgId ||
    data.toolCompression !== "lossless" ||
    !sameRouting(routing, setup.modelRouting) ||
    typeof data.policy?.sessionCap !== "number" ||
    !Number.isFinite(data.policy.sessionCap) ||
    data.policy.sessionCap > setup.sessionCap ||
    data.policy.sessionCap <= 0 ||
    typeof data.policy?.dailyCap !== "number" ||
    !Number.isFinite(data.policy.dailyCap) ||
    data.policy.dailyCap > setup.dailyCap ||
    data.policy.dailyCap <= 0 ||
    data.policy.learningMode === true ||
    (data.policy.sessionAction ?? "block") !== "block" ||
    (data.policy.dailyAction ?? "block") !== "block"
  )
    throw stale();
}
