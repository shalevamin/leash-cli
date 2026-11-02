import {
  LOCAL_CREDENTIAL_MARKER,
  localProviderRequest,
} from "./local-secrets.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  guardOpenRouterRequest,
  standardProviderRequest,
  isClientTool,
  listenHost,
  UsageMeter,
  requestFingerprint,
  cost,
  reserveCost,
  zeroUsage,
  type Policy,
  type RequestOptimization,
  tokenXray,
  routeProviderModel,
  normalizeModelRouting,
} from "./core/index.js";
import { Store, type Session } from "./state.js";
import { config } from "./config.js";
import { optimizeProviderToolOutputs } from "./tool-compression.js";
import { queueAlert, flushAlerts } from "./alerts.js";
import { collectReport } from "./report.js";
import { sync } from "./sync.js";
import {
  commandOperation,
  deviceCycle,
  deviceCredentials,
  deviceRequest,
  flushSharedSettlements,
} from "./device.js";
export function createProxy(
  store: Store,
  cfg: Omit<
    ReturnType<typeof config>,
    "gateway" | "toolCompression" | "routing"
  > & {
    gateway?: ReturnType<typeof config>["gateway"];
    routing?: ReturnType<typeof config>["routing"];
    toolCompression?: ReturnType<typeof config>["toolCompression"];
  } = config(),
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 8 * 1024 * 1024 }));
  const effectivePolicy = (): Policy => {
    const p = { ...cfg.policy, ...store.get<Policy>("setting", "policy") };
    if (p.learningMode) {
      let start = store.get<{ ts: number }>("setting", "learning-start");
      if (!start) {
        start = { ts: Date.now() };
        store.put("setting", "learning-start", start);
      }
      p.learningMode = Date.now() - start.ts < 86400000;
    }
    return p;
  };
  const active = new Map<string, Set<AbortController>>();
  app.get("/health", (c) => c.json({ ok: true, service: "leash-proxy" }));
  app.use("*", async (c, next) => {
    const t = c.req.header("x-leash-local-token") ?? "";
    if (
      Buffer.byteLength(t) !== Buffer.byteLength(cfg.token) ||
      !timingSafeEqual(Buffer.from(t), Buffer.from(cfg.token))
    )
      return c.json({ error: "Local token required" }, 401);
    if (c.req.header("origin"))
      return c.json({ error: "Browser access denied" }, 403);
    await next();
  });
  const stop = (id: string) => {
    for (const a of active.get(id) ?? []) a.abort();
  };
  // Serialize all transport workers through this proxy. A standalone agent and the
  // built-in worker may overlap; neither may replay an earlier budget over a later one.
  let commandTail: Promise<unknown> = Promise.resolve();
  app.post("/control/device-command", async (c) => {
    const command = await c.req.json();
    if (!/^[a-f0-9-]{36}$/i.test(command.id ?? ""))
      return c.json({ error: "Invalid command ID" }, 400);
    const apply = commandTail.then(async () => {
      if (store.get("device-command-applied", command.id))
        return { ok: true, replay: true };
      const operation = commandOperation(command);
      if (operation) {
        const r = await app.request(`/control/${operation.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-leash-local-token": cfg.token,
          },
          body: JSON.stringify(operation.body),
        });
        if (!r.ok)
          throw new Error(((await r.json()) as any).error ?? "Command failed");
      }
      store.put("device-command-applied", command.id, {
        appliedAt: new Date().toISOString(),
      });
      return { ok: true };
    });
    commandTail = apply.catch(() => {});
    try {
      return c.json(await apply);
    } catch {
      return c.json(
        { error: "Device command could not be applied; remains pending" },
        409,
      );
    }
  });
  app.get("/control/status", (c) =>
    c.json({
      ...store.snapshot(),
      policy: effectivePolicy(),
      toolCompression: cfg.toolCompression ?? "lossless",
      transport: cfg.gateway
        ? "gateway"
        : deviceCredentials()
          ? "device"
          : "local",
      modelRouting: normalizeModelRouting(cfg.routing),
      gatewayKeyId: cfg.gateway?.keyId ?? null,
      deviceReady:
        !deviceCredentials() || !!store.get("setting", "device-ready"),
      sharedEnforcement:
        store.get<{ enabled: boolean }>("setting", "shared-enforcement")
          ?.enabled === true,
    }),
  );
  app.get("/control/token-xray", (c) =>
    c.json(
      tokenXray(
        store
          .all<any>("event")
          .sort((a, b) => b.ts.localeCompare(a.ts))
          .slice(0, 5000),
      ),
    ),
  );
  app.post("/control/alerts", async (c) => {
    const b = await c.req.json();
    if (
      !["SLACK_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"].includes(b.channel) ||
      (b.encrypted !== null && typeof b.encrypted !== "string")
    )
      return c.json({ error: "Invalid alert channel" }, 400);
    store.put("webhook", b.channel, { encrypted: b.encrypted });
    return c.json({ ok: true });
  });
  app.get("/control/reports", (c) => c.json(store.all("report")));
  app.post("/control/reports/scan", async (c) => {
    const b = await c.req.json();
    if (
      b.since !== undefined &&
      (typeof b.since !== "string" || Number.isNaN(Date.parse(b.since)))
    )
      return c.json({ error: "Invalid date" }, 400);
    const report = collectReport({
      since: b.since,
      claudeDir: process.env.LEASH_CLAUDE_LOG_DIR,
      codexDir: process.env.LEASH_CODEX_LOG_DIR,
    });
    store.put("report", report.id, report);
    return c.json(report, 201);
  });
  app.post("/control/sessions", async (c) => {
    const body = await c.req.json();
    const cap = Number(
      body.cap ??
        store.get<Policy>("setting", "policy")?.sessionCap ??
        cfg.policy.sessionCap,
    );
    if (
      body.repoHash !== undefined &&
      (typeof body.repoHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.repoHash))
    )
      return c.json({ error: "Invalid repo hash" }, 400);
    if (!Number.isFinite(cap) || cap <= 0)
      return c.json({ error: "Invalid cap" }, 400);
    if (store.get("setting", "panic"))
      return c.json({ error: "Panic is active; run leash resume --all" }, 409);
    if (
      store.all<Session>("session").filter((s) => s.status === "active")
        .length >= effectivePolicy().spawnLimit
    )
      return c.json(
        {
          error:
            "Concurrent session spawn limit reached; end or kill unused sessions",
        },
        429,
      );
    return c.json(
      store.create(String(body.agent ?? "custom"), cap, {
        repoHash: body.repoHash,
        branch: body.branch,
      }),
      201,
    );
  });
  app.post("/control/repo-budget", async (c) => {
    const b = await c.req.json();
    if (
      typeof b.scopeId !== "string" ||
      !/^[a-f0-9]{64}$/.test(b.scopeId) ||
      !["day", "month"].includes(b.period) ||
      !Number.isFinite(b.limitUsd) ||
      b.limitUsd <= 0 ||
      !["block", "alert"].includes(b.action)
    )
      return c.json({ error: "Invalid repository budget" }, 400);
    store.put("repo-budget", `${b.scopeId}:${b.period}`, b);
    return c.json({ ok: true });
  });
  app.post("/control/policy", async (c) => {
    const p = await c.req.json();
    for (const k of [
      "sessionCap",
      "dailyCap",
      "monthlyCap",
      "repeatThreshold",
      "repeatWindowMs",
      "maxRequests",
      "spawnLimit",
      "velocityMultiplier",
      "baseline",
    ])
      if (p[k] !== undefined && (!Number.isFinite(p[k]) || p[k] <= 0))
        return c.json({ error: "Invalid limit" }, 400);
    if (
      Object.keys(p).some((k) => !(k in cfg.policy)) ||
      (p.modelAllowlist !== undefined &&
        (!Array.isArray(p.modelAllowlist) ||
          !p.modelAllowlist.every((v: unknown) => typeof v === "string"))) ||
      ["sessionAction", "dailyAction", "monthlyAction"].some(
        (k) => p[k] !== undefined && !["block", "alert"].includes(p[k]),
      ) ||
      (p.learningMode !== undefined && typeof p.learningMode !== "boolean")
    )
      return c.json({ error: "Invalid policy" }, 400);
    if (
      p.learningMode === true &&
      !store.get<Policy>("setting", "policy")?.learningMode
    )
      store.put("setting", "learning-start", { ts: Date.now() });
    store.put("setting", "policy", {
      ...store.get<Policy>("setting", "policy"),
      ...p,
    });
    return c.json({ ok: true });
  });
  app.post("/control/kill-all", (c) => {
    store.transaction(() => {
      store.put("setting", "panic", { active: true });
      for (const s of store.all<Session>("session"))
        if (s.status === "active") store.kill(s.id, "manual_panic");
    });
    for (const id of active.keys()) stop(id);
    queueAlert(
      store,
      `panic:${store.all("kill").length}`,
      "Leash: panic activated. All sessions stopped.",
    );
    return c.json({ ok: true });
  });
  app.post("/control/resume-all", (c) => {
    store.db
      .prepare("DELETE FROM docs WHERE kind=? AND id=?")
      .run("setting", "panic");
    return c.json({
      ok: true,
      message: "Panic cleared. Resume individual sessions explicitly.",
    });
  });
  app.post("/control/sessions/:id/:action", async (c) => {
    const id = c.req.param("id"),
      action = c.req.param("action");
    if (!store.get("session", id))
      return c.json({ error: "Session not found" }, 404);
    if (action === "kill") {
      store.transaction(() => store.kill(id, "manual"));
      stop(id);
      queueAlert(
        store,
        `kill:${id}:${store.all("kill").length}`,
        `Leash: session ${id} killed.`,
      );
    } else if (action === "resume") {
      const b = await c.req.json().catch(() => ({}));
      const add = Number(b.addUsd ?? 0);
      if (!Number.isFinite(add) || add < 0)
        return c.json({ error: "Invalid cap increase" }, 400);
      if (
        b.operationId !== undefined &&
        (typeof b.operationId !== "string" ||
          !/^[a-f0-9]{64}$/.test(b.operationId))
      )
        return c.json({ error: "Invalid operation ID" }, 400);
      const prior = store.get<Session>("session", id)!;
      if (
        prior.status !== "active" &&
        store.all<Session>("session").filter((s) => s.status === "active")
          .length >= effectivePolicy().spawnLimit
      )
        return c.json({ error: "Concurrent session spawn limit reached" }, 429);
      store.resume(id, add, b.operationId);
    } else if (action === "cap") {
      const b = await c.req.json();
      if (!Number.isFinite(b.cap) || b.cap <= 0)
        return c.json({ error: "Invalid cap" }, 400);
      const s = store.get<Session>("session", id)!;
      if (b.action !== undefined && !["block", "alert"].includes(b.action))
        return c.json({ error: "Invalid budget action" }, 400);
      s.cap = b.cap;
      if (b.action) s.budgetAction = b.action;
      store.put("session", id, s);
    } else if (action === "end") {
      const s = store.get<Session>("session", id)!;
      if (store.all<{ id: string }>("install").some((i) => i.id === id))
        return c.json(s);
      s.status = s.status === "killed" ? "killed" : "ended";
      s.endedAt = new Date().toISOString();
      store.put("session", id, s);
    } else return c.json({ error: "Unknown action" }, 404);
    const s = store.get<Session>("session", id)!;
    store.put("control", id, { status: s.status, cap: s.cap });
    return c.json(s);
  });
  app.post("/control/hook", async (c) => {
    const b = await c.req.json();
    const s = store.get<Session>("session", b.sessionId);
    if (!s)
      return c.json({
        allow: false,
        reason: "No Leash session. Use leash run.",
      });
    const p = effectivePolicy();
    let allow = s.status === "active" && !store.get("setting", "panic");
    let reason = "Session paused by Leash";
    const hookId =
      typeof b.toolUseId === "string" ? `${s.id}:${b.toolUseId}` : undefined;
    if (
      b.event === "pre-tool-use" &&
      ["Agent", "Task"].includes(b.tool) &&
      !(hookId && store.get("spawn", hookId))
    ) {
      if (s.subagents >= p.spawnLimit) {
        allow = false;
        reason = "Leash spawn limit reached";
      } else if (allow) {
        s.subagents++;
        if (hookId) store.put("spawn", hookId, { active: true });
        store.put("session", s.id, s);
      }
    }
    const stopId =
      typeof b.agentId === "string" ? `${s.id}:${b.agentId}` : undefined;
    if (
      (b.event === "subagent-stop" &&
        !(stopId && store.get("spawn-stop", stopId))) ||
      (b.event === "tool-failed" &&
        ["Agent", "Task"].includes(b.tool) &&
        hookId &&
        store.get<{ active: boolean }>("spawn", hookId)?.active)
    ) {
      if (stopId) store.put("spawn-stop", stopId, { stopped: true });
      if (hookId) store.put("spawn", hookId, { active: false });
      s.subagents = Math.max(0, s.subagents - 1);
      store.put("session", s.id, s);
    }
    return c.json({ allow, reason });
  });
  app.post("*", async (c) => {
    const match = c.req.path.match(
      /^(?:\/s\/([a-f0-9-]+))?\/(anthropic|openai|openrouter)\/(v1\/(?:messages|chat\/completions|responses))$/,
    );
    if (!match) return c.json({ error: "Unsupported provider endpoint" }, 404);
    if (deviceCredentials() && !store.get("setting", "device-ready"))
      return c.json(
        {
          error:
            "Device enrollment is waiting for initial workspace budgets. Connect the control plane before the first provider call.",
        },
        503,
      );
    const [, pathId, provider, endpoint] = match;
    if (
      provider === "openrouter" &&
      (endpoint !== "v1/chat/completions" || cfg.gateway)
    )
      return c.json(
        {
          error:
            "OpenRouter uses the local text Chat Completions adapter; a cloud gateway or Responses endpoint is not supported",
        },
        400,
      );
    const id = pathId ?? c.req.header("x-leash-session");
    if (!id || !store.get("session", id))
      return c.json(
        {
          error:
            "A Leash session is required. Use leash run or POST /control/sessions.",
        },
        400,
      );
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!body || typeof body.model !== "string")
      return c.json({ error: "model is required" }, 400);
    if (
      ["tools", "messages", "modalities"].some(
        (k) => body[k] !== undefined && !Array.isArray(body[k]),
      )
    )
      return c.json(
        { error: "tools, messages and modalities must be arrays" },
        400,
      );
    const unsupportedMedia = (value: any): boolean =>
      value &&
      typeof value === "object" &&
      ((typeof value.type === "string" &&
        /image|audio|video/.test(value.type)) ||
        Object.values(value).some(unsupportedMedia));
    if (unsupportedMedia(body))
      return c.json(
        {
          error:
            "Media token pricing is not supported; use text/tool-call requests",
        },
        400,
      );
    if (
      (body.n !== undefined && body.n !== 1) ||
      body.best_of ||
      /audio|realtime|search|image/.test(body.model) ||
      body.modalities?.some((m: string) => m !== "text")
    )
      return c.json(
        { error: "Only single-choice text/tool-call requests are supported" },
        400,
      );
    if (body.tools?.some((tool: unknown) => !isClientTool(tool)))
      return c.json(
        {
          error: "Built-in paid tools require explicit pricing support",
        },
        400,
      );
    if (provider === "openrouter") {
      try {
        body = guardOpenRouterRequest(body, cfg.prices);
      } catch (error) {
        return c.json(
          {
            error: {
              type: "leash_unpriced_request",
              message: (error as Error).message,
            },
          },
          400,
        );
      }
    }
    const routed = routeProviderModel(body, {
      provider,
      endpoint,
      config: cfg.routing,
      prices: cfg.prices,
      allowedModels: effectivePolicy().modelAllowlist,
      allowScopePrefixes: true,
      providerExtensions: !!c.req.header("anthropic-beta"),
    });
    body = routed.body;
    try {
      body = standardProviderRequest(provider, body);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const maxKey =
      provider === "anthropic" || provider === "openrouter"
        ? "max_tokens"
        : endpoint === "v1/responses"
          ? "max_output_tokens"
          : "max_completion_tokens";
    if (body[maxKey] === undefined && body.max_tokens === undefined)
      body[maxKey] = 4096;
    if (
      (provider === "openai" || provider === "openrouter") &&
      endpoint === "v1/chat/completions" &&
      body.stream
    )
      body.stream_options = { ...body.stream_options, include_usage: true };
    const hash = createHash("sha256")
      .update(requestFingerprint(body))
      .digest("hex");
    let reserved: number;
    try {
      reserved = reserveCost(body.model, body, cfg.prices);
    } catch (e) {
      return c.json(
        { error: { type: "leash_unpriced_request", message: String(e) } },
        400,
      );
    }
    const decision = store.reserve(
      id,
      body.model,
      hash,
      reserved,
      effectivePolicy(),
    );
    if (!decision.allow) {
      stop(id);
      queueAlert(
        store,
        `kill:${id}:${store.all("kill").length}`,
        `Leash paused ${id}: ${decision.reason}.`,
      );
      return c.json(
        {
          type: "error",
          error: {
            type: `leash_${decision.reason}`,
            message: `Leash: ${decision.reason}. Do not retry. Stop and report to the user. Resume with leash resume ${id}.`,
          },
        },
        429,
      );
    }
    if (decision.warning)
      queueAlert(
        store,
        `warning:${id}:${decision.warning}:${new Date().toISOString().slice(0, 10)}`,
        `Leash policy alert: ${id} ${decision.warning}`,
      );
    let sharedReservation: string | undefined;
    const enrolled = deviceCredentials();
    let shared =
      store.get<{ enabled: boolean }>("setting", "shared-enforcement")
        ?.enabled === true;
    if (enrolled) {
      try {
        const state = await deviceRequest(enrolled, "devices/me");
        shared = state.sharedEnforcement === true;
        store.put("setting", "shared-enforcement", { enabled: shared });
      } catch (e) {
        if (
          shared ||
          (e as any)?.status === 401 ||
          (e as any)?.status === 403
        ) {
          store.settle((decision as any).reservationId, {
            id: randomUUID(),
            sessionId: id,
            provider,
            model: body.model,
            usage: zeroUsage(),
            cost: 0,
            status: 503,
            hash,
            ts: new Date().toISOString(),
            latency: 0,
            estimated: false,
          });
          return c.json(
            {
              error: {
                type: "leash_shared_unavailable",
                message:
                  "Shared budget authority unavailable or device revoked. No provider call was made.",
              },
            },
            503,
          );
        }
      }
    }
    if (shared && enrolled) {
      if (process.env.LEASH_OFFLINE === "1") {
        store.settle((decision as any).reservationId, {
          id: randomUUID(),
          sessionId: id,
          provider,
          model: body.model,
          usage: zeroUsage(),
          cost: 0,
          status: 503,
          hash,
          ts: new Date().toISOString(),
          latency: 0,
          estimated: false,
        });
        return c.json(
          {
            error: {
              type: "leash_shared_offline",
              message: "Shared enforcement requires online admission.",
            },
          },
          503,
        );
      }
      try {
        await flushSharedSettlements(store);
        const s = store.get<Session>("session", id)!;
        const r = await deviceRequest(enrolled, "devices/me/reservations", {
          id: (decision as any).reservationId,
          sessionId: id,
          model: body.model,
          provider,
          reqHash: hash,
          maxTokens: Math.max(
            ...[
              body.max_tokens,
              body.max_completion_tokens,
              body.max_output_tokens,
            ]
              .filter((v) => v !== undefined)
              .map(Number),
          ),
          longCache: JSON.stringify(body).includes('"1h"'),
          agent: s.agent,
          cap: s.cap,
          repoHash: s.repoHash,
        });
        sharedReservation = r.reservationId;
        await deviceRequest(
          enrolled,
          `devices/me/reservations/${sharedReservation}/dispatch`,
          {},
        );
      } catch (e) {
        store.settle((decision as any).reservationId, {
          id: randomUUID(),
          sessionId: id,
          provider,
          model: body.model,
          usage: zeroUsage(),
          cost: 0,
          status: 503,
          hash,
          ts: new Date().toISOString(),
          latency: 0,
          estimated: false,
        });
        if ((e as any).status === 429)
          store.kill(id, "shared_budget_or_policy");
        return c.json(
          {
            error: {
              type: "leash_shared_admission",
              message: (e as Error).message,
            },
          },
          (e as any).status === 429 ? 429 : 503,
        );
      }
    }
    const controller = new AbortController();
    const controllers = active.get(id) ?? new Set();
    controllers.add(controller);
    active.set(id, controllers);
    const timeout = setTimeout(() => controller.abort(), 300000);
    const started = Date.now();
    const meter = new UsageMeter();
    let optimization: RequestOptimization | undefined;
    let settled = false;
    let detachReaderAbort = () => {};
    const settle = async (status: number, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      detachReaderAbort();
      controllers.delete(controller);
      if (!controllers.size) active.delete(id);
      let amount = 0;
      let estimated = false;
      if ((status >= 200 && status < 300) || failed) {
        estimated = !meter.seen || !meter.completed;
        amount = estimated
          ? reserved
          : cost(body.model, meter.usage, cfg.prices);
        if (provider === "openrouter")
          amount = Math.max(amount, meter.reportedCost ?? 0);
      }
      store.settle("reservationId" in decision ? decision.reservationId : "", {
        id: sharedReservation ?? randomUUID(),
        sessionId: id,
        provider,
        model: body.model,
        usage: meter.usage,
        cost: amount,
        status,
        hash,
        ts: new Date().toISOString(),
        latency: Date.now() - started,
        estimated,
        optimization,
      });
      if (sharedReservation) {
        store.put("shared-settlement", sharedReservation, {
          id: sharedReservation,
          usage: meter.usage,
          status,
          complete: !estimated,
        });
        await flushSharedSettlements(store).catch(() => {});
      }
      const s = store.get<Session>("session", id)!;
      const now = new Date().toISOString(),
        events = store.all<any>("event");
      const policy = {
        ...cfg.policy,
        ...store.get<Policy>("setting", "policy"),
      };
      const scopes = [
        { id, spent: s.spent, cap: s.cap },
        ...(
          [
            ["day", 10, policy.dailyCap],
            ["month", 7, policy.monthlyCap],
          ] as const
        ).map(([period, len, cap]) => ({
          id: `${period}:${now.slice(0, len)}`,
          cap,
          spent: events
            .filter((e) => e.ts.startsWith(now.slice(0, len)))
            .reduce((n, e) => n + e.cost, 0),
        })),
      ];
      for (const b of store.all<any>("repo-budget")) {
        const members = new Set(
          store
            .all<Session>("session")
            .filter((x) => x.repoHash === b.scopeId)
            .map((x) => x.id),
        );
        const prefix = now.slice(0, b.period === "day" ? 10 : 7);
        scopes.push({
          id: `repo:${b.scopeId}:${prefix}`,
          cap: b.limitUsd,
          spent: events
            .filter((e) => members.has(e.sessionId) && e.ts.startsWith(prefix))
            .reduce((n, e) => n + e.cost, 0),
        });
      }
      for (const scope of scopes)
        for (const pct of [50, 80, 100])
          if ((scope.spent / scope.cap) * 100 >= pct)
            queueAlert(
              store,
              `threshold:${scope.id}:${scope.cap}:${pct}`,
              `Leash budget ${pct}%: ${scope.id}, $${scope.spent.toFixed(4)} / $${scope.cap.toFixed(2)}`,
            );
    };
    try {
      const headers = new Headers({ "content-type": "application/json" });
      for (const name of [
        "authorization",
        "x-api-key",
        "anthropic-version",
        "anthropic-beta",
        "openai-organization",
        "openai-project",
      ]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      if (cfg.gateway) {
        headers.delete("authorization");
        headers.delete("x-api-key");
        headers.set("x-leash-key", cfg.gateway.token);
        headers.set("x-leash-session", id);
        if (store.get<Session>("session", id)?.repoHash)
          headers.set(
            "x-leash-repo",
            store.get<Session>("session", id)!.repoHash!,
          );
        // Passthrough provider keys are used only when a virtual key has no stored credential.
        const providerKey =
          provider === "anthropic"
            ? c.req.header("x-api-key")
            : c.req.header("authorization")?.replace(/^Bearer /, "");
        if (
          providerKey &&
          !providerKey.startsWith("lsh_") &&
          providerKey !== LOCAL_CREDENTIAL_MARKER &&
          providerKey !== "leash-managed"
        )
          headers.set("x-leash-provider-key", providerKey);
      }
      const base = cfg.gateway
        ? `${cfg.gateway.url}/${provider}`
        : provider === "anthropic"
          ? (process.env.LEASH_ANTHROPIC_UPSTREAM ??
            "https://api.anthropic.com")
          : provider === "openrouter"
            ? (process.env.LEASH_OPENROUTER_UPSTREAM ??
              "https://openrouter.ai/api")
            : (process.env.LEASH_OPENAI_UPSTREAM ?? "https://api.openai.com");
      const callerCredential =
        provider === "anthropic"
          ? c.req.header("x-api-key")
          : c.req.header("authorization")?.replace(/^Bearer /, "");
      if (callerCredential === LOCAL_CREDENTIAL_MARKER) {
        if (cfg.gateway)
          throw new Error(
            "Local provider credentials cannot be forwarded to a cloud gateway. Use a local device connection",
          );
        const local = localProviderRequest(
          cfg.dir,
          provider,
          callerCredential,
          base,
        )!;
        headers.delete("authorization");
        headers.delete("x-api-key");
        headers.set(
          provider === "anthropic" ? "x-api-key" : "authorization",
          provider === "anthropic" ? local.secret : `Bearer ${local.secret}`,
        );
      }
      // Admission and loop fingerprinting use the original payload with the
      // explicitly selected model. Tool compression happens only afterwards.
      // Optimization changes only the representation sent after admission, never
      // the hard-cap bound or the provider-reported streaming usage.
      const optimized = optimizeProviderToolOutputs(body, {
        provider: provider === "openrouter" ? "openai" : provider,
        endpoint,
        mode: cfg.toolCompression ?? "lossless",
        observeRepeat: (name, protocol, text) =>
          store.observeToolOutput(id, name, protocol, text),
      });
      optimization = { ...optimized.metadata, routing: routed.decision };
      if (cfg.gateway) {
        // The gateway must validate the original scope too, and must not reroute a
        // locally reserved request; otherwise local pricing could diverge.
        headers.set("x-leash-model-routing", "preserve");
        headers.set("x-leash-requested-model", routed.decision.requestedModel);
        headers.set("x-leash-routing-policy", routed.decision.policy);
      }
      if (cfg.gateway)
        headers.set(
          "x-leash-tool-compression",
          cfg.toolCompression ?? "lossless",
        );
      const response = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(optimized.body),
        signal: controller.signal,
        redirect: "error",
      });
      const outHeaders = new Headers();
      for (const name of [
        "content-type",
        "request-id",
        "x-request-id",
        "retry-after",
      ]) {
        const value = response.headers.get(name);
        if (value) outHeaders.set(name, value);
      }
      outHeaders.set("cache-control", "no-store");
      outHeaders.set("x-leash-requested-model", routed.decision.requestedModel);
      outHeaders.set("x-leash-used-model", routed.decision.usedModel);
      outHeaders.set("x-leash-routing-reason", routed.decision.reason);
      if ((cfg.toolCompression ?? "lossless") === "lossless") {
        outHeaders.set("x-leash-tool-compression", optimized.summary.reason);
        outHeaders.set(
          "x-leash-tool-chars-saved",
          String(optimized.summary.beforeChars - optimized.summary.afterChars),
        );
        outHeaders.set(
          "x-leash-tool-estimated-tokens-saved",
          String(
            optimized.summary.estimatedTokensBefore -
              optimized.summary.estimatedTokensAfter,
          ),
        );
      }
      if (!response.body) {
        await settle(response.status, true);
        return new Response(null, {
          status: response.status,
          headers: outHeaders,
        });
      }
      const reader = response.body.getReader();
      // Body cancellation is required even if the fetch implementation stops
      // forwarding aborts after it has returned response headers.
      const cancelReader = () => {
        void reader.cancel(controller.signal.reason).catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      detachReaderAbort = () =>
        controller.signal.removeEventListener("abort", cancelReader);
      if (controller.signal.aborted) cancelReader();
      const decoder = new TextDecoder();
      let json = "";
      const sse = response.headers
        .get("content-type")
        ?.includes("text/event-stream");
      const stream = new ReadableStream<Uint8Array>({
        async pull(control) {
          try {
            const { done, value } = await reader.read();
            controller.signal.throwIfAborted();
            if (done) {
              if (sse) meter.feed(decoder.decode() + "\n\n");
              else {
                try {
                  meter.accept(JSON.parse(json + decoder.decode()));
                  meter.completed = true;
                } catch {}
              }
              await settle(response.status);
              control.close();
              return;
            }
            const text = decoder.decode(value, { stream: true });
            if (sse) meter.feed(text);
            else {
              json += text;
              if (json.length > 16_000_000)
                throw new Error("Response exceeds limit");
            }
            control.enqueue(value);
          } catch (error) {
            await settle(response.status, true);
            controller.abort();
            control.error(error);
          }
        },
        async cancel() {
          controller.abort();
          await reader.cancel().catch(() => {});
          await settle(response.status, true);
        },
      });
      return new Response(stream, {
        status: response.status,
        headers: outHeaders,
      });
    } catch {
      await settle(502, true);
      return c.json(
        {
          error: {
            type: "leash_upstream_error",
            message:
              "Provider request interrupted. Reservation retained as estimated spend; inspect leash status.",
          },
        },
        502,
      );
    }
  });
  return app;
}
export function startProxy() {
  const cfg = config(),
    store = new Store(cfg.dir);
  const app = createProxy(store, cfg);
  const server = serve({
    fetch: app.fetch,
    hostname: listenHost(process.env),
    port: cfg.port,
  });
  let syncing = false;
  const tick = async () => {
    if (syncing) return;
    syncing = true;
    try {
      await flushAlerts(store);
      if (
        deviceCredentials() &&
        process.env.LEASH_OFFLINE !== "1" &&
        process.env.LEASH_SYNC !== "0"
      )
        await deviceCycle(store, async (path, body) => {
          const r = await app.request(`/control/${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-leash-local-token": cfg.token,
            },
            body: JSON.stringify(body),
          });
          const data = (await r.json()) as any;
          if (!r.ok)
            throw Object.assign(
              new Error(data.error ?? "Local command failed"),
              { status: r.status },
            );
          return data;
        });
      else if (!cfg.gateway) await sync(store);
    } catch {
      console.error(
        "Leash: metadata sync pending; local enforcement remains active.",
      );
    } finally {
      syncing = false;
    }
  };
  const timer = setInterval(tick, 2000);
  void tick();
  timer.unref();
  return { server, store, cfg, timer };
}
