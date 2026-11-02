import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "./state.js";
import { defaultPolicy, zeroUsage } from "./core/index.js";
import { randomUUID } from "node:crypto";
it("keeps crash reservations across restart and settles once only", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-durability-"));
  let a = new Store(dir);
  try {
    const s = a.create("test", 1);
    const r = a.reserve(s.id, "gpt-4o", "h", 0.75, defaultPolicy);
    a.db.close();
    a = new Store(dir);
    expect(a.snapshot().reserved).toBe(0.75);
    expect(a.reserve(s.id, "gpt-4o", "other", 0.5, defaultPolicy).allow).toBe(
      false,
    );
    const event = {
      id: randomUUID(),
      sessionId: s.id,
      provider: "openai",
      model: "gpt-4o",
      usage: zeroUsage(),
      cost: 0.2,
      status: 200,
      hash: "h",
      ts: new Date().toISOString(),
      latency: 1,
      estimated: false,
    };
    if ("reservationId" in r) {
      a.settle(r.reservationId, event);
      a.settle(r.reservationId, event);
    }
    expect(a.snapshot().reserved).toBe(0);
    expect(a.snapshot().events).toHaveLength(1);
    expect(a.snapshot().sessions[0].spent).toBe(0.2);
  } finally {
    a.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reconciles orphan reservations without dropping their spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-reconcile-")),
    store = new Store(dir);
  try {
    const s = store.create("test", 20),
      r = store.reserve(s.id, "gpt-4o", "hash", 1, defaultPolicy);
    if (!("reservationId" in r)) throw new Error("expected reservation");
    expect(() => store.reconcile(r.reservationId, -1)).toThrow();
    store.reconcile(r.reservationId, 0.25);
    expect(store.snapshot().reserved).toBe(0);
    expect(store.snapshot().sessions[0].spent).toBe(0.25);
    expect(store.snapshot().events[0].model).toBe("reconciled-reservation");
    expect(() => store.reconcile(r.reservationId, 0)).toThrow();
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reserves repository budgets across concurrent sessions, without affecting another repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-repo-")),
    store = new Store(dir);
  try {
    const hash = "a".repeat(64),
      a = store.create("a", 20, { repoHash: hash }),
      b = store.create("b", 20, { repoHash: hash }),
      other = store.create("c", 20, { repoHash: "b".repeat(64) });
    store.put("repo-budget", hash, {
      scopeId: hash,
      period: "month",
      limitUsd: 1,
      action: "block",
    });
    expect(store.reserve(a.id, "gpt-4o", "a", 0.75, defaultPolicy).allow).toBe(
      true,
    );
    expect(store.reserve(b.id, "gpt-4o", "b", 0.5, defaultPolicy).reason).toBe(
      "repo_budget",
    );
    expect(
      store.reserve(other.id, "gpt-4o", "c", 0.5, defaultPolicy).allow,
    ).toBe(true);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("applies a signed resume operation once across process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-resume-"));
  let store = new Store(dir);
  try {
    const s = store.create("test", 20);
    store.kill(s.id, "manual");
    store.resume(s.id, 10, "operation");
    store.db.close();
    store = new Store(dir);
    store.resume(s.id, 10, "operation");
    expect(store.get<any>("session", s.id).cap).toBe(30);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("resumes request-ceiling protection without erasing lifetime request history", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-ceiling-")),
    store = new Store(dir);
  try {
    const s = store.create("test", 20);
    s.requests = 800;
    store.put("session", s.id, s);
    expect(store.reserve(s.id, "gpt-4o", "h", 0.1, defaultPolicy).reason).toBe(
      "max_requests",
    );
    store.resume(s.id);
    expect(store.reserve(s.id, "gpt-4o", "h", 0.1, defaultPolicy).allow).toBe(
      true,
    );
    expect(store.get<any>("session", s.id).requests).toBe(801);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps bounded salted tool-result fingerprints local and session-isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-xray-")),
    store = new Store(dir);
  try {
    const a = store.create("agent", 20),
      b = store.create("other", 20);
    expect(
      store.observeToolOutput(
        a.id,
        "read_file",
        "openai-chat",
        "PRIVATE_RESULT",
      ),
    ).toBe(false);
    expect(
      store.observeToolOutput(
        a.id,
        "read_file",
        "openai-chat",
        "PRIVATE_RESULT",
      ),
    ).toBe(true);
    expect(
      store.observeToolOutput(
        b.id,
        "read_file",
        "openai-chat",
        "PRIVATE_RESULT",
      ),
    ).toBe(false);
    expect(
      store.observeToolOutput(a.id, "another", "openai-chat", "PRIVATE_RESULT"),
    ).toBe(false);
    for (let i = 0; i < 200; i++)
      store.observeToolOutput(a.id, "read_file", "openai-chat", String(i));
    const evidence = store.get<{ hashes: string[] }>(
      "tool-fingerprints",
      a.id,
    )!;
    expect(evidence.hashes).toHaveLength(128);
    expect(evidence.hashes.every((h) => /^[a-f0-9]{64}$/.test(h))).toBe(true);
    expect(JSON.stringify(store.all("tool-fingerprints"))).not.toContain(
      "PRIVATE_RESULT",
    );
    expect(JSON.stringify(store.snapshot())).not.toContain(evidence.hashes[0]);
    store.put("tool-fingerprints", a.id, {
      hashes: evidence.hashes,
      ts: Date.now() - 86400001,
    });
    expect(
      store.observeToolOutput(a.id, "read_file", "openai-chat", "199"),
    ).toBe(false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
