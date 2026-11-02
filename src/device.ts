import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { config } from "./config.js";
import { credentials, validateURL } from "./auth.js";
import { Store, type Session, type Event, type Kill } from "./state.js";
type DeviceCredentials = {
  token: string;
  apiURL: string;
  deviceId: string;
  orgId: string;
  name: string;
  sharedEnforcement?: boolean;
};
const path = () => join(config().dir, "device.json");
export function deviceCredentials(): DeviceCredentials | undefined {
  if (!existsSync(path())) return;
  const c = JSON.parse(readFileSync(path(), "utf8"));
  if (!c.token?.startsWith("lsd_") || !c.deviceId || !c.orgId)
    throw new Error(
      "Invalid device credentials. Restore device.json or enroll with a fresh LEASH_HOME.",
    );
  return { ...c, apiURL: validateURL(c.apiURL) };
}
export async function deviceRequest(
  c: { token: string; apiURL: string },
  route: string,
  body?: unknown,
) {
  const r = await fetch(`${validateURL(c.apiURL)}/v1/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${c.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const data = (await r.json()) as any;
  if (!r.ok)
    throw Object.assign(new Error(data.error ?? "Device transport failed"), {
      status: r.status,
    });
  return data;
}
function saveDevice(c: DeviceCredentials) {
  const cfg = config(),
    store = new Store(cfg.dir);
  if (cfg.gateway) {
    store.db.close();
    throw new Error(
      "Use a fresh LEASH_HOME for device enrollment; this ledger uses hosted gateway mode.",
    );
  }
  try {
    if (deviceCredentials())
      throw new Error(
        "Already enrolled. Revoke this device in Settings and use a fresh LEASH_HOME to enroll another.",
      );
    if (store.all("session").length || store.all("report").length)
      throw new Error(
        "Enroll before creating sessions/reports. Use a fresh LEASH_HOME for device transport; existing ledgers are not reassigned.",
      );
    store.put("setting", "workspace", { orgId: c.orgId });
    store.put("setting", "shared-enforcement", {
      enabled: c.sharedEnforcement === true,
    });
    writeFileSync(
      join(cfg.dir, "workspace.json"),
      JSON.stringify({ orgId: c.orgId }),
      { mode: 0o600 },
    );
    const temporary = path() + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(c), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path());
  } finally {
    store.db.close();
  }
}
export async function registerDevice(options: {
  name?: string;
  label?: string;
  json?: boolean;
}) {
  const c = credentials();
  if (!c)
    throw new Error("Run leash login first, using your workspace account.");
  const store = new Store(config().dir);
  try {
    if (
      deviceCredentials() ||
      store.all("session").length ||
      store.all("report").length
    )
      throw new Error(
        "Device enrollment requires a fresh ledger. Use a fresh LEASH_HOME, then leash login.",
      );
  } finally {
    store.db.close();
  }
  const d = await deviceRequest(c, "devices", {
    name: options.name ?? hostname(),
    label: options.label,
    platform: process.platform,
  });
  try {
    saveDevice({
      token: d.token,
      apiURL: c.apiURL,
      deviceId: d.device.id,
      orgId: d.device.orgId,
      name: d.device.name,
      sharedEnforcement: d.sharedEnforcement === true,
    });
  } catch (e) {
    await deviceRequest(c, `devices/${d.device.id}/revoke`, {}).catch(() => {});
    throw e;
  }
  console.log(
    options.json
      ? JSON.stringify({ ...d.device, credentialStored: true })
      : `Registered ${d.device.name} (${d.device.id}).\nPrivate credential: ${path()}\nStart leash start to sync and receive commands. No DATABASE_URL is required.`,
  );
}
export async function connectDevice(options: {
  api: string;
  tokenFile: string;
}) {
  const token = readFileSync(options.tokenFile, "utf8").trim(),
    apiURL = validateURL(options.api);
  const { device, sharedEnforcement } = await deviceRequest(
    { token, apiURL },
    "devices/me",
  );
  saveDevice({
    token,
    apiURL,
    deviceId: device.id,
    orgId: device.orgId,
    name: device.name,
    sharedEnforcement: sharedEnforcement === true,
  });
  console.log(
    `Connected ${device.name}. Credential saved mode 0600; run leash start.`,
  );
}
export async function listDevices() {
  const c = credentials();
  if (!c) throw new Error("Run leash login first.");
  console.log(JSON.stringify(await deviceRequest(c, "devices"), null, 2));
}
export async function revokeDevice(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid device ID");
  const c = credentials();
  if (!c) throw new Error("Run leash login first.");
  console.log(
    JSON.stringify(await deviceRequest(c, `devices/${id}/revoke`, {})),
  );
}
const dirty = <T>(store: Store, kind: string, limit: number): T[] =>
  (
    store.db
      .prepare(
        "SELECT data,revision FROM docs WHERE kind=? AND synced=0 ORDER BY rowid LIMIT ?",
      )
      .all(kind, limit) as any[]
  ).map((r) => ({
    ...JSON.parse(r.data),
    ...(kind === "session" ? { deviceRevision: r.revision } : {}),
  }));
export async function syncDevice(store: Store) {
  const c = deviceCredentials();
  if (!c) throw new Error("No device credentials. Run leash device register.");
  if (store.get<{ orgId: string }>("setting", "workspace")?.orgId !== c.orgId)
    throw new Error(
      "Device and local ledger workspace differ; refusing metadata upload.",
    );
  const destination = "device:" + c.deviceId;
  if (
    store.get<{ hash: string }>("setting", "sync-destination")?.hash !==
    destination
  ) {
    store.db
      .prepare(
        "UPDATE docs SET synced=0 WHERE kind IN ('session','event','kill','report')",
      )
      .run();
    store.put("setting", "sync-destination", { hash: destination });
  }
  let accepted = 0;
  // Bounded batches; drain a backlog without an unbounded request or monopolizing the poll loop.
  for (let n = 0; n < 10; n++) {
    const batch = store.transaction(() => {
      const events = dirty<Event>(store, "event", 100),
        kills = dirty<Kill>(store, "kill", 50),
        reports = dirty<any>(store, "report", 5);
      const sessionMap = new Map(
        dirty<Session>(store, "session", 50).map((s) => [s.id, s]),
      );
      for (const e of [...events, ...kills]) {
        const row = store.db
          .prepare(
            "SELECT data,revision FROM docs WHERE kind='session' AND id=?",
          )
          .get(e.sessionId) as any;
        if (!row) throw new Error("Orphan local metadata");
        const s = {
          ...JSON.parse(row.data),
          deviceRevision: row.revision,
        } as Session;
        sessionMap.set(s.id, s);
      }
      const sessions = [...sessionMap.values()];
      const reserved = (
        store.db
          .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM reservations")
          .get() as any
      ).total;
      const clock = store.db
        .prepare(
          "INSERT INTO docs(kind,id,data,revision) VALUES('setting','device-sync-clock','{}',1) ON CONFLICT(kind,id) DO UPDATE SET revision=docs.revision+1 RETURNING revision",
        )
        .get() as any;
      return {
        sessions,
        events,
        kills,
        reports,
        syncSequence: clock.revision,
        telemetry: { panic: !!store.get("setting", "panic"), reserved },
      };
    });
    const { sessions, events, kills, reports } = batch;
    const result = await deviceRequest(c, "devices/me/sync", batch);
    accepted += result.accepted;
    // A concurrent stream may update a session while upload is in flight. Never mark a newer revision clean.
    let partial = false;
    for (const [kind, rows] of [
      ["session", sessions],
      ["event", events],
      ["kill", kills],
      ["report", reports],
    ] as const)
      for (const row of rows) {
        const acknowledged = result[`${kind}Ids`];
        if (!Array.isArray(acknowledged) || !acknowledged.includes(row.id)) {
          partial = true;
          continue;
        }
        if (kind === "session")
          store.db
            .prepare(
              "UPDATE docs SET synced=1 WHERE kind=? AND id=? AND revision=?",
            )
            .run(kind, row.id, (row as Session).deviceRevision!);
        else
          store.db
            .prepare(
              "UPDATE docs SET synced=1 WHERE kind=? AND id=? AND data=?",
            )
            .run(kind, row.id, JSON.stringify(row));
      }
    if (partial) break; // Let settlement/recovery run before retrying the same pending batch.
    if (!sessions.length && !events.length && !kills.length && !reports.length)
      break;
  }
  return { accepted, transport: "device" };
}
export function commandOperation(command: {
  id: string;
  type: string;
  payload: any;
}) {
  const b = command.payload,
    operationId = /^[a-f0-9]{64}$/.test(b.operationId ?? "")
      ? b.operationId
      : createHash("sha256").update(command.id).digest("hex");
  const session = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/i.test(value))
      throw new Error("Invalid command session");
    return value;
  };
  if (command.type === "noop") return null;
  if (command.type === "panic" && typeof b.active === "boolean")
    return { path: b.active ? "kill-all" : "resume-all", body: {} };
  if (command.type === "kill")
    return { path: `sessions/${session(b.sessionId)}/kill`, body: {} };
  if (
    command.type === "resume" &&
    Number.isFinite(b.addUsd ?? 0) &&
    (b.addUsd ?? 0) >= 0
  )
    return {
      path: `sessions/${session(b.sessionId)}/resume`,
      body: { addUsd: b.addUsd ?? 0, operationId },
    };
  if (command.type === "set_budget") {
    if (b.scopeType === "policy" && b.policy && typeof b.policy === "object")
      return { path: "policy", body: b.policy };
    if (
      !Number.isFinite(b.limitUsd) ||
      b.limitUsd <= 0 ||
      !["block", "alert"].includes(b.action)
    )
      throw new Error("Invalid budget command");
    if (b.scopeType === "session")
      return {
        path: `sessions/${session(b.scopeId)}/cap`,
        body: { cap: b.limitUsd, action: b.action },
      };
    if (b.scopeType === "repo") return { path: "repo-budget", body: b };
    if (b.scopeType === "org" && ["day", "month"].includes(b.period))
      return {
        path: "policy",
        body: {
          [b.period === "day" ? "dailyCap" : "monthlyCap"]: b.limitUsd,
          [b.period === "day" ? "dailyAction" : "monthlyAction"]: b.action,
        },
      };
  }
  throw new Error("Unsupported device command");
}
export async function deviceCycle(
  store: Store,
  execute: (path: string, body: unknown) => Promise<unknown>,
) {
  const c = deviceCredentials();
  if (!c) return;
  // Poll before bulk upload so a large backlog cannot delay a panic indefinitely.
  const { commands, sharedEnforcement } = await deviceRequest(
    c,
    "devices/me/commands?wait=0",
  );
  store.put("setting", "shared-enforcement", {
    enabled: sharedEnforcement === true,
  });
  let unsafeInitialFailure = false;
  for (const cmd of commands) {
    const marker = `${c.deviceId}:${cmd.id}`;
    if (!store.get("device-command", marker)) {
      try {
        await execute("device-command", cmd);
      } catch (error) {
        // A vanished local session or rejected policy must not block a later panic.
        // Network failures retry; explicit local rejections expire visibly on the server.
        if (!(
          error &&
          typeof error === "object" &&
          "status" in error &&
          [400, 404, 409].includes(Number(error.status))
        ))
          throw error;
        await deviceRequest(c, `devices/me/commands/${cmd.id}/ack`, {
          outcome: "failed",
        });
        console.error(
          "Leash: device command rejected locally; recorded as failed in workspace Settings.",
        );
        if (cmd.type === "set_budget" || cmd.type === "panic") {
          unsafeInitialFailure = true;
          if (!store.get("setting", "device-ready"))
            store.put("setting", "device-bootstrap-error", {
              commandId: cmd.id,
            });
        }
        continue;
      }
      store.put("device-command", marker, {
        appliedAt: new Date().toISOString(),
      });
      if (cmd.type === "set_budget" || cmd.type === "panic")
        store.db
          .prepare(
            "DELETE FROM docs WHERE kind='setting' AND id='device-bootstrap-error'",
          )
          .run();
    }
    await syncDevice(store);
    await deviceRequest(c, `devices/me/commands/${cmd.id}/ack`, {});
  }
  await syncDevice(store);
  await flushSharedSettlements(store);
  if (!unsafeInitialFailure && !store.get("setting", "device-bootstrap-error"))
    store.put("setting", "device-ready", { ready: true });
}

export async function flushSharedSettlements(store: Store) {
  const c = deviceCredentials();
  if (!c) return;
  for (const pending of store
    .all<{ id: string; usage: any; status: number; complete: boolean }>(
      "shared-settlement",
    )
    .slice(0, 100)) {
    await deviceRequest(
      c,
      `devices/me/reservations/${pending.id}/settle`,
      pending,
    );
    store.db
      .prepare("DELETE FROM docs WHERE kind=? AND id=?")
      .run("shared-settlement", pending.id);
  }
}
