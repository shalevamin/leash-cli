import { localCredentialReadiness } from "./local-secrets.js";
import { detectAgents, resolveDetectedAgent } from "./detect.js";
import { parseSetupPlan } from "./core/index.js";
import { hostname } from "node:os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { credentials, login, validateURL } from "./auth.js";
import { registerDevice, deviceCredentials, deviceRequest } from "./device.js";
import { saveGateway, removeGateway } from "./gateway-vault.js";
import { install } from "./install.js";
import { Store } from "./state.js";
import {
  validateSetupId,
  validateSetupEnvelope,
  applyLocalSetup,
  assertSetupProxy,
  type AppliedSetup,
} from "./setup-local.js";

export function connectMode(
  mode: string,
  hasDevice: boolean,
  hasGateway: boolean,
  _available: number,
) {
  if (!["auto", "device", "gateway"].includes(mode))
    throw new Error("Mode must be auto, device or gateway");
  if ((hasDevice && mode === "gateway") || (hasGateway && mode === "device"))
    throw new Error(
      "This ledger already uses another transport. Use a fresh LEASH_HOME; never reassign existing spend.",
    );
  return mode === "auto"
    ? hasDevice
      ? "device"
      : hasGateway
        ? "gateway"
        : "device"
    : mode;
}
export async function connectAgent(options: {
  agent: string;
  setup?: string;
  api?: string;
  browser?: boolean;
  mode?: string;
  name?: string;
  project?: string;
  credential?: string;
  install?: boolean;
  start?: boolean;
  home?: string;
}) {
  if (
    ![
      "auto",
      "claude-code",
      "codex",
      "openai-sdk",
      "anthropic-sdk",
      "openrouter-sdk",
    ].includes(options.agent)
  )
    throw new Error(
      "Choose auto, claude-code, codex, openai-sdk or anthropic-sdk",
    );
  if (options.setup) validateSetupId(options.setup);
  const cfg = config(),
    api = validateURL(
      options.api ??
        credentials()?.apiURL ??
        process.env.LEASH_API_URL ??
        "https://api.useleash.dev",
    );
  if (credentials() && validateURL(credentials()!.apiURL) !== api)
    throw new Error(
      "Already signed into a different control plane. Use a fresh LEASH_HOME for a different account.",
    );
  if (!credentials()) await login({ api, browser: options.browser });
  const auth = credentials()!;
  const me = await deviceRequest(auth, "me");
  const setupResponse = options.setup
    ? await deviceRequest(
        auth,
        `connect/setup/${validateSetupId(options.setup)}`,
      )
    : undefined;
  options = {
    ...options,
    agent: resolveDetectedAgent(
      options.agent,
      detectAgents(),
      setupResponse ? parseSetupPlan(setupResponse.plan).agent : undefined,
    ),
  };
  const setupIdentity = options.setup
    ? {
        id: options.setup,
        orgId: me.workspace.id,
        userId: me.user.id,
        agent: options.agent,
      }
    : undefined;
  const setup = setupIdentity
    ? validateSetupEnvelope(setupResponse, setupIdentity)
    : undefined;
  const connected = await deviceRequest(auth, "connect");
  const provider =
    options.agent === "claude-code" || options.agent === "anthropic-sdk"
      ? "anthropic"
      : options.agent === "openrouter-sdk"
        ? "openrouter"
        : "openai";
  const available = connected.credentials.filter(
    (r: any) =>
      r.provider === provider &&
      (!options.credential || r.id === options.credential),
  );
  const enrolled = deviceCredentials();
  if (
    enrolled &&
    (enrolled.orgId !== me.workspace.id || validateURL(enrolled.apiURL) !== api)
  )
    throw new Error(
      "Existing device belongs to another workspace or control plane",
    );
  if (enrolled) {
    let current;
    try {
      current = await deviceRequest(enrolled, "devices/me");
    } catch (error) {
      if ((error as any).status === 401)
        throw new Error(
          "Device credential was revoked. Existing spend and protection were preserved. Enroll with a fresh LEASH_HOME after account approval.",
          { cause: error },
        );
      throw error;
    }
    validateExistingDevice(current.device, {
      deviceId: enrolled.deviceId,
      orgId: me.workspace.id,
      userId: me.user.id,
    });
  }
  if (
    cfg.gateway &&
    (cfg.gateway.orgId !== me.workspace.id ||
      cfg.gateway.userId !== me.user.id ||
      cfg.gateway.agent !== options.agent ||
      (cfg.gateway.projectId ?? undefined) !== options.project)
  )
    throw new Error(
      "Existing gateway connection has a different account, product or project. Use a fresh LEASH_HOME; existing protection was preserved.",
    );
  const mode = connectMode(
    options.mode ?? "auto",
    !!enrolled,
    !!cfg.gateway,
    available.length,
  );
  if (provider === "openrouter" && mode === "gateway")
    throw new Error(
      "OpenRouter uses local device transport. Use a fresh LEASH_HOME with --mode device; no provider key will be uploaded",
    );
  let reuseGateway = false;
  if (mode === "gateway" && cfg.gateway?.keyId) {
    try {
      const metadata = await deviceRequest(
        auth,
        `connect/keys/${cfg.gateway.keyId}`,
      );
      reuseGateway =
        metadata.active === true &&
        (!setup ||
          (metadata.setupId === setup.id && cfg.gateway.setupId === setup.id));
    } catch (error) {
      if ((error as any).status !== 404) throw error;
    }
  }
  if (mode === "gateway" && !reuseGateway) {
    const store = new Store(cfg.dir);
    try {
      if (
        !cfg.gateway &&
        (store.all("session").length || store.all("report").length)
      )
        throw new Error(
          "Connect a fresh LEASH_HOME before the first run; existing usage cannot be reassigned to a gateway.",
        );
    } finally {
      store.db.close();
    }
    const connectionFile = join(cfg.dir, "connection-id");
    if (!existsSync(connectionFile))
      writeFileSync(connectionFile, randomUUID(), { mode: 0o600, flag: "wx" });
    const connection = await deviceRequest(auth, "connect/gateway", {
      agent: options.agent,
      ...(setup ? { setupId: setup.id } : {}),
      connectionId: readFileSync(connectionFile, "utf8").trim(),
      ...(options.project ? { projectId: options.project } : {}),
      ...(options.credential ? { credentialId: options.credential } : {}),
    });
    try {
      validateURL(connection.url);
      saveGateway(cfg.dir, connection);
    } catch (error) {
      await deviceRequest(
        auth,
        `connect/keys/${connection.keyId}/revoke`,
        {},
      ).catch(() => {});
      if (!cfg.gateway) removeGateway(cfg.dir);
      throw error;
    }
  } else if (mode === "device" && !enrolled) {
    await registerDevice({
      name: options.name ?? `${hostname()} · ${options.agent}`.slice(0, 80),
    });
  }
  const applied =
    setup && setupIdentity
      ? applyLocalSetup(setup, {
          ...setupIdentity,
          dir: cfg.dir,
          effectivePolicy: config().policy,
        })
      : undefined;
  if (applied)
    console.log(
      `Setup saved: $${applied.sessionCap} per session, $${applied.dailyCap} per day; blocking enforcement. Model policy: ${applied.modelRouting.mode}. Runtime preference: ${applied.runtime} (no runtime launched). Existing spend and kill state preserved. Lower caps apply to the next admission; already-dispatched calls are not cancelled.`,
    );
  const localReadiness =
    mode === "device" ? localCredentialReadiness(cfg.dir, provider) : undefined;
  if (mode === "device")
    console.log(
      `Provider API credentials stay on this machine. Import once with leash secrets import --provider ${provider} --from-env ${provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"}. No provider key is uploaded. OAuth-only subscriptions cannot be intercepted as provider API traffic.`,
    );
  if (
    options.install !== false &&
    localReadiness?.status !== "missing" &&
    ["claude-code", "codex"].includes(options.agent)
  ) {
    const installed = install(options.agent, options.home);
    console.log(`Agent configured with a restorable backup: ${installed.path}`);
  }
  if (localReadiness?.status === "missing")
    console.log(
      "Workspace linked, but provider authorization is missing. Agent configuration was not changed. Import a provider API key locally, then rerun connect before starting an agent.",
    );
  if (options.start !== false) await ensureProxy(applied);
  else if (applied) {
    const current = config();
    const running = await runningProxyStatus(current);
    if (running) {
      assertSetupProxy(running, applied);
      assertGatewayProxy(running, current);
    } else
      console.log(
        "Protection settings are saved; the proxy is not running. Run leash start before an agent.",
      );
  }
  const next =
    localReadiness?.status === "missing"
      ? `leash secrets import --provider ${provider} --from-env ${localReadiness.environmentVariable}; then rerun connect`
      : applied?.runtime === "managed"
        ? "leash sandbox run --help — choose a trusted agent image and approve a specific project mount; no sandbox has been launched"
        : `leash run ${provider === "openrouter" ? "--provider openrouter " : ""}-- ${options.agent === "claude-code" ? "claude" : options.agent === "codex" ? "codex" : "YOUR_COMMAND"}`;
  console.log(
    `Connected ${options.agent}\nAccount: ${me.user.email}\nWorkspace: ${me.workspace.name}\nTransport: ${mode}\nCompression: ${config().toolCompression}\nProvider secret: ${mode === "gateway" ? "encrypted on the control plane; never downloaded" : localReadiness?.status === "local-vault" ? "encrypted on this machine; never uploaded" : localReadiness?.status === "environment" ? "present in the current environment; import into the local vault to keep it out of child processes" : "not configured"}\nProvider connection: untested (no paid request made)\nNext: ${next}`,
  );
  return {
    orgId: me.workspace.id,
    userId: me.user.id,
    mode,
    agent: options.agent,
    providerCredential: localReadiness?.status ?? "gateway",
    providerConnectionTested: false,
  };
}

export async function runningProxyStatus(cfg = config()) {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${cfg.port}/control/status`, {
      headers: { "x-leash-local-token": cfg.token },
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    if ((error as any).cause?.code === "ECONNREFUSED") return null;
    throw Object.assign(
      new Error(
        "Could not verify the proxy on this port. Check it before restarting; no duplicate proxy was started",
        { cause: error },
      ),
      { permanent: true },
    );
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        "A different proxy owns this port. Choose a different LEASH_PORT; existing protection was not changed.",
      ),
      { permanent: true },
    );
  return response.json();
}
function assertGatewayProxy(data: any, cfg: ReturnType<typeof config>) {
  if (
    cfg.gateway &&
    (data.transport !== "gateway" || data.gatewayKeyId !== cfg.gateway.keyId)
  )
    throw Object.assign(
      new Error(
        "Connection saved, but the running proxy has an older gateway key. Stop that proxy and run leash start to load the new connection. Existing caps and ledger were preserved.",
      ),
      { permanent: true },
    );
}
export async function ensureProxy(applied?: AppliedSetup) {
  const cfg = config();
  const status = async () => {
    const data = await runningProxyStatus(cfg);
    if (!data) throw new Error("Proxy is not running");
    if (applied) {
      try {
        assertSetupProxy(data, applied);
      } catch (error) {
        throw Object.assign(error as Error, { permanent: true });
      }
    }
    assertGatewayProxy(data, cfg);
    return data;
  };
  try {
    await status();
    return;
  } catch (error) {
    if ((error as any).permanent) throw error;
  }
  const log = openSync(join(cfg.dir, "proxy.log"), "a", 0o600);
  const child = spawn(process.execPath, [resolve(process.argv[1]), "start"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log);
  let failed: Error | undefined;
  child.on("error", (e) => {
    failed = e;
  });
  child.unref();
  for (let n = 0; n < 40; n++) {
    if (failed || child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
    try {
      await status();
      console.log(
        `Protection running on 127.0.0.1:${cfg.port}. Private log: ${join(cfg.dir, "proxy.log")}`,
      );
      return;
    } catch (e) {
      if ((e as any).permanent) {
        child.kill();
        throw e;
      }
    }
  }
  child.kill();
  throw new Error(
    "Proxy did not become healthy. Inspect proxy.log, then run leash start. Account connection was saved; no provider call was made.",
  );
}

export function validateExistingDevice(
  device: { id: string; orgId: string; userId?: string | null; status: string },
  account: { deviceId: string; orgId: string; userId: string },
) {
  if (
    device.status !== "active" ||
    device.id !== account.deviceId ||
    device.orgId !== account.orgId ||
    device.userId !== account.userId
  )
    throw new Error(
      "Existing device belongs to another account or is inactive. Use a fresh LEASH_HOME; existing spend and protection were preserved.",
    );
}
