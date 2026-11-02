import {
  LOCAL_CREDENTIAL_MARKER,
  localCredentialMetadata,
} from "./local-secrets.js";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import TOML from "@iarna/toml";
import { config } from "./config.js";
import { Store, type Session } from "./state.js";
import { nodeCommand } from "./node-path.js";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function location(agent: string, root: string) {
  if (!["claude-code", "codex"].includes(agent))
    throw new Error("Choose claude-code or codex");
  return agent === "claude-code"
    ? join(root, ".claude", "settings.json")
    : join(root, ".codex", "config.toml");
}
function atomic(path: string, text: string) {
  const temp = path + ".leash-" + randomUUID();
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}
export function claudeHooks() {
  const command = `${nodeCommand()} ${quote(resolve(process.argv[1]))} hook`;
  return Object.fromEntries(
    Object.entries({
      PreToolUse: "pre-tool-use",
      SubagentStop: "subagent-stop",
      SessionEnd: "session-end",
      PostToolUseFailure: "tool-failed",
    }).map(([event, sub]) => [
      event,
      [
        {
          ...(event === "PreToolUse" ? { matcher: "*" } : {}),
          hooks: [
            { type: "command", command: `${command} ${sub}`, timeout: 10 },
          ],
        },
      ],
    ]),
  );
}
export function install(agent: string, root = homedir()) {
  const path = location(agent, root),
    cfg = config(),
    store = new Store(cfg.dir);
  try {
    const key = `${agent}:${resolve(root)}`;
    const previous = store.get<{ id: string; originalBackup: string | null }>(
      "install",
      key,
    );
    const legacy = store.get<{ id: string }>("install", agent);
    const session = store.get<Session>(
      "session",
      previous?.id ?? legacy?.id ?? "",
    );
    mkdirSync(dirname(path), { recursive: true });
    const old = existsSync(path) ? readFileSync(path, "utf8") : "";
    // Parse before backup or mutation, so malformed user configuration remains untouched.
    const data: any = old
      ? agent === "claude-code"
        ? JSON.parse(old)
        : TOML.parse(old)
      : {};
    const sid =
      session?.id ??
      store.create(
        agent,
        store.get<{ sessionCap?: number }>("setting", "policy")?.sessionCap ??
          cfg.policy.sessionCap,
      ).id;
    if (session?.status === "ended") store.resume(session.id);
    const backup = existsSync(path)
      ? path + `.leash-backup-${Date.now()}-${randomUUID().slice(0, 8)}`
      : null;
    if (backup) {
      copyFileSync(path, backup);
      chmodSync(backup, 0o600);
    }
    const localProvider =
      !cfg.gateway &&
      localCredentialMetadata(cfg.dir).some(
        (entry) =>
          entry.provider === (agent === "codex" ? "openai" : "anthropic"),
      );
    let text: string;
    if (agent === "claude-code") {
      data.env = {
        ...data.env,
        CLAUDE_CODE_MAX_RETRIES: "0",
        CLAUDE_CODE_RETRY_WATCHDOG: "0",
        ...(cfg.gateway?.storedCredential &&
        cfg.gateway.provider === "anthropic"
          ? { ANTHROPIC_API_KEY: "leash-managed" }
          : {}),
        ...(localProvider
          ? { ANTHROPIC_API_KEY: LOCAL_CREDENTIAL_MARKER }
          : {}),
        LEASH_SESSION_ID: sid,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port}/s/${sid}/anthropic`,
        ANTHROPIC_CUSTOM_HEADERS: [
          ...(data.env?.ANTHROPIC_CUSTOM_HEADERS ?? "")
            .split("\n")
            .filter((v: string) => v && !/^x-leash-local-token:/i.test(v)),
          `x-leash-local-token: ${cfg.token}`,
        ].join("\n"),
      };
      if (localProvider) delete data.env.ANTHROPIC_AUTH_TOKEN;
      data.hooks ??= {};
      for (const [event, handlers] of Object.entries(claudeHooks())) {
        const existing = (data.hooks[event] ?? [])
          .map((entry: any) => ({
            ...entry,
            hooks: (entry.hooks ?? []).filter(
              (h: any) =>
                !(
                  typeof h.command === "string" &&
                  h.command.includes(quote(resolve(process.argv[1]))) &&
                  h.command.includes(" hook ")
                ),
            ),
          }))
          .filter((entry: any) => entry.hooks.length);
        data.hooks[event] = [...existing, ...handlers];
      }
      text = JSON.stringify(data, null, 2) + "\n";
    } else {
      // Select Leash and disable unpriced built-in search; preserve other tables/comments.
      let inLeash = false,
        inRoot = true;
      const lines: string[] = [];
      for (const line of old.split("\n")) {
        if (/^\s*\[/.test(line)) {
          inRoot = false;
          inLeash = /^\s*\[model_providers\.(?:leash|"leash")(?:\.|\])/.test(
            line,
          );
        }
        if (inLeash) continue;
        if (
          inRoot &&
          /^\s*["']?(?:model_provider|web_search)["']?\s*=/.test(line)
        )
          continue;
        lines.push(line);
      }
      text = `model_provider = "leash"\nweb_search = "disabled"\n${lines.join("\n").trim()}\n\n[model_providers.leash]\nname = "Leash local proxy"\nbase_url = "http://127.0.0.1:${cfg.port}/s/${sid}/openai/v1"${cfg.gateway?.storedCredential || localProvider ? "" : '\nenv_key = "OPENAI_API_KEY"'}\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nhttp_headers = { "x-leash-local-token" = "${cfg.token}"${localProvider ? `, "Authorization" = "Bearer ${LOCAL_CREDENTIAL_MARKER}"` : ""} }\n`;
      TOML.parse(text);
    }
    atomic(path, text);
    store.put("install", key, {
      id: sid,
      path,
      originalBackup: previous ? previous.originalBackup : backup,
    });
    return {
      path,
      backup,
      sessionId: sid,
      message:
        "Installed with a persistent cumulative cap. Run leash start; use leash run for a fresh session. Restore with leash uninstall " +
        agent +
        (agent === "codex"
          ? ". Built-in web search is disabled because its fees are not metered."
          : ""),
    };
  } finally {
    store.db.close();
  }
}
export function uninstall(agent: string, root = homedir()) {
  const path = location(agent, root),
    store = new Store(config().dir),
    key = `${agent}:${resolve(root)}`;
  try {
    const record = store.get<{ id: string; originalBackup: string | null }>(
      "install",
      key,
    );
    if (!record)
      throw new Error(
        "No installation record for this agent/root. Restore the printed backup manually.",
      );
    const backup = existsSync(path)
      ? path + `.before-leash-restore-${Date.now()}`
      : null;
    if (backup) {
      copyFileSync(path, backup);
      chmodSync(backup, 0o600);
    }
    if (record.originalBackup)
      atomic(path, readFileSync(record.originalBackup, "utf8"));
    else if (existsSync(path)) unlinkSync(path);
    const session = store.get<Session>("session", record.id);
    if (session && session.status !== "killed") {
      session.status = "ended";
      session.endedAt = new Date().toISOString();
      store.put("session", session.id, session);
    }
    store.db
      .prepare("DELETE FROM docs WHERE kind=? AND id=?")
      .run("install", key);
    return { path, backup, restored: true };
  } finally {
    store.db.close();
  }
}
