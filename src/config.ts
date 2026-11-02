import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import TOML from "@iarna/toml";
import { loadGateway } from "./gateway-vault.js";
import {
  defaultPolicy,
  modelRoutingFromEnv,
  type Policy,
  type Price,
  type ToolCompressionMode,
} from "./core/index.js";
export function config() {
  const dir = process.env.LEASH_HOME ?? join(homedir(), ".leash");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.toml");
  const saved: any = existsSync(path)
    ? TOML.parse(readFileSync(path, "utf8"))
    : {};
  const tokenPath = join(dir, "token");
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  const policy: Policy = { ...defaultPolicy, ...saved.policy };
  for (const [env, key] of Object.entries({
    LEASH_SESSION_CAP_USD: "sessionCap",
    LEASH_DAILY_CAP_USD: "dailyCap",
    LEASH_MONTHLY_CAP_USD: "monthlyCap",
    LEASH_LOOP_REPEAT_THRESHOLD: "repeatThreshold",
    LEASH_SPAWN_LIMIT: "spawnLimit",
    LEASH_MAX_REQUESTS: "maxRequests",
    LEASH_VELOCITY_MULTIPLIER: "velocityMultiplier",
  }))
    if (process.env[env]) (policy as any)[key] = Number(process.env[env]);
  for (const [k, v] of Object.entries(policy))
    if (typeof v === "number" && (!Number.isFinite(v) || v <= 0))
      throw new Error(`Invalid policy ${k}`);
  for (const key of ["sessionAction", "dailyAction", "monthlyAction"] as const)
    if (!["alert", "block"].includes(policy[key] ?? "block"))
      throw new Error(`Invalid budget action ${key}`);
  if (process.env.LEASH_MODEL_ALLOWLIST)
    policy.modelAllowlist = process.env.LEASH_MODEL_ALLOWLIST.split(",");
  policy.learningMode =
    process.env.LEASH_LEARNING_MODE === "1" || policy.learningMode;
  const toolCompression =
    process.env.LEASH_TOOL_COMPRESSION ?? saved.toolCompression ?? "lossless";
  if (!["off", "lossless"].includes(toolCompression))
    throw new Error("LEASH_TOOL_COMPRESSION must be off or lossless");
  return {
    toolCompression: toolCompression as ToolCompressionMode,
    routing: modelRoutingFromEnv(process.env, {
      mode: saved.modelRouting,
      allowlist: saved.modelRoutingAllowlist,
      pinnedModels: saved.modelRoutingPinnedModels,
    }),
    dir,
    path,
    token: readFileSync(tokenPath, "utf8").trim(),
    port: Number(process.env.LEASH_PORT ?? saved.port ?? 8787),
    policy,
    gateway: loadGateway(dir),
    prices: (saved.prices ?? {}) as Record<string, Price>,
  };
}
