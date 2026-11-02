import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { defaultPolicy, defaultSetupPlan } from "./core/index.js";
import { Store } from "./state.js";
import {
  applyLocalSetup,
  assertSetupProxy,
  validateSetupEnvelope,
  validateSetupId,
  planModelRouting,
} from "./setup-local.js";
const dirs: string[] = [];
const identity = {
  id: "00000000-0000-4000-8000-000000000111",
  orgId: "00000000-0000-4000-8000-000000000222",
  userId: "00000000-0000-4000-8000-000000000333",
  agent: "codex",
};
const envelope = {
  ...identity,
  plan: { ...defaultSetupPlan, agent: "codex" as const },
};
function fixture(config: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "leash-setup-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, TOML.stringify(config), { mode: 0o600 });
  const store = new Store(dir);
  store.put("setting", "workspace", { orgId: identity.orgId });
  return { dir, path, store };
}
const options = (
  dir: string,
  env: Record<string, string | undefined> = {},
) => ({ ...identity, dir, effectivePolicy: { ...defaultPolicy }, env });
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("account-scoped setup persistence", () => {
  it("preserves unrelated configuration, prices, scopes, pins and runtime metadata", () => {
    const f = fixture({
      port: 9911,
      custom: { keep: "yes" },
      prices: { custom: { input: 1, output: 2 } },
      policy: { repeatThreshold: 3, modelAllowlist: ["gpt-*"], monthlyCap: 40 },
      modelRoutingPinnedModels: ["gpt-4.1"],
      setupRuntime: { image: "my-reviewed:1" },
    });
    f.store.db.close();
    const r = applyLocalSetup(
      {
        ...envelope,
        plan: {
          ...envelope.plan,
          runtime: "managed",
          allowedHosts: ["example.com"],
          memoryMinMb: 256,
          memoryMaxMb: 512,
          modelRouting: "balanced",
        },
      },
      options(f.dir),
    );
    const saved: any = TOML.parse(readFileSync(f.path, "utf8"));
    expect(saved.port).toBe(9911);
    expect(saved.custom).toEqual({ keep: "yes" });
    expect(saved.prices.custom).toEqual({ input: 1, output: 2 });
    expect(saved.policy.modelAllowlist).toEqual(["gpt-*"]);
    expect(saved.policy.repeatThreshold).toBe(3);
    expect(saved.policy.monthlyCap).toBe(40);
    expect(saved.toolCompression).toBe("lossless");
    expect(saved.modelRouting).toBe("balanced");
    expect(saved.modelRoutingAllowlist).toEqual(["gpt-4.1-mini"]);
    expect(saved.modelRoutingPinnedModels).toEqual(["gpt-4.1"]);
    expect(saved.setupRuntime).toEqual({
      image: "my-reviewed:1",
      mode: "managed",
      allowedHosts: ["example.com"],
      memoryMinMiB: 256,
      memoryMaxMiB: 512,
    });
    expect(saved.setup.id).toBe(identity.id);
    expect(r.runtime).toBe("managed");
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  });
  it("clamps caps across requested, file, environment and persisted ledger values", () => {
    const f = fixture({
      policy: {
        sessionCap: 4,
        dailyCap: 20,
        sessionAction: "alert",
        dailyAction: "alert",
      },
    });
    f.store.put("setting", "policy", {
      sessionCap: 1,
      dailyCap: 50,
      monthlyCap: 30,
      repeatThreshold: 2,
      modelAllowlist: ["gpt-4.1"],
      learningMode: true,
    });
    f.store.db.close();
    const r = applyLocalSetup(envelope, {
      ...options(f.dir, {
        LEASH_SESSION_CAP_USD: "3",
        LEASH_DAILY_CAP_USD: "7",
      }),
      effectivePolicy: { ...defaultPolicy, sessionCap: 3, dailyCap: 7 },
    });
    expect(r.sessionCap).toBe(1);
    expect(r.dailyCap).toBe(7);
    const s = new Store(f.dir);
    try {
      expect(s.get("setting", "policy")).toEqual({
        sessionCap: 1,
        dailyCap: 7,
        monthlyCap: 30,
        repeatThreshold: 2,
        modelAllowlist: ["gpt-4.1"],
        learningMode: false,
        sessionAction: "block",
        dailyAction: "block",
      });
    } finally {
      s.db.close();
    }
  });
  it("tightens current caps while preserving spend, reservations, kill latches and terminal history", () => {
    const f = fixture();
    const active = f.store.create("codex", 8, {
      spent: 1,
      budgetAction: "alert",
    });
    const killed = f.store.create("codex", 10, { spent: 3 });
    f.store.kill(killed.id, "manual");
    const ended = f.store.create("codex", 20, {
      status: "ended",
      endedAt: "2026-10-08T00:00:00Z",
    });
    f.store.put("setting", "panic", { active: true });
    f.store.db
      .prepare(
        "INSERT INTO reservations(id,session,amount,ts,hash) VALUES(?,?,?,?,?)",
      )
      .run("reservation", active.id, 0.25, 1, "fingerprint");
    const beforeKills = f.store.all("kill");
    f.store.db.close();
    const r = applyLocalSetup(envelope, options(f.dir));
    expect(r.tightenedSessions).toBe(2);
    const s = new Store(f.dir);
    try {
      expect(s.get<any>("session", active.id)).toMatchObject({
        cap: 2,
        spent: 1,
        status: "active",
        budgetAction: "block",
      });
      expect(s.get<any>("session", killed.id)).toMatchObject({
        cap: 2,
        spent: 3,
        status: "killed",
      });
      expect(s.get<any>("session", ended.id)).toEqual(ended);
      expect(s.get("setting", "panic")).toEqual({ active: true });
      expect(s.all("kill")).toEqual(beforeKills);
      expect(
        s.db
          .prepare("SELECT amount FROM reservations WHERE id=?")
          .get("reservation"),
      ).toEqual({ amount: 0.25 });
    } finally {
      s.db.close();
    }
  });
  it("never raises stricter active session caps or reassigns ledger identity", () => {
    const f = fixture();
    const session = f.store.create("codex", 0.5);
    f.store.db.close();
    applyLocalSetup(envelope, options(f.dir));
    const s = new Store(f.dir);
    try {
      expect(s.get<any>("session", session.id)?.cap).toBe(0.5);
      expect(s.get("setting", "workspace")).toEqual({ orgId: identity.orgId });
    } finally {
      s.db.close();
    }
  });
  it("rejects wrong account, workspace, agent or invalid plan before writing", () => {
    const f = fixture({ custom: "original" });
    f.store.db.close();
    const before = readFileSync(f.path, "utf8");
    for (const input of [
      { ...envelope, userId: "other" },
      { ...envelope, orgId: "other" },
      { ...envelope, plan: { ...envelope.plan, agent: "claude-code" } },
      { ...envelope, plan: { ...envelope.plan, dailyCap: -1 } },
    ])
      expect(() => applyLocalSetup(input, options(f.dir))).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(() => validateSetupId("../../private")).toThrow();
    expect(() =>
      validateSetupEnvelope(envelope, {
        ...identity,
        id: "00000000-0000-4000-8000-000000000999",
      }),
    ).toThrow();
  });
  it("refuses stale workspace bindings and an older setup owned by someone else", () => {
    const f = fixture();
    f.store.put("setting", "workspace", { orgId: "another" });
    f.store.db.close();
    expect(() => applyLocalSetup(envelope, options(f.dir))).toThrow("ledger");
    const g = fixture({ setup: { ...identity, userId: "another" } });
    g.store.db.close();
    expect(() => applyLocalSetup(envelope, options(g.dir))).toThrow(
      "another account",
    );
  });
  it("refuses environment conflicts instead of claiming ineffective settings", () => {
    const f = fixture();
    f.store.db.close();
    const before = readFileSync(f.path, "utf8");
    for (const env of [
      { LEASH_TOOL_COMPRESSION: "off" },
      { LEASH_LEARNING_MODE: "1" },
      { LEASH_MODEL_ROUTING: "economy" },
    ])
      expect(() => applyLocalSetup(envelope, options(f.dir, env))).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(existsSync(join(f.dir, "device.json"))).toBe(false);
  });
  it("does not widen model scopes and keeps existing file/environment pins", () => {
    const plan = {
      ...defaultSetupPlan,
      agent: "codex" as const,
      modelRouting: "economy" as const,
    };
    const result = planModelRouting(
      plan,
      { modelRoutingPinnedModels: ["gpt-4.1"] },
      {
        LEASH_MODEL_ROUTING_ALLOWLIST: "gpt-4.1-mini",
        LEASH_MODEL_ROUTING_PINNED_MODELS: "gpt-4.1,gpt-4o",
      },
    );
    expect(result).toEqual({
      mode: "economy",
      allowlist: ["gpt-4.1-mini"],
      pinnedModels: ["gpt-4.1", "gpt-4o"],
    });
    expect(() =>
      planModelRouting(
        plan,
        { modelRoutingPinnedModels: ["gpt-4.1"] },
        { LEASH_MODEL_ROUTING_PINNED_MODELS: "gpt-4o" },
      ),
    ).toThrow("pins");
    expect(
      planModelRouting(
        {
          ...defaultSetupPlan,
          agent: "codex" as const,
          modelRouting: "balanced",
        },
        { modelRouting: "preserve", modelRoutingAllowlist: [] },
        {},
      ).allowlist,
    ).toEqual(["gpt-4.1-mini"]);
  });
});
describe("observed proxy setup verification", () => {
  it("requires actual settings and matching workspace, preserving stricter live caps", () => {
    const f = fixture();
    f.store.db.close();
    const applied = applyLocalSetup(envelope, options(f.dir));
    const current = {
      workspaceId: identity.orgId,
      policy: { ...defaultPolicy, sessionCap: 1, dailyCap: 5 },
      toolCompression: "lossless",
      modelRouting: applied.modelRouting,
    };
    expect(() => assertSetupProxy(current, applied)).not.toThrow();
    for (const status of [
      { ...current, workspaceId: "other" },
      { ...current, toolCompression: "off" },
      { ...current, modelRouting: undefined },
      {
        ...current,
        modelRouting: { ...current.modelRouting, mode: "economy" },
      },
      { ...current, policy: { ...current.policy, sessionCap: 20 } },
      { ...current, policy: { ...current.policy, dailyAction: "alert" } },
      { ...current, policy: { ...current.policy, learningMode: true } },
      { ...current, policy: { ...current.policy, dailyCap: NaN } },
    ])
      expect(() => assertSetupProxy(status, applied)).toThrow("running proxy");
  });
});
