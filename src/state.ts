import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { join } from "node:path";
import {
  evaluate,
  type Policy,
  type PolicyState,
  type Usage,
  zeroUsage,
  type RequestOptimization,
} from "./core/index.js";
export type Session = {
  id: string;
  agent: string;
  repoHash?: string;
  branch?: string;
  status: string;
  spent: number;
  cap: number;
  budgetAction?: "block" | "alert";
  requests: number;
  subagents: number;
  startedAt: string;
  endedAt?: string;
  deviceRevision?: number;
};
export type Event = {
  id: string;
  sessionId: string;
  provider: string;
  model: string;
  usage: Usage;
  cost: number;
  status: number;
  hash: string;
  ts: string;
  latency: number;
  estimated: boolean;
  optimization?: RequestOptimization;
};
export type RepoBudget = {
  scopeId: string;
  period: "day" | "month";
  limitUsd: number;
  action: "block" | "alert";
};
export type Kill = {
  id: string;
  sessionId: string;
  reason: string;
  spent: number;
  estimatedSaved?: number;
  ts: string;
};
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS docs(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,synced INTEGER DEFAULT 0,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,session TEXT,amount REAL,ts INTEGER,hash TEXT);`,
    );
    if (
      !(this.db.prepare("PRAGMA table_info(docs)").all() as any[]).some(
        (c) => c.name === "revision",
      )
    )
      this.db.exec(
        "ALTER TABLE docs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      );
  }
  all<T>(kind: string): T[] {
    return (
      this.db.prepare("SELECT data FROM docs WHERE kind=?").all(kind) as any[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM docs WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  put(kind: string, id: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO docs(kind,id,data,revision) VALUES(?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,synced=0,revision=docs.revision+1",
      )
      .run(kind, id, JSON.stringify(data));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  create(agent: string, cap: number, meta: Partial<Session> = {}) {
    const s: Session = {
      id: randomUUID(),
      agent,
      status: "active",
      spent: 0,
      cap,
      requests: 0,
      subagents: 0,
      startedAt: new Date().toISOString(),
      ...meta,
    };
    this.put("session", s.id, s);
    return s;
  }
  kill(id: string, reason: string) {
    const s = this.get<Session>("session", id);
    if (!s) throw new Error("Session not found");
    if (s.status === "killed") return;
    s.status = "killed";
    this.put("session", id, s);
    const k: Kill = {
      id: randomUUID(),
      sessionId: id,
      reason,
      spent: s.spent,
      // Counterfactual: recent five-minute rate continuing for another 30 minutes.
      estimatedSaved:
        this.all<Event>("event")
          .filter(
            (e) => e.sessionId === id && Date.parse(e.ts) > Date.now() - 300000,
          )
          .reduce((n, e) => n + e.cost, 0) * 6,
      ts: new Date().toISOString(),
    };
    this.put("kill", k.id, k);
  }
  resume(id: string, add = 0, operationId?: string) {
    this.transaction(() => {
      if (operationId && this.get("control-operation", operationId)) return;
      const s = this.get<Session>("session", id);
      if (!s) throw new Error("Session not found");
      if (operationId)
        this.put("control-operation", operationId, {
          sessionId: id,
          ts: Date.now(),
        });
      s.status = "active";
      s.subagents = 0;
      delete s.endedAt;
      s.cap += add;
      this.put("session", id, s);
      this.put("resume", id, { ts: Date.now(), requests: s.requests });
    });
  }
  reserve(
    id: string,
    model: string,
    hash: string,
    amount: number,
    policy: Policy,
  ) {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("Invalid reservation amount");
    return this.transaction(() => {
      const s = this.get<Session>("session", id);
      if (!s) throw new Error("Session not found");
      const now = Date.now(),
        today = new Date().toISOString().slice(0, 10),
        month = today.slice(0, 7);
      const events = this.all<Event>("event");
      const reservations = this.db
        .prepare("SELECT * FROM reservations")
        .all() as any[];
      const resumed = this.get<{ ts: number; requests?: number }>("resume", id);
      const reset = resumed?.ts ?? 0;
      const state: PolicyState = {
        killed: s.status !== "active" || !!this.get("setting", "panic"),
        spent: s.spent,
        reserved: reservations
          .filter((r) => r.session === id)
          .reduce((a, r) => a + r.amount, 0),
        daily:
          events
            .filter((e) => e.ts.startsWith(today))
            .reduce((a, e) => a + e.cost, 0) +
          reservations.reduce((a, r) => a + r.amount, 0),
        monthly:
          events
            .filter((e) => e.ts.startsWith(month))
            .reduce((a, e) => a + e.cost, 0) +
          reservations.reduce((a, r) => a + r.amount, 0),
        requests: s.requests - (resumed?.requests ?? 0),
        subagents: s.subagents,
        recent: [
          ...events
            .filter((e) => e.sessionId === id && Date.parse(e.ts) > reset)
            .map((e) => ({ hash: e.hash, ts: Date.parse(e.ts), cost: e.cost })),
          ...reservations
            .filter((r) => r.session === id)
            .map((r) => ({ hash: r.hash, ts: r.ts, cost: 0 })),
        ],
      };
      let budgetWarning: string | undefined;
      for (const budget of this.all<RepoBudget>("repo-budget")) {
        if (budget.scopeId !== s.repoHash) continue;
        const members = new Set(
          this.all<Session>("session")
            .filter((x) => x.repoHash === s.repoHash)
            .map((x) => x.id),
        );
        const prefix = budget.period === "day" ? today : month;
        const spent = events
          .filter((e) => members.has(e.sessionId) && e.ts.startsWith(prefix))
          .reduce((a, e) => a + e.cost, 0);
        const held = reservations
          .filter((r) => members.has(r.session))
          .reduce((a, r) => a + r.amount, 0);
        if (spent + held + amount > budget.limitUsd) {
          if (budget.action === "block") {
            this.kill(id, "repo_budget");
            return { allow: false, reason: "repo_budget" };
          }
          budgetWarning = "repo_budget_alert";
        }
      }
      const result = evaluate(
        model,
        hash,
        amount,
        state,
        {
          ...policy,
          sessionCap: s.cap,
          sessionAction: s.budgetAction ?? policy.sessionAction,
        },
        now,
      );
      if (!result.allow) {
        this.kill(id, result.reason!);
        return result;
      }
      const rid = randomUUID();
      this.db
        .prepare("INSERT INTO reservations VALUES(?,?,?,?,?)")
        .run(rid, id, amount, now, hash);
      s.requests++;
      this.put("session", id, s);
      return {
        ...result,
        warning: result.warning ?? budgetWarning,
        reservationId: rid,
      };
    });
  }
  /** Session-scoped salted fingerprints stay local; only repetition booleans sync. */
  observeToolOutput(
    sessionId: string,
    name: string,
    protocol: string,
    text: string,
  ) {
    let secret = this.get<{ value: string }>("setting", "xray-secret");
    if (!secret) {
      secret = { value: randomBytes(32).toString("hex") };
      this.put("setting", "xray-secret", secret);
    }
    const hash = createHmac("sha256", secret.value)
      .update(sessionId)
      .update("\0")
      .update(name)
      .update("\0")
      .update(protocol)
      .update("\0")
      .update(text)
      .digest("hex");
    const old = this.get<{ hashes: string[]; ts: number }>(
      "tool-fingerprints",
      sessionId,
    );
    const hashes =
      old && Date.now() - old.ts < 86400000 ? old.hashes.slice(-127) : [];
    const repeated = hashes.includes(hash);
    this.put("tool-fingerprints", sessionId, {
      hashes: [...hashes, hash],
      ts: Date.now(),
    });
    return repeated;
  }
  settle(rid: string, event: Event) {
    this.transaction(() => {
      if (!this.db.prepare("SELECT id FROM reservations WHERE id=?").get(rid))
        return;
      this.db.prepare("DELETE FROM reservations WHERE id=?").run(rid);
      this.put("event", event.id, event);
      const s = this.get<Session>("session", event.sessionId)!;
      s.spent += event.cost;
      this.put("session", s.id, s);
    });
  }
  reconcile(id: string, actualCost: number) {
    if (!Number.isFinite(actualCost) || actualCost < 0)
      throw new Error("Cost must be a nonnegative finite number");
    const r = this.db
      .prepare("SELECT * FROM reservations WHERE id=?")
      .get(id) as
      | {
          id: string;
          session: string;
          amount: number;
          ts: number;
          hash: string;
        }
      | undefined;
    if (!r) throw new Error("Reservation not found");
    this.settle(id, {
      id: randomUUID(),
      sessionId: r.session,
      provider: "manual",
      model: "reconciled-reservation",
      usage: zeroUsage(),
      cost: actualCost,
      status: 499,
      hash: r.hash,
      ts: new Date(r.ts).toISOString(),
      latency: 0,
      estimated: true,
    });
    this.put("reconciliation", id, {
      reservationUsd: r.amount,
      actualCost,
      ts: new Date().toISOString(),
    });
  }
  snapshot() {
    const sessions = this.all<Session>("session").sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    return {
      sessions,
      workspaceId:
        this.get<{ orgId: string }>("setting", "workspace")?.orgId ??
        "00000000-0000-4000-8000-000000000001",
      reservations: this.db.prepare("SELECT * FROM reservations").all(),
      events: this.all<Event>("event"),
      kills: this.all<Kill>("kill"),
      panic: !!this.get("setting", "panic"),
      alertsPending: this.all<{ delivered: boolean }>("delivery").filter(
        (d) => !d.delivered,
      ).length,
      reserved: (
        this.db
          .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM reservations")
          .get() as any
      ).total,
    };
  }
}
