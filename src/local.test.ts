import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localCost, pricingVersion } from "./core/index.js";
import {
  LocalLedger,
  scanAll,
  report,
  Watcher,
  toolOfProcess,
  killFallbackTargets,
  toolsStillRunning,
  MAX_LINE,
  type Source,
} from "./local.js";
import { writeCachedState, type WorkspaceState } from "./local-state.js";

const fixture = (name: string) =>
  readFileSync(join("fixtures/local-agent", name), "utf8");
let home: string,
  claude: string,
  codex: string,
  cursor: string,
  sources: Source[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "leash-local-"));
  process.env.LEASH_HOME = home;
  claude = join(home, "claude");
  codex = join(home, "codex");
  cursor = join(home, "cursor");
  for (const d of [claude, codex, cursor]) mkdirSync(d, { recursive: true });
  sources = [
    { tool: "claude-code", root: claude },
    { tool: "codex", root: codex },
    { tool: "cursor", root: cursor },
  ];
});
const open = () => {
  const l = new LocalLedger(join(home, "local"));
  l.setMeta("since", "2026-01-01T00:00:00.000Z");
  return l;
};
const rows = (l: LocalLedger) =>
  (
    l.db
      .prepare("SELECT key, rev, sent, data FROM outbox ORDER BY key")
      .all() as any[]
  ).map((r) => ({ ...r, data: JSON.parse(r.data) }));
const offset = (l: LocalLedger, path: string) => l.file(path)!.offset;

describe("offsets", () => {
  it("keeps project hashes stable across restarts and private to each ledger", () => {
    let l = open();
    const project = "/private/customer/project";
    const key = l.projectKey(project);
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(l.projectKey("/private/customer/other")).not.toBe(key);
    l.close();
    l = open();
    expect(l.projectKey(project)).toBe(key);
    const other = new LocalLedger(join(home, "other-ledger"));
    expect(other.projectKey(project)).not.toBe(key);
    expect(l.projectKey(undefined)).toBeUndefined();
    other.close();
    l.close();
  });
  it("never double counts across rescans and restarts", () => {
    const path = join(claude, "s.jsonl");
    writeFileSync(path, fixture("claude-session.jsonl"));
    let l = open();
    scanAll(l, sources);
    const first = rows(l);
    expect(first.map((r) => r.data.eventId)).toEqual([
      "msg_fixture_1",
      "msg_fixture_2",
    ]);
    // The streamed response is stored once with its final counters.
    expect(first[0].data.usage.output).toBe(631);
    scanAll(l, sources);
    l.close();
    l = open();
    scanAll(l, sources);
    expect(rows(l)).toEqual(first);
    expect(offset(l, path)).toBe(readFileSync(path).length);
    l.close();
  });
  it("waits for a partial last line to be completed", () => {
    const path = join(claude, "s.jsonl");
    const line = fixture("claude-session.jsonl").split("\n")[7];
    writeFileSync(path, line.slice(0, 50));
    const l = open();
    scanAll(l, sources);
    expect(rows(l)).toHaveLength(0);
    expect(offset(l, path)).toBe(0);
    appendFileSync(path, line.slice(50) + "\n");
    scanAll(l, sources);
    expect(rows(l).map((r) => r.data.eventId)).toEqual(["msg_fixture_2"]);
    l.close();
  });
  it("restarts a truncated file without duplicating events", () => {
    const path = join(claude, "s.jsonl");
    writeFileSync(path, fixture("claude-session.jsonl"));
    const l = open();
    scanAll(l, sources);
    truncateSync(path, 0);
    const keep =
      fixture("claude-session.jsonl").split("\n").slice(0, 3).join("\n") + "\n";
    writeFileSync(path, keep);
    scanAll(l, sources);
    expect(rows(l)).toHaveLength(2);
    expect(offset(l, path)).toBe(Buffer.byteLength(keep));
    l.close();
  });
  it("detects rotation by inode and by the first bytes", () => {
    const path = join(claude, "s.jsonl");
    writeFileSync(path, fixture("claude-session.jsonl"));
    const l = open();
    scanAll(l, sources);
    renameSync(path, join(home, "rotated.jsonl"));
    const other = fixture("claude-session.jsonl").replaceAll(
      "msg_fixture",
      "msg_rotated",
    );
    writeFileSync(path, other);
    scanAll(l, sources);
    expect(
      rows(l)
        .map((r) => r.data.eventId)
        .sort(),
    ).toEqual([
      "msg_fixture_1",
      "msg_fixture_2",
      "msg_rotated_1",
      "msg_rotated_2",
    ]);
    l.close();
  });
  it("skips oversized lines without buffering them, even across passes", () => {
    const path = join(codex, "rollout.jsonl");
    const [meta, ctx, , record] = fixture("codex-rollout.jsonl").split("\n");
    const huge = JSON.stringify({
      type: "response_item",
      payload: { text: "x".repeat(MAX_LINE * 2) },
    });
    writeFileSync(path, [meta, ctx, huge, record, ""].join("\n"));
    const l = open();
    scanAll(l, sources);
    expect(rows(l).map((r) => r.data.eventId)).toEqual(["resp_fixture_1"]);
    expect(offset(l, path)).toBe(readFileSync(path).length);
    l.close();
  });
  it("only emits events at or after the configured start", () => {
    writeFileSync(join(codex, "legacy.jsonl"), fixture("codex-legacy.jsonl"));
    const l = open();
    l.setMeta("since", "2026-09-01T09:00:15.000Z");
    scanAll(l, sources);
    // The first total is before the start but still sets the baseline for the delta.
    expect(rows(l).map((r) => [r.data.eventId, r.data.usage.input])).toEqual([
      ["total:2590", 500],
    ]);
    l.close();
  });
});

describe("pricing in the outbox", () => {
  it("records cost and pricing version per event; unknown models stay unpriced", () => {
    writeFileSync(join(codex, "r.jsonl"), fixture("codex-rollout.jsonl"));
    writeFileSync(
      join(cursor, "usage-2026-10.jsonl"),
      fixture("cursor-spool.jsonl"),
    );
    const l = open();
    scanAll(l, sources);
    const byId = Object.fromEntries(
      rows(l).map((r) => [r.data.eventId, r.data]),
    );
    expect(byId.resp_fixture_1.costUsd).toBe(
      localCost("gpt-6-sol", byId.resp_fixture_1.usage),
    );
    expect(byId.resp_fixture_1.pricingVersion).toBe(pricingVersion);
    expect(byId.resp_fixture_3.costUsd).toBeNull();
    expect(byId["66666666-6666-4666-8666-666666666666"].costUsd).toBeNull();
    const t = l.totals("2026-01-01");
    expect(t.tools.codex.events).toBe(3);
    expect(t.tools.codex.unpriced).toBe(1);
    expect(t.tools.cursor.events).toBe(2);
    l.close();
  });
});

describe("reporting", () => {
  it("batches, marks sent, resends grown events and parks rejected ones", async () => {
    const path = join(claude, "s.jsonl");
    writeFileSync(path, fixture("claude-session.jsonl"));
    const l = open();
    scanAll(l, sources);
    const bodies: any[] = [];
    let status = 202;
    const post = async (body: any) => {
      bodies.push(body);
      return { status, data: {} };
    };
    expect(await report(l, post)).toBe(2);
    expect(JSON.stringify(bodies[0])).not.toMatch(/FIXTURE|costUsd/);
    expect(Object.keys(bodies[0].events[0]).sort()).toEqual([
      "eventId",
      "model",
      "pricingVersion",
      "projectKey",
      "sessionId",
      "surface",
      "tool",
      "toolRepeat",
      "ts",
      "usage",
    ]);
    // The project is sent as a keyed hash; its directory name never leaves.
    expect(bodies[0].events[0].projectKey).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(bodies[0])).not.toContain("s.jsonl");
    expect(await report(l, post)).toBe(0);
    // The same response logged again with more output is sent again.
    const grown = fixture("claude-session.jsonl")
      .split("\n")[3]
      .replace('"output_tokens":631', '"output_tokens":900');
    appendFileSync(path, grown + "\n");
    scanAll(l, sources);
    expect(await report(l, post)).toBe(1);
    expect(bodies.at(-1).events[0].usage.output).toBe(900);
    // Unauthorized: keep everything pending and record the error.
    appendFileSync(
      path,
      grown.replace("msg_fixture_1", "msg_fixture_3") + "\n",
    );
    scanAll(l, sources);
    status = 401;
    expect(
      await report(l, async () => ({
        status,
        data: { error: "Session expired" },
      })),
    ).toBe(0);
    expect(l.meta("lastReportError")).toBe("Session expired");
    expect(l.totals("2026-01-01").pending).toBe(1);
    // A batch the server rejects is retried one by one; the bad event is parked.
    status = 400;
    expect(await report(l, async () => ({ status: 400, data: {} }))).toBe(0);
    expect(l.totals("2026-01-01")).toMatchObject({ pending: 0, rejected: 1 });
    l.close();
  });
  it("caches the workspace state returned by the API", async () => {
    writeFileSync(join(claude, "s.jsonl"), fixture("claude-session.jsonl"));
    const l = open();
    scanAll(l, sources);
    await report(l, async () => ({
      status: 202,
      data: { state: blockedState() },
    }));
    expect(
      JSON.parse(readFileSync(join(home, "local/state.json"), "utf8")).state
        .blocked,
    ).toBe(true);
    l.close();
  });
});

function blockedState(): WorkspaceState {
  const budget = {
    period: "day" as const,
    spentUsd: 120,
    reservedUsd: 0,
    capUsd: 100,
    action: "block",
    exhausted: true,
  };
  return {
    killed: false,
    blocked: true,
    reason: "daily_budget",
    daily: budget,
    monthly: { ...budget, period: "month", exhausted: false, capUsd: 1000 },
    checkedAt: new Date().toISOString(),
  };
}

describe("process fallback", () => {
  const procs = [
    {
      pid: 101,
      uid: 501,
      exe: "/home/example/Library/Application Support/Claude/claude-code/2.1.299/abc/claude.app/Contents/MacOS/claude",
    },
    {
      pid: 102,
      uid: 501,
      exe: "/Applications/Claude.app/Contents/MacOS/Claude",
    },
    {
      pid: 103,
      uid: 501,
      exe: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    },
    {
      pid: 104,
      uid: 501,
      exe: "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
    },
    { pid: 105, uid: 0, exe: "/opt/homebrew/bin/codex" },
    {
      pid: 106,
      uid: 501,
      exe: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    },
    { pid: 107, uid: 501, exe: "/usr/local/bin/cursor-agent" },
  ];
  it("matches agent CLIs only, never the desktop or editor apps", () => {
    expect(procs.map((p) => toolOfProcess(p.exe))).toEqual([
      "claude-code",
      undefined,
      "codex",
      undefined,
      "codex",
      undefined,
      "cursor",
    ]);
    expect(
      killFallbackTargets(procs, new Set(["codex"]), 501).map((p) => p.pid),
    ).toEqual([103]);
  });
  it("only targets tools that kept calling the model after the grace period", () => {
    const t0 = Date.parse("2026-10-18T10:00:00Z");
    const tools = toolsStillRunning(
      [
        { tool: "claude-code", ts: "2026-10-18T10:00:30Z" },
        { tool: "codex", ts: "2026-10-18T10:01:30Z" },
      ],
      t0,
    );
    expect([...tools]).toEqual(["codex"]);
  });
  it("stops a tool that keeps running while the workspace is blocked", async () => {
    const l = open();
    const killed: number[] = [];
    const watcher = new Watcher(l, {
      sources,
      post: async () => ({ status: 202, data: {} }),
      state: async () => blockedState(),
      list: () =>
        procs.map((p) =>
          p.uid === 501 ? { ...p, uid: process.getuid!() } : p,
        ),
      signal: (pid) => killed.push(pid),
    });
    const t0 = Date.parse("2026-10-18T02:00:00Z");
    await watcher.tick(t0);
    expect(killed).toEqual([]);
    writeFileSync(join(codex, "r.jsonl"), fixture("codex-rollout.jsonl"));
    await watcher.tick(t0 + 5000);
    expect(killed).toEqual([103]);
    expect(JSON.parse(l.meta("lastKill")!)).toMatchObject({
      reason: "daily_budget",
      pids: [103],
    });
    // Rate limited: no second signal within 30 seconds.
    await watcher.tick(t0 + 10000);
    expect(killed).toEqual([103]);
    l.close();
  });
  it("never kills with --no-kill or on a stale block", async () => {
    writeFileSync(join(codex, "r.jsonl"), fixture("codex-rollout.jsonl"));
    const t0 = Date.parse("2026-10-18T02:00:00Z");
    for (const options of [
      { kill: false, state: async () => blockedState() },
      // API unreachable: only a cached block from 10 minutes ago.
      {
        state: async () => {
          throw new Error("offline");
        },
      },
    ]) {
      const l = open();
      writeCachedState(blockedState(), t0 - 600000);
      const killed: number[] = [];
      const watcher = new Watcher(l, {
        sources,
        post: async () => ({ status: 202, data: {} }),
        list: () => procs.map((p) => ({ ...p, uid: process.getuid!() })),
        signal: (pid) => killed.push(pid),
        ...options,
      });
      await watcher.tick(t0);
      await watcher.tick(t0 + 5000);
      expect(killed).toEqual([]);
      l.close();
    }
  });
});

describe("Codex fork accounting", () => {
  const line = (
    type: string,
    payload: unknown,
    timestamp = "2026-10-20T10:00:00Z",
  ) => JSON.stringify({ type, payload, timestamp });
  const header = (id: string, parent?: string, version = "0.140.0") =>
    line("session_meta", {
      id,
      cli_version: version,
      timestamp:
        id === "grandchild" ? "2026-10-20T12:00:00Z" : "2026-10-20T11:00:00Z",
      ...(parent ? { forked_from_id: parent } : {}),
    });
  const model = line("turn_context", { model: "gpt-6-sol" });
  const total = (input: number, timestamp = "2026-10-20T10:00:00Z") =>
    line(
      "event_msg",
      {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            output_tokens: input / 10,
            total_tokens: input * 1.1,
          },
          last_token_usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
      timestamp,
    );
  const save = (name: string, lines: string[]) =>
    writeFileSync(join(codex, name + ".jsonl"), lines.join("\n") + "\n");

  it("matches nested parent prefixes across rewritten seconds and child-first file order", () => {
    save("z-parent", [
      header("parent"),
      model,
      total(100),
      total(100),
      total(200),
    ]);
    const replay = [
      total(100, "2026-10-20T11:00:00Z"),
      total(100, "2026-10-20T11:00:01Z"),
      total(200, "2026-10-20T11:00:02Z"),
    ];
    save("b-child", [
      header("child", "parent"),
      header("parent"),
      model,
      ...replay,
      total(250, "2026-10-20T11:00:00Z"),
    ]);
    save("a-grandchild", [
      header("grandchild", "child"),
      header("child"),
      header("parent"),
      model,
      ...replay,
      total(250, "2026-10-20T11:00:00Z"),
      total(300, "2026-10-20T11:01:00Z"),
    ]);
    let ledger = open();
    scanAll(ledger, sources);
    const events = rows(ledger).map((r) => r.data);
    expect(events).toHaveLength(4);
    expect(events.reduce((sum, e) => sum + e.usage.input, 0)).toBe(300);
    expect(events.find((e) => e.sessionId === "child").usage.input).toBe(50);
    ledger.close();
    ledger = open();
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(4);
    appendFileSync(
      join(codex, "b-child.jsonl"),
      total(350, "2026-10-20T11:02:00Z") + "\n",
    );
    scanAll(ledger, sources);
    expect(rows(ledger).reduce((sum, r) => sum + r.data.usage.input, 0)).toBe(
      400,
    );
    ledger.close();
  });

  it("deduplicates replayed response ids while retaining distinct child responses", () => {
    const response = (id: string, thread: string) =>
      line("token_usage_record", {
        session_id: "root-session",
        thread_id: thread,
        response_id: id,
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    save("parent", [
      header("parent", undefined, "0.160.1"),
      model,
      response("response-parent", "parent"),
    ]);
    save("child", [
      header("child", "parent", "0.160.1"),
      header("parent"),
      model,
      response("response-parent", "parent"),
      total(100),
      response("response-child", "child"),
      total(200),
    ]);
    const ledger = open();
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(2);
    expect(rows(ledger).every((r) => r.data.sessionId === "root-session")).toBe(
      true,
    );
    expect(rows(ledger).reduce((sum, r) => sum + r.data.usage.input, 0)).toBe(
      200,
    );
    ledger.close();
  });

  it("does not merge unrelated sessions with identical totals", () => {
    save("one", [header("one"), model, total(100)]);
    save("two", [header("two"), model, total(100)]);
    const ledger = open();
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(2);
    ledger.close();
  });

  it("rebuilds pre-fix checkpoints without reporting already-accounted history", () => {
    save("upgrade", [header("upgrade"), model, total(100)]);
    const ledger = open();
    scanAll(ledger, sources);
    const path = join(codex, "upgrade.jsonl");
    const record = ledger.file(path)!;
    delete record.state.codexReplayVersion;
    ledger.db
      .prepare("UPDATE files SET data=? WHERE path=?")
      .run(JSON.stringify(record), path);
    // Simulate old, already-reported outbox history no longer retained locally.
    ledger.db.exec("DELETE FROM outbox; DELETE FROM codex_totals");
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(0);
    expect(
      ledger.db.prepare("SELECT count(*) AS n FROM codex_totals").get()!.n,
    ).toBe(1);
    appendFileSync(path, total(200) + "\n");
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(1);
    expect(rows(ledger)[0].data.usage.input).toBe(100);
    ledger.close();
  });

  it("rolls back ancestry and offsets together if a scan fails", () => {
    save("crash", [header("crash"), model, total(100)]);
    const ledger = open();
    const observe = ledger.observeCodexTotal.bind(ledger);
    ledger.observeCodexTotal = (...args) => {
      observe(...args);
      throw new Error("fixture crash");
    };
    expect(() => scanAll(ledger, sources)).toThrow("fixture crash");
    expect(ledger.file(join(codex, "crash.jsonl"))).toBeUndefined();
    expect(
      ledger.db.prepare("SELECT count(*) AS n FROM codex_totals").get()!.n,
    ).toBe(0);
    expect(rows(ledger)).toHaveLength(0);
    ledger.observeCodexTotal = observe;
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(1);
    ledger.close();
  });

  it("does not invent legacy fork usage when its parent history is unavailable", () => {
    save("orphan", [header("child", "missing"), model, total(100), total(200)]);
    const ledger = open();
    scanAll(ledger, sources);
    expect(rows(ledger)).toHaveLength(0);
    ledger.close();
  });
});
