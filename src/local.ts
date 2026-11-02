import { DatabaseSync } from "node:sqlite";
import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  statSync,
  readdirSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseLocalLine,
  mergeLocalUsage,
  localCost,
  localEventKey,
  pricingVersion,
  type LocalTool,
  type LocalParserState,
  type LocalUsageEvent,
} from "./core/index.js";
import {
  localDir,
  leashLogin,
  fetchState,
  readCachedState,
  writeCachedState,
  type WorkspaceState,
} from "./local-state.js";
import { cursorSpoolDir } from "./local-hook.js";

export type Source = { tool: LocalTool; root: string };
export function defaultSources(): Source[] {
  return [
    {
      tool: "claude-code",
      root:
        process.env.LEASH_CLAUDE_PROJECTS ??
        join(homedir(), ".claude/projects"),
    },
    {
      tool: "codex",
      root:
        process.env.LEASH_CODEX_SESSIONS ?? join(homedir(), ".codex/sessions"),
    },
    { tool: "cursor", root: cursorSpoolDir() },
  ];
}
/** Usage lines are small; anything longer is a pasted image or tool output and is skipped unread. */
export const MAX_LINE = 1024 * 1024;
const CHUNK = 1024 * 1024;
const FINGERPRINT = 128;
/** Bytes read per file per pass, so one huge rollout cannot starve the others. */
const PASS_BUDGET = 64 * 1024 * 1024;

type FileRecord = {
  path: string;
  tool: LocalTool;
  dev: number;
  ino: number;
  offset: number;
  fingerprint: string;
  fingerprintLength: number;
  state: LocalParserState & { skipping?: boolean };
};
export type OutboxEvent = LocalUsageEvent & {
  costUsd: number | null;
  pricingVersion: string;
  projectKey?: string;
};

export class LocalLedger {
  private inTransaction = false;
  db: DatabaseSync;
  constructor(dir = localDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "local.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY, data TEXT NOT NULL, ts TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, sent INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(sent, ts);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_totals(session TEXT NOT NULL, ordinal INTEGER NOT NULL, signature TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(session, ordinal));`);
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  file(path: string): FileRecord | undefined {
    const r = this.db
      .prepare("SELECT data FROM files WHERE path=?")
      .get(path) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  transaction<T>(work: () => T): T {
    if (this.inTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  /** Saves parsed events and the new offset atomically: a crash never loses or double counts. */
  commit(record: FileRecord, events: LocalUsageEvent[]) {
    this.transaction(() => {
      for (const e of events) this.add(e);
      this.db
        .prepare(
          "INSERT INTO files(path,data) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data",
        )
        .run(record.path, JSON.stringify(record));
    });
  }
  /** Keyed with a per-device secret: the server can group by project, never read its name. */
  projectKey(project: string | undefined) {
    if (!project) return undefined;
    let secret = this.meta("projectSecret");
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      this.setMeta("projectSecret", secret);
    }
    return createHmac("sha256", secret)
      .update(project)
      .digest("hex")
      .slice(0, 16);
  }
  private add(e: LocalUsageEvent & { projectKey?: string }) {
    const key = localEventKey(e);
    const row = this.db
      .prepare("SELECT data, rev FROM outbox WHERE key=?")
      .get(key) as any;
    const prior: OutboxEvent | undefined = row
      ? JSON.parse(row.data)
      : undefined;
    const usage = prior ? mergeLocalUsage(prior.usage, e.usage) : e.usage;
    const toolRepeat = Math.max(prior?.toolRepeat ?? 0, e.toolRepeat);
    const projectKey = prior?.projectKey ?? e.projectKey;
    if (
      prior &&
      JSON.stringify(usage) === JSON.stringify(prior.usage) &&
      toolRepeat === prior.toolRepeat &&
      projectKey === prior.projectKey
    )
      return;
    const model = prior?.model ?? e.model;
    const next: OutboxEvent = {
      ...(prior ?? e),
      usage,
      toolRepeat,
      ...(projectKey ? { projectKey } : {}),
      costUsd: localCost(model, usage),
      pricingVersion,
    };
    this.db
      .prepare(
        "INSERT INTO outbox(key,data,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, rev=outbox.rev+1, sent=0",
      )
      .run(key, JSON.stringify(next), next.ts);
  }
  /** Preserve raw parent streams, including their inherited prefixes, for nested forks. */
  observeCodexTotal(state: LocalParserState, signature: string, ts: string) {
    const session = state.forkSessionId ?? state.sessionId;
    if (!session) return false;
    const ordinal = state.codexOrdinal ?? 0;
    this.db
      .prepare(
        "INSERT INTO codex_totals(session,ordinal,signature,ts) VALUES(?,?,?,?) ON CONFLICT(session,ordinal) DO UPDATE SET signature=excluded.signature,ts=excluded.ts",
      )
      .run(session, ordinal, signature, ts ?? "");
    if (!state.forkParentId || state.replayDone) return false;
    const parent = this.db
      .prepare(
        "SELECT signature, ts FROM codex_totals WHERE session=? AND ordinal=?",
      )
      .get(state.forkParentId, ordinal) as
      { signature: string; ts: string } | undefined;
    if (!parent) {
      const known = this.db
        .prepare("SELECT 1 FROM codex_totals WHERE session=? LIMIT 1")
        .get(state.forkParentId);
      // Without a parent stream, cumulative fork estimates cannot be distinguished
      // from replay. Keep them uncounted; per-response records remain authoritative.
      if (!known) return true;
    }
    if (
      parent?.signature === signature &&
      (!state.forkTimestamp ||
        Date.parse(parent.ts) <= Date.parse(state.forkTimestamp))
    )
      return true;
    state.replayDone = true;
    return false;
  }
  pending(limit = 500) {
    return (
      this.db
        .prepare(
          "SELECT key, data, rev FROM outbox WHERE sent=0 ORDER BY ts LIMIT ?",
        )
        .all(limit) as any[]
    ).map((r) => ({
      key: r.key as string,
      rev: r.rev as number,
      event: JSON.parse(r.data) as OutboxEvent,
    }));
  }
  /** Only marks rows unchanged since they were read; a grown event is sent again. */
  markSent(rows: { key: string; rev: number }[], sent = 1) {
    this.transaction(() => {
      const s = this.db.prepare(
        "UPDATE outbox SET sent=? WHERE key=? AND rev=?",
      );
      for (const r of rows) s.run(sent, r.key, r.rev);
    });
  }
  totals(sinceIso: string) {
    const rows = this.db
      .prepare("SELECT data, sent FROM outbox WHERE ts >= ?")
      .all(sinceIso) as any[];
    const tools: Record<
      string,
      { events: number; costUsd: number; unpriced: number }
    > = {};
    let pending = 0,
      rejected = 0;
    for (const r of rows) {
      const e: OutboxEvent = JSON.parse(r.data);
      const t = (tools[e.tool] ??= { events: 0, costUsd: 0, unpriced: 0 });
      t.events++;
      if (e.costUsd === null) t.unpriced++;
      else t.costUsd += e.costUsd;
      if (r.sent === 0) pending++;
      if (r.sent === -1) rejected++;
    }
    return { tools, pending, rejected };
  }
  close() {
    this.db.close();
  }
}

function walk(root: string, depth = 0): string[] {
  if (depth > 6) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
      e.isSymbolicLink()
        ? []
        : e.isDirectory()
          ? walk(join(root, e.name), depth + 1)
          : e.name.endsWith(".jsonl")
            ? [join(root, e.name)]
            : [],
    );
  } catch {
    return [];
  }
}
function fingerprintOf(fd: number, length: number) {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, 0);
  return createHash("sha256").update(buf.subarray(0, read)).digest("hex");
}

/**
 * Reads complete new lines from one file and commits events with the new offset.
 * Rotation (new inode or different first bytes) and truncation restart the file
 * at offset 0; stable event ids make the re-read harmless.
 */
export function scanFile(
  ledger: LocalLedger,
  tool: LocalTool,
  path: string,
  since: number,
  budget = PASS_BUDGET,
  project?: string,
) {
  // Commit ancestry, emitted usage and offsets together; avoid a disk sync per token line.
  return ledger.transaction(() => {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return { events: 0, reset: false };
    }
    try {
      const st = fstatSync(fd);
      let record = ledger.file(path);
      let reset = false;
      const replayBackfillThrough =
        tool === "codex" && record?.state.codexReplayVersion !== 1
          ? record?.offset
          : undefined;
      // Rebuild metadata-only ancestry for pre-fix checkpoints; stable event keys
      // keep an upgrade re-scan idempotent without deleting accounting history.
      if (tool === "codex" && record && record.state.codexReplayVersion !== 1) {
        record = undefined;
        reset = true;
      }
      if (record) {
        const prefix = Math.min(record.fingerprintLength, st.size);
        const sameStart =
          prefix === record.fingerprintLength &&
          fingerprintOf(fd, prefix) === record.fingerprint;
        if (
          record.dev !== st.dev ||
          record.ino !== st.ino ||
          !sameStart ||
          st.size < record.offset
        ) {
          record = undefined;
          reset = true;
        }
      }
      if (!record) {
        record = {
          path,
          tool,
          dev: st.dev,
          ino: st.ino,
          offset: 0,
          fingerprint: "",
          fingerprintLength: 0,
          state:
            tool === "codex"
              ? { codexReplayVersion: 1, replayBackfillThrough }
              : {},
        };
        // The rollout header decides how Codex usage is read; see local-usage.ts.
        if (tool === "codex" && hasUsageRecords(fd, st.size))
          record.state.mode = "records";
      }
      if (
        record.fingerprintLength < FINGERPRINT &&
        st.size > record.fingerprintLength
      ) {
        record.fingerprintLength = Math.min(FINGERPRINT, st.size);
        record.fingerprint = fingerprintOf(fd, record.fingerprintLength);
      }
      let count = 0;
      let position = record.offset;
      let pending: Buffer[] = [];
      let pendingLength = 0;
      const chunk = Buffer.alloc(CHUNK);
      const events: (LocalUsageEvent & { projectKey?: string })[] = [];
      const limit = Math.min(st.size, record.offset + budget);
      while (position < limit) {
        const read = readSync(
          fd,
          chunk,
          0,
          Math.min(CHUNK, limit - position),
          position,
        );
        if (read <= 0) break;
        let start = 0;
        for (let i = 0; i < read; i++) {
          if (chunk[i] !== 0x0a) continue;
          const piece = chunk.subarray(start, i);
          if (record.state.skipping) {
            record.state.skipping = false;
          } else if (pendingLength + piece.length <= MAX_LINE) {
            const line = Buffer.concat([...pending, piece]).toString("utf8");
            const e = parseLocalLine(
              tool,
              line,
              record.state,
              (state, signature, ts) =>
                ledger.observeCodexTotal(state, signature, ts),
            );
            if (
              e &&
              position + i + 1 > (record.state.replayBackfillThrough ?? 0) &&
              (!e.ts || Date.parse(e.ts) >= since)
            )
              events.push({
                ...e,
                projectKey: ledger.projectKey(project ?? record.state.cwd),
              });
          }
          pending = [];
          pendingLength = 0;
          start = i + 1;
          record.offset = position + i + 1;
        }
        const rest = chunk.subarray(start, read);
        if (!record.state.skipping) {
          if (pendingLength + rest.length > MAX_LINE) {
            // Oversized line: skip to its end without buffering it.
            record.state.skipping = true;
            pending = [];
            pendingLength = 0;
          } else if (rest.length) {
            pending.push(Buffer.from(rest));
            pendingLength += rest.length;
          }
        }
        if (record.state.skipping) record.offset = position + read;
        position += read;
        if (events.length >= 1000) {
          ledger.commit(record, events.splice(0));
          count += 1000;
        }
      }
      count += events.length;
      ledger.commit(record, events);
      return { events: count, reset };
    } finally {
      closeSync(fd);
    }
  });
}

function hasUsageRecords(fd: number, size: number) {
  const buf = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
  const read = readSync(fd, buf, 0, buf.length, 0);
  return buf.subarray(0, read).includes('"type":"token_usage_record"');
}
/** Parent files are scanned first even when directory order puts a child first. */
function codexScanOrder(paths: string[]) {
  const headers = new Map<string, { path: string; parent?: string }>();
  for (const path of paths) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(MAX_LINE);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, length).indexOf(0x0a);
      if (end < 0) continue;
      const r = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      if (r.type !== "session_meta" || typeof r.payload?.id !== "string")
        continue;
      const p = r.payload;
      headers.set(p.id, {
        path,
        parent:
          p.forked_from_id ??
          p.parent_thread_id ??
          p.source?.subagent?.thread_spawn?.parent_thread_id,
      });
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const visited = new Set<string>();
  const ordered: { path: string; parentPath?: string }[] = [];
  function visit(path: string, parent?: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const ancestor = parent ? headers.get(parent) : undefined;
    if (ancestor) visit(ancestor.path, ancestor.parent);
    ordered.push({ path, parentPath: ancestor?.path });
  }
  for (const h of headers.values()) visit(h.path, h.parent);
  for (const path of paths) visit(path);
  return ordered;
}
export function scanAll(ledger: LocalLedger, sources = defaultSources()) {
  const since = Date.parse(ledger.meta("since") ?? "1970-01-01T00:00:00Z");
  let events = 0;
  for (const s of sources) {
    const files = walk(s.root);
    const ordered =
      s.tool === "codex"
        ? codexScanOrder(files)
        : files.map((path) => ({ path, parentPath: undefined }));
    for (const { path, parentPath } of ordered) {
      // A large ancestor may need several bounded passes. Do not mistake its
      // unfinished prefix for the end of its history when parsing a child.
      if (parentPath) {
        const parent = ledger.file(parentPath);
        try {
          if (!parent || parent.offset < statSync(parentPath).size) continue;
        } catch {
          continue;
        }
      }
      events += scanFile(
        ledger,
        s.tool,
        path,
        since,
        PASS_BUDGET,
        s.tool === "claude-code"
          ? relative(s.root, path).split(sep)[0]
          : undefined,
      ).events;
    }
  }
  return events;
}

type Post = (body: unknown) => Promise<{ status: number; data: any }>;
async function postUsage(body: unknown) {
  const login = leashLogin();
  if (!login)
    return { status: 0, data: { error: "Not signed in. Run leash login." } };
  const r = await fetch(`${login.apiURL}/v1/local/usage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${login.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const wire = (e: OutboxEvent) => ({
  tool: e.tool,
  surface: e.surface,
  sessionId: e.sessionId,
  eventId: e.eventId,
  model: e.model,
  usage: e.usage,
  ts: e.ts,
  pricingVersion: e.pricingVersion,
  toolRepeat: e.toolRepeat ?? 0,
  ...(e.projectKey ? { projectKey: e.projectKey } : {}),
});
/** Sends pending events in batches of 500. Rejected single events are parked, not retried forever. */
export async function report(ledger: LocalLedger, post: Post = postUsage) {
  let sent = 0;
  for (;;) {
    const rows = ledger.pending(500).filter((r) => r.event.ts);
    if (!rows.length) break;
    const r = await post({ events: rows.map((x) => wire(x.event)) });
    ledger.setMeta("lastReportAt", new Date().toISOString());
    if (r.status === 202) {
      ledger.markSent(rows);
      sent += rows.length;
      ledger.setMeta("lastReportError", "");
      if (r.data?.state) writeCachedState(r.data.state);
      continue;
    }
    if (r.status === 400) {
      for (const row of rows) {
        const one = await post({ events: [wire(row.event)] });
        if (one.status === 202) sent++;
        if (one.status === 202 || one.status === 400)
          ledger.markSent([row], one.status === 202 ? 1 : -1);
        else break;
      }
      continue;
    }
    ledger.setMeta(
      "lastReportError",
      String(r.data?.error ?? `HTTP ${r.status}`).slice(0, 200),
    );
    break;
  }
  return sent;
}

export type AgentProcess = { pid: number; uid: number; exe: string };
export function listAgentProcesses(): AgentProcess[] {
  const out = execFileSync("ps", ["-axo", "pid=,uid=,comm="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), uid: Number(m[2]), exe: m[3].trim() }));
}
/** Agent CLIs only. GUI apps (Claude.app, ChatGPT.app, the Cursor editor) are never matched. */
export function toolOfProcess(exe: string): LocalTool | undefined {
  const name = basename(exe);
  if (name === "claude") return "claude-code";
  if (name === "codex") return "codex";
  if (name === "cursor-agent") return "cursor";
  return undefined;
}
export function killFallbackTargets(
  processes: AgentProcess[],
  tools: Set<LocalTool>,
  uid = process.getuid?.() ?? -1,
) {
  return processes.filter(
    (p) =>
      p.uid === uid &&
      p.pid !== process.pid &&
      p.pid !== process.ppid &&
      tools.has(toolOfProcess(p.exe)!),
  );
}
/** Tools that kept calling the model after the block was observed (the hook did not stop them). */
export function toolsStillRunning(
  events: Pick<LocalUsageEvent, "tool" | "ts">[],
  blockedSince: number,
  graceMs = 60000,
) {
  return new Set(
    events
      .filter((e) => Date.parse(e.ts) > blockedSince + graceMs)
      .map((e) => e.tool),
  );
}

export class Watcher {
  blockedSince: number | null = null;
  lastKill = 0;
  constructor(
    public ledger: LocalLedger,
    public options: {
      sources?: Source[];
      kill?: boolean;
      post?: Post;
      state?: () => Promise<WorkspaceState | undefined>;
      list?: () => AgentProcess[];
      signal?: (pid: number) => void;
      log?: (message: string) => void;
    } = {},
  ) {}
  async tick(now = Date.now()) {
    scanAll(this.ledger, this.options.sources);
    await report(this.ledger, this.options.post).catch((e) =>
      this.ledger.setMeta(
        "lastReportError",
        String(e?.message ?? e).slice(0, 200),
      ),
    );
    const cached = readCachedState();
    let state = cached?.state;
    let fresh = !!cached && now - cached.fetchedAt < 60000;
    try {
      const latest = await (this.options.state ?? fetchState)();
      if (latest) {
        writeCachedState(latest, now);
        state = latest;
        fresh = true;
      }
    } catch {}
    if (!state?.blocked) {
      this.blockedSince = null;
      return;
    }
    this.blockedSince ??= now;
    // Never kill on a stale block: the workspace may have been resumed meanwhile.
    if (!fresh || this.options.kill === false || now - this.lastKill < 30000)
      return;
    // Events written since the block, judged by their own timestamps.
    const recent = (
      this.ledger.db
        .prepare("SELECT data FROM outbox WHERE ts > ?")
        .all(new Date(this.blockedSince).toISOString()) as any[]
    ).map((r) => JSON.parse(r.data) as OutboxEvent);
    const tools = toolsStillRunning(recent, this.blockedSince);
    if (!tools.size) return;
    const targets = killFallbackTargets(
      (this.options.list ?? listAgentProcesses)(),
      tools,
    );
    for (const p of targets) {
      try {
        (this.options.signal ?? ((pid) => process.kill(pid, "SIGTERM")))(p.pid);
        this.options.log?.(
          `Stopped ${toolOfProcess(p.exe)} process ${p.pid}: ${state.reason}`,
        );
      } catch {}
    }
    if (targets.length) {
      this.lastKill = now;
      this.ledger.setMeta(
        "lastKill",
        JSON.stringify({
          at: new Date(now).toISOString(),
          reason: state.reason,
          pids: targets.map((p) => p.pid),
        }),
      );
    }
  }
}

const pidPath = () => join(localDir(), "watcher.pid");
function running(): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}
export function startLocal(options: { since?: string; kill?: boolean }) {
  const ledger = new LocalLedger();
  try {
    if (options.since !== undefined) {
      const since = Date.parse(options.since);
      if (Number.isNaN(since)) throw new Error("Invalid --since date");
      // Backfill: re-read every file from the start; event ids keep it idempotent.
      ledger.transaction(() => {
        ledger.db.exec("DELETE FROM files");
        ledger.setMeta("since", new Date(since).toISOString());
      });
    } else if (!ledger.meta("since"))
      ledger.setMeta("since", new Date().toISOString());
    ledger.setMeta("kill", options.kill === false ? "off" : "on");
  } finally {
    ledger.close();
  }
  const existing = running();
  if (existing) return { pid: existing, started: false };
  const log = openSync(join(localDir(), "watcher.log"), "a", 0o600);
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "local", "run"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  writeFileSync(pidPath(), String(child.pid), { mode: 0o600 });
  return { pid: child.pid!, started: true };
}
export function stopLocal() {
  const pid = running();
  if (pid) process.kill(pid, "SIGTERM");
  if (existsSync(pidPath())) unlinkSync(pidPath());
  return { stopped: !!pid, pid };
}
export async function runLocal(intervalMs = 2000) {
  const ledger = new LocalLedger();
  const watcher = new Watcher(ledger, {
    kill: ledger.meta("kill") !== "off",
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  });
  let stopping = false;
  for (const s of ["SIGTERM", "SIGINT"] as const)
    process.on(s, () => {
      stopping = true;
    });
  console.log(
    `${new Date().toISOString()} Leash local watcher started (${pricingVersion})`,
  );
  while (!stopping) {
    try {
      await watcher.tick();
    } catch (e: any) {
      console.error(`${new Date().toISOString()} ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  ledger.close();
}
export function localStatus() {
  const ledger = new LocalLedger();
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const cached = readCachedState();
    return {
      label: "subscription (estimated)",
      running: running() ?? null,
      signedIn: !!leashLogin(),
      since: ledger.meta("since") ?? null,
      pricingVersion,
      today: ledger.totals(day),
      month: ledger.totals(`${month}-01`),
      files: (ledger.db.prepare("SELECT COUNT(*) AS n FROM files").get() as any)
        .n,
      lastReportAt: ledger.meta("lastReportAt") || null,
      lastReportError: ledger.meta("lastReportError") || null,
      lastKill: ledger.meta("lastKill")
        ? JSON.parse(ledger.meta("lastKill")!)
        : null,
      workspace: cached
        ? {
            ...cached.state,
            fetchedAt: new Date(cached.fetchedAt).toISOString(),
          }
        : null,
    };
  } finally {
    ledger.close();
  }
}
