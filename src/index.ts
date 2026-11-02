#!/usr/bin/env node
import { registerMemoryCommands } from "./memory.js";
import { registerAgentSetupCommands } from "./agent-setup.js";
import { registerDetectCommands } from "./detect.js";
import {
  registerLocalSecretsCommands,
  localAgentEnvironment,
} from "./local-secrets.js";
import { handoff } from "./handoff.js";
import { connectAgent } from "./connect.js";
import { registerSandboxCommands, sandboxCapabilities } from "./sandbox.js";
import { saveGateway, removeGateway } from "./gateway-vault.js";
import { optimize } from "./optimize.js";
import { login, logout, whoami } from "./auth.js";
import { Command } from "commander";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { validateURL } from "./auth.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import TOML from "@iarna/toml";
import { config } from "./config.js";
import { startProxy } from "./proxy.js";
import { Store, type Session } from "./state.js";
import { install, uninstall, claudeHooks } from "./install.js";
import { report } from "./report.js";
import { startLocal, stopLocal, runLocal, localStatus } from "./local.js";
import { installHooks, uninstallHooks, type HookTarget } from "./hooks.js";
import { runHook } from "./local-hook.js";
import { sync } from "./sync.js";
import {
  registerDevice,
  connectDevice,
  listDevices,
  revokeDevice,
  deviceCycle,
  deviceCredentials,
  deviceRequest,
} from "./device.js";
import { config as dotenv } from "dotenv";
// Customer installations must never read an unrelated ancestor's .env file.
// A source checkout can use node --env-file-if-exists=.env, or this explicit opt-in.
if (process.env.LEASH_ENV_FILE)
  dotenv({ path: resolve(process.env.LEASH_ENV_FILE), quiet: true } as any);
const cliVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;
async function control(path: string, body?: unknown) {
  const c = config();
  const r = await fetch(`http://127.0.0.1:${c.port}/control/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-leash-local-token": c.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = (await r.json()) as any;
  if (!r.ok)
    throw Object.assign(new Error(result.error ?? JSON.stringify(result)), {
      status: r.status,
    });
  return result;
}
const program = new Command()
  .name("leash")
  .description(
    "Agent spend circuit breaker with local, shared-device and hosted gateway modes.",
  )
  .version(cliVersion);
program
  .command("connect")
  .description(
    "Approve your account once, enroll this agent, configure its adapter and start protection",
  )
  .option(
    "--agent <agent>",
    "auto, claude-code, codex, openai-sdk, anthropic-sdk or openrouter-sdk",
    "auto",
  )
  .option("--api <url>", "Your public control API URL")
  .option(
    "--setup <id>",
    "Apply the personalized setup saved under your account",
  )
  .option("--mode <mode>", "auto, device or gateway", "auto")
  .option("--name <name>", "Device display name")
  .option("--project <id>", "Workspace project for this gateway connection")
  .option(
    "--credential <id>",
    "Choose an approved provider connection when several exist",
  )
  .option("--no-browser", "Print the approval URL without opening it")
  .option("--no-install", "Do not change existing agent configuration")
  .option("--no-start", "Save connection without starting a background proxy")
  .option(
    "--home <directory>",
    "Agent config root for an isolated installation",
  )
  .action(async (options) => {
    await connectAgent(options);
  });
program
  .command("optimize [file]")
  .description(
    "Locally compact tool output without dropping values; use - for stdin",
  )
  .option("--mode <mode>", "lossless or off", "lossless")
  .option(
    "--json",
    "Print output and analysis as JSON (contains the input's values)",
  )
  .option("--output <file>", "Write a new private file; never overwrite")
  .action(optimize);
program
  .command("handoff [session-id]")
  .description(
    "Assess a conversation and save a private handoff for the next one (latest session by default)",
  )
  .option(
    "--output <file>",
    "New Markdown file; never overwrites an existing file",
  )
  .option("--goal <text>")
  .option("--completed <text>")
  .option("--decisions <text>")
  .option("--next <text>")
  .option("--json", "Print usage and recommendation without writing a file")
  .action(handoff);
const gateway = program
  .command("gateway")
  .description(
    "Connect the local proxy to a hosted, atomically metered gateway",
  );
gateway
  .command("connect")
  .requiredOption("--url <url>", "Gateway base, ending /gateway")
  .requiredOption("--key-file <file>", "File containing a one-time lsh_ key")
  .action((opts) => {
    const cfg = config();
    if (deviceCredentials())
      throw new Error(
        "Use a fresh LEASH_HOME; device and gateway enrollment are separate transport modes.",
      );
    const url = validateURL(opts.url).replace(/\/$/, ""),
      token = readFileSync(opts.keyFile, "utf8").trim();
    if (!/^lsh_[a-zA-Z0-9_-]{40,}$/.test(token))
      throw new Error("Expected a virtual lsh_ key");
    saveGateway(cfg.dir, { url, token });
    console.log(
      "Gateway connected. Restart leash start, then leash run -- claude/codex. Provider traffic passes through the hosted gateway; local caps still apply.",
    );
  });
gateway.command("disconnect").action(() => {
  removeGateway(config().dir);
  console.log(
    "Gateway credentials removed. Restart the proxy to return to direct local mode.",
  );
});
const device = program
  .command("device")
  .description(
    "Enroll independent devices through HTTPS; no database credentials needed",
  );
device
  .command("register")
  .option("--name <name>")
  .option("--label <label>")
  .option("--json")
  .description(
    "Register this fresh local ledger using your signed-in owner/admin account",
  )
  .action(registerDevice);
device
  .command("connect")
  .requiredOption("--api <url>")
  .requiredOption("--token-file <file>")
  .description("Import a one-time device token created in workspace Settings")
  .action(connectDevice);
device
  .command("list")
  .description("List this workspace's devices on the server")
  .action(listDevices);
device
  .command("revoke")
  .argument("<id>")
  .description("Revoke a device's transport token and cancel pending commands")
  .action(revokeDevice);
program
  .command("agent")
  .option("--once", "Run one poll/execute/ack cycle then exit")
  .description(
    "Receive device commands using an already running local proxy (start also does this)",
  )
  .action(async (options) => {
    if (!deviceCredentials())
      throw new Error("Run leash device register first.");
    const store = new Store(config().dir);
    try {
      do {
        await deviceCycle(store, control);
        if (!options.once) await new Promise((r) => setTimeout(r, 2000));
      } while (!options.once);
    } finally {
      store.db.close();
    }
  });
program
  .command("login")
  .description("Sign in using a browser-approved device code")
  .option("--api <url>", "Control API URL")
  .option("--no-browser", "Print the URL without opening a browser")
  .option("--json", "Machine-readable device code and result")
  .option("--timeout <seconds>", "Approval timeout (up to 600)")
  .action(login);
program
  .command("logout")
  .description("Revoke and remove CLI credentials")
  .action(logout);
program
  .command("whoami")
  .description("Show authenticated account, workspace and role")
  .option("--json")
  .action((options) => whoami(options.json));
program
  .command("init")
  .description("Create private local configuration")
  .action(() => {
    const c = config();
    if (!existsSync(c.path))
      writeFileSync(
        c.path,
        TOML.stringify({ port: c.port, policy: c.policy as any }),
        { mode: 0o600 },
      );
    console.log(`Ready: ${c.path}\nNext: leash run -- claude`);
  });
program
  .command("start")
  .description("Start the loopback proxy and metadata sync")
  .action(() => {
    const p = startProxy();
    console.log(
      `Leash proxy http://127.0.0.1:${p.cfg.port} · caps $${p.cfg.policy.sessionCap}/session`,
    );
    const close = () => {
      clearInterval(p.timer);
      p.server.close(() => process.exit());
      setTimeout(() => process.exit(), 2000).unref();
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  });
program
  .command("run")
  .description("Run an agent through an attributed, budgeted session")
  .option("--cap <usd>", "Session cap")
  .option(
    "--provider <provider>",
    "openai, anthropic or openrouter; OpenRouter supports text Chat Completions",
  )
  .argument("<command...>")
  .allowUnknownOption()
  .action(async (command: string[], options) => {
    if (
      options.provider &&
      !["openai", "anthropic", "openrouter"].includes(options.provider)
    )
      throw new Error("Choose openai, anthropic or openrouter");
    if (
      options.provider === "openrouter" &&
      ["codex", "claude"].includes(command[0].split("/").pop()!)
    )
      throw new Error(
        "OpenRouter supports Chat Completions SDK applications here; Codex Responses and Claude native Messages use their direct provider adapters",
      );
    let owned: ReturnType<typeof startProxy> | undefined;
    try {
      await control("status");
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      owned = startProxy();
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      let repoHash: string | undefined, branch: string | undefined;
      try {
        repoHash = createHash("sha256")
          .update(
            execFileSync("git", ["remote", "get-url", "origin"], {
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim(),
          )
          .digest("hex");
        branch = execFileSync("git", ["branch", "--show-current"], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
      } catch {}
      const cfg = config();
      const s = await control("sessions", {
        agent: command[0],
        cap: options.cap === undefined ? undefined : Number(options.cap),
        repoHash,
        branch,
      });
      const base = `http://127.0.0.1:${cfg.port}/s/${s.id}`;
      const privateEnv = localAgentEnvironment(cfg.dir, process.env);
      const env = {
        ...privateEnv,
        ...(command[0].split("/").pop() === "claude"
          ? { CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_RETRY_WATCHDOG: "0" }
          : {}),
        ...(cfg.gateway?.storedCredential && cfg.gateway.provider === "openai"
          ? { OPENAI_API_KEY: "leash-managed" }
          : {}),
        ...(cfg.gateway?.storedCredential &&
        cfg.gateway.provider === "anthropic"
          ? { ANTHROPIC_API_KEY: "leash-managed" }
          : {}),
        LEASH_SESSION_ID: s.id,
        ANTHROPIC_BASE_URL: `${base}/anthropic`,
        ANTHROPIC_CUSTOM_HEADERS: [
          process.env.ANTHROPIC_CUSTOM_HEADERS,
          `x-leash-local-token: ${cfg.token}`,
        ]
          .filter(Boolean)
          .join("\n"),
        ...(options.provider === "openrouter"
          ? { OPENAI_API_KEY: privateEnv.OPENROUTER_API_KEY }
          : {}),
        OPENAI_BASE_URL: `${base}/${options.provider === "openrouter" ? "openrouter" : "openai"}/v1`,
        OPENROUTER_BASE_URL: `${base}/openrouter/v1`,
        LEASH_LOCAL_TOKEN: cfg.token,
      };
      let args = command.slice(1);
      if (command[0].split("/").pop() === "claude")
        args = [
          "--settings",
          JSON.stringify({
            env: {
              CLAUDE_CODE_MAX_RETRIES: "0",
              CLAUDE_CODE_RETRY_WATCHDOG: "0",
              LEASH_SESSION_ID: s.id,
              ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
              ANTHROPIC_CUSTOM_HEADERS: env.ANTHROPIC_CUSTOM_HEADERS,
            },
            hooks: claudeHooks(),
          }),
          ...args,
        ];
      if (command[0].split("/").pop() === "codex")
        args = [
          "-c",
          'web_search="disabled"',
          "-c",
          'model_provider="leash"',
          "-c",
          `model_providers.leash={name="Leash",base_url="${base}/openai/v1",env_key="OPENAI_API_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0,http_headers={"x-leash-local-token"="${cfg.token}"}}`,
          ...args,
        ];
      console.error(
        `Leash session ${s.id} · cap $${s.cap} · API-key billing only`,
      );
      if (command[0].split("/").pop() === "codex")
        console.error(
          "Leash disables Codex built-in web search because search fees are not metered.",
        );
      const child = spawn(command[0], args, { env, stdio: "inherit" });
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      const code = await new Promise<number>((resolve) => {
        child.on("exit", (c) => resolve(c ?? 1));
        child.on("error", (e) => {
          console.error(e.message);
          resolve(1);
        });
      });
      await control(`sessions/${s.id}/end`, {}).catch(() => {});
      process.exitCode = code;
    } finally {
      if (owned) {
        clearInterval(owned.timer);
        await sync(owned.store).catch(() => {});
        owned.server.close();
      }
    }
  });
program
  .command("status")
  .description("Show local sessions, spend, reservations and kills")
  .option("--json")
  .action(async (options) => {
    let data;
    try {
      data = await control("status");
    } catch {
      data = new Store(config().dir).snapshot();
    }
    if (options.json) console.log(JSON.stringify(data, null, 2));
    else {
      console.log(
        `\nLEASH · ${data.panic ? "PANIC ACTIVE" : "Local protection"} · $${data.reserved.toFixed(4)} reserved\n`,
      );
      console.table(
        data.sessions.map((s: Session) => ({
          id: s.id,
          agent: s.agent,
          status: s.status,
          spent: s.spent.toFixed(4),
          cap: s.cap,
          requests: s.requests,
        })),
      );
      const today = new Date().toISOString().slice(0, 10);
      for (const [label, prefix] of [
        ["Today", today],
        ["Month", today.slice(0, 7)],
      ])
        console.log(
          `${label}: $${data.events
            .filter((e: any) => e.ts.startsWith(prefix))
            .reduce((a: number, e: any) => a + e.cost, 0)
            .toFixed(4)}`,
        );
    }
  });
program
  .command("kill")
  .description("Stop a session, or activate the global panic latch")
  .argument("[id]")
  .option("--all")
  .action(async (id, opts) => {
    if (!id && !opts.all) throw new Error("Specify session ID or --all");
    console.log(
      await control(opts.all ? "kill-all" : `sessions/${id}/kill`, {}),
    );
  });
program
  .command("resume")
  .description("Resume a session; --all clears the panic latch only")
  .argument("[id]")
  .option("--all")
  .option("--add <usd>", "Raise session cap", "0")
  .action(async (id, opts) => {
    if (!id && !opts.all) throw new Error("Specify session ID or --all");
    console.log(
      await control(opts.all ? "resume-all" : `sessions/${id}/resume`, {
        addUsd: Number(opts.add),
      }),
    );
  });
program
  .command("report")
  .description("Read Claude Code and Codex JSONL; estimate API value")
  .option("--claude-dir <path>")
  .option("--codex-dir <path>")
  .option("--since <date>")
  .option("--json")
  .option("--output <directory>", "Write PNG and private HTML report")
  .option(
    "--share",
    "Create share cards and opt in to publishing aggregate numbers via configured sync",
  )
  .action(async (options) => {
    await report(options);
  });
program
  .command("install")
  .description("Back up and configure Claude Code or Codex")
  .argument("<agent>", "claude-code or codex")
  .option("--home <directory>", "Alternate config root (for testing)")
  .action((agent, opts) => console.log(install(agent, opts.home)));
program
  .command("uninstall")
  .alias("off")
  .description("Restore pre-Leash agent configuration; back up current changes")
  .argument("<agent>")
  .option("--home <directory>")
  .action((agent, options) => console.log(uninstall(agent, options.home)));
program
  .command("sync")
  .description("Sync metadata via the enrolled device HTTPS API")
  .option("--dry-run")
  .option("--device", "Require device enrollment")
  .action(async (opts) => {
    if (opts.device && !deviceCredentials())
      throw new Error("Run leash device register first.");
    const store = new Store(config().dir);
    let result;
    try {
      result = await sync(store, opts.dryRun);
    } finally {
      store.db.close();
    }
    console.log(
      opts.dryRun
        ? JSON.stringify(result, null, 2)
        : deviceCredentials()
          ? "Device metadata sync complete (HTTPS; no database credentials)."
          : "Not synced. Run leash login and leash device register first.",
    );
  });
program
  .command("reconcile")
  .description(
    "Reconcile a crash reservation against provider usage (proxy must be stopped)",
  )
  .argument("<reservation-id>")
  .requiredOption(
    "--cost <usd>",
    "Confirmed actual or conservative charged cost",
  )
  .action(async (id, options) => {
    let running = false;
    try {
      await control("status");
      running = true;
    } catch {}
    if (running)
      throw new Error(
        "Stop the proxy before reconciling an orphan reservation. Inspect provider usage first.",
      );
    const store = new Store(config().dir);
    store.reconcile(id, Number(options.cost));
    console.log("Reservation reconciled; audit metadata retained.");
  });
program
  .command("doctor")
  .description("Check local configuration and service reachability")
  .action(async () => {
    const c = config();
    const enrolled = deviceCredentials();
    if (enrolled) {
      console.log(
        `Device: ${enrolled.name} (${enrolled.deviceId}) · HTTPS ${enrolled.apiURL}`,
      );
      console.log("Hosted service credentials are not needed on this machine.");
      try {
        await deviceRequest(enrolled, "devices/me");
        console.log("Device credential active");
      } catch (error) {
        console.log(
          `WARNING: Device transport unavailable or revoked — ${error instanceof Error ? error.message : "check Settings"}. Local protection continues; queued remote commands cannot arrive while disconnected.`,
        );
      }
      if (process.env.LEASH_OFFLINE === "1" || process.env.LEASH_SYNC === "0")
        console.log(
          "WARNING: Background device transport paused by LEASH_OFFLINE/LEASH_SYNC; remote commands will not be received.",
        );
      const state = new Store(c.dir);
      try {
        if (!state.get("setting", "device-ready"))
          console.log(
            "WARNING: Initial device policy not confirmed. Provider admission waits for a successful control-plane connection.",
          );
      } finally {
        state.db.close();
      }
    }
    console.log(
      `Node ${process.version}\nConfig ${c.path}\nSQLite ${c.dir}\nMetadata ${process.env.LEASH_OFFLINE === "1" ? "offline" : deviceCredentials() ? "configured" : "off"}`,
    );
    try {
      await control("status");
      console.log("Proxy healthy");
    } catch {
      console.log(
        "WARNING: Proxy down — agent traffic is not protected through Leash. Run leash start or leash run.",
      );
    }
    console.log(
      `Tool-output compression: ${c.toolCompression} · inspect with leash xray`,
    );
    const sandbox = await sandboxCapabilities();
    console.log(
      `Managed runtime: ${sandbox.supported ? "available" : "optional / unavailable"} — ${sandbox.detail}`,
    );
    for (const bin of ["claude", "codex"])
      try {
        console.log(
          execFileSync(bin, ["--version"], {
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
          })
            .toString()
            .trim(),
        );
      } catch {
        console.log(`${bin}: not found (optional)`);
      }
  });
program
  .command("hook")
  .description("Claude Code lifecycle hook (reads JSON on stdin)")
  .argument("<event>")
  .action(async (event) => {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const id = process.env.LEASH_SESSION_ID ?? input.session_id;
    let decision: any;
    try {
      if (event === "session-end") {
        await control(`sessions/${id}/end`, {});
        return;
      }
      decision = await control("hook", {
        sessionId: id,
        event,
        tool: input.tool_name,
        toolUseId: input.tool_use_id,
        agentId: input.agent_id,
      });
    } catch {
      decision = {
        allow: false,
        reason: "Leash proxy unavailable. Start Leash before continuing.",
      };
    }
    if (!decision.allow && event === "pre-tool-use")
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        }),
      );
  });
const local = program
  .command("local")
  .description(
    "Meter subscription (OAuth) agent sessions from their local logs: subscription (estimated)",
  );
local
  .command("start")
  .description("Start the background watcher for Claude Code, Codex and Cursor")
  .option("--since <date>", "Backfill usage logged since this date")
  .option(
    "--no-kill",
    "Never stop agent processes when the workspace is blocked",
  )
  .action((options) => {
    const r = startLocal(options);
    console.log(
      r.started
        ? `Leash local watcher started (pid ${r.pid}). Usage reports as subscription (estimated).`
        : `Leash local watcher already running (pid ${r.pid}).`,
    );
  });
local
  .command("status")
  .option("--json", "Machine-readable output")
  .action((options) => {
    const s = localStatus();
    if (options.json) return console.log(JSON.stringify(s, null, 2));
    const money = (n: number) => `$${n.toFixed(2)}`;
    console.log(
      `Watcher: ${s.running ? `running (pid ${s.running})` : "stopped"} · ${s.signedIn ? "signed in" : "not signed in (run leash login)"} · ${s.files} log files · ${s.pricingVersion}`,
    );
    for (const [label, t] of [
      ["Today", s.today],
      ["This month", s.month],
    ] as const) {
      const parts = Object.entries(t.tools).map(
        ([tool, v]) =>
          `${tool} ${money(v.costUsd)} (${v.events} responses${v.unpriced ? `, ${v.unpriced} unpriced` : ""})`,
      );
      console.log(`${label}: ${parts.join(" · ") || "no usage"}`);
    }
    console.log(
      `Outbox: ${s.month.pending} pending${s.month.rejected ? `, ${s.month.rejected} rejected` : ""}. Last report: ${s.lastReportAt ?? "never"}${s.lastReportError ? ` (${s.lastReportError})` : ""}`,
    );
    if (s.workspace)
      console.log(
        `Workspace: ${s.workspace.blocked ? `BLOCKED (${s.workspace.reason})` : "active"} · today ${money(s.workspace.daily.spentUsd)} of ${money(s.workspace.daily.capUsd)} · month ${money(s.workspace.monthly.spentUsd)} of ${money(s.workspace.monthly.capUsd)} · checked ${s.workspace.fetchedAt}`,
      );
    console.log(
      "All amounts are API-equivalent estimates, not a subscription invoice.",
    );
  });
local.command("stop").action(() => {
  const r = stopLocal();
  console.log(
    r.stopped
      ? `Leash local watcher stopped (pid ${r.pid}).`
      : "Leash local watcher was not running.",
  );
});
local.command("run", { hidden: true }).action(() => runLocal());
program
  .command("local-hook", { hidden: true })
  .allowUnknownOption()
  .argument("[args...]")
  .action(async (args: string[]) => {
    setTimeout(() => process.exit(0), 3000).unref();
    await runHook(args).catch(() => {});
  });
const hooks = program
  .command("hooks")
  .description(
    "Install agent hooks that stop the next action when the workspace is killed or over budget",
  );
hooks
  .command("install")
  .argument("<agent>", "claude, codex or cursor")
  .option("--home <dir>", "Home directory to configure")
  .action((agent: HookTarget, options) => {
    const r = installHooks(agent, options.home);
    console.log(
      `Installed Leash hooks (${r.events.join(", ")}) in ${r.path}.${r.backup ? ` Backup: ${r.backup}` : ""}\n${r.note}`,
    );
  });
hooks
  .command("uninstall")
  .argument("<agent>", "claude, codex or cursor")
  .option("--home <dir>", "Home directory to configure")
  .action((agent: HookTarget, options) => {
    const r = uninstallHooks(agent, options.home);
    console.log(
      r.removedFile
        ? `Removed ${r.path} (Leash created it).`
        : `Removed Leash hooks from ${r.path}; other hooks are unchanged.`,
    );
  });
registerSandboxCommands(program);
registerMemoryCommands(program);
registerAgentSetupCommands(program);
registerDetectCommands(program);
registerLocalSecretsCommands(program);
program
  .command("xray")
  .description("Show per-tool optimization metadata from the local ledger")
  .action(async () => {
    console.log(JSON.stringify(await control("token-xray"), null, 2));
  });
program.parseAsync().catch((error) => {
  console.error(`Leash: ${error.message}`);
  process.exitCode = 1;
});
