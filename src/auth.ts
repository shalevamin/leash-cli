import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Store } from "./state.js";
type Credentials = {
  token: string;
  expiresAt: string;
  orgId: string;
  apiURL: string;
};
const path = () => join(config().dir, "credentials.json");
export function credentials(): Credentials | undefined {
  try {
    return JSON.parse(readFileSync(path(), "utf8"));
  } catch {
    return undefined;
  }
}
export function validateURL(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error("Use HTTPS for remote APIs, or HTTP on localhost");
  return url.toString().replace(/\/$/, "");
}
async function request(
  api: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const r = await fetch(`${api}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  return { response: r, data: (await r.json()) as any };
}
export async function login(options: {
  api?: string;
  browser?: boolean;
  json?: boolean;
  timeout?: string;
}) {
  const api = validateURL(
    options.api ?? process.env.LEASH_API_URL ?? "https://api.useleash.dev",
  );
  const { response, data } = await request(api, "auth/device/start", {});
  if (!response.ok)
    throw new Error(data.error ?? "Unable to start device login");
  const timeout = Number(options.timeout ?? data.expiresIn);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600)
    throw new Error("Login timeout must be 1–600 seconds");
  const url = new URL(data.verificationUriComplete);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Unsafe device verification URL");
  const info = {
    userCode: data.userCode,
    verificationUriComplete: data.verificationUriComplete,
    expiresIn: data.expiresIn,
  };
  if (options.json) console.log(JSON.stringify(info));
  else
    console.log(
      `Open ${data.verificationUriComplete}\nConfirm code: ${data.userCode}\nWaiting for your approval…`,
    );
  if (options.browser !== false) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const child = spawn(
      opener,
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", data.verificationUriComplete]
        : [data.verificationUriComplete],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  }
  const deadline = Date.now() + Math.min(timeout, data.expiresIn) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(2, data.interval) * 1000));
    const result = await request(api, "auth/device/token", {
      deviceCode: data.deviceCode,
    });
    if (result.response.ok) {
      const cfg = config(),
        store = new Store(cfg.dir);
      try {
        const current =
          store.get<{ orgId: string }>("setting", "workspace")?.orgId ??
          "00000000-0000-4000-8000-000000000001";
        if (
          current !== result.data.orgId &&
          (store.all("session").length ||
            store.all("report").length ||
            store.all("repo-budget").length)
        ) {
          await request(api, "v1/logout", {}, result.data.token);
          throw new Error(
            "This local ledger belongs to another workspace. Use a fresh LEASH_HOME (and matching API/proxy configuration) to connect a different workspace.",
          );
        }
        store.put("setting", "workspace", { orgId: result.data.orgId });
        writeFileSync(
          join(cfg.dir, "workspace.json"),
          JSON.stringify({ orgId: result.data.orgId }),
          { mode: 0o600 },
        );
        const temporary = path() + "." + randomUUID();
        writeFileSync(
          temporary,
          JSON.stringify({ ...result.data, apiURL: api }),
          { mode: 0o600 },
        );
        renameSync(temporary, path());
      } finally {
        store.db.close();
      }
      console.log(
        options.json
          ? JSON.stringify({ authenticated: true, orgId: result.data.orgId })
          : `Signed in. Workspace ${result.data.orgId}\nCredentials saved privately; expires ${result.data.expiresAt}.`,
      );
      return;
    }
    if (!["authorization_pending", "slow_down"].includes(result.data.error))
      throw new Error(`Device login: ${result.data.error}`);
  }
  throw new Error("Device login expired. Run leash login again.");
}
export async function whoami(json = false) {
  const c = credentials();
  if (!c) throw new Error("Not signed in. Run leash login.");
  const { response, data } = await request(
    validateURL(c.apiURL),
    "v1/me",
    undefined,
    c.token,
  );
  if (!response.ok)
    throw new Error(data.error ?? "Session expired. Run leash login.");
  console.log(
    json
      ? JSON.stringify(data, null, 2)
      : `${data.user.email}\nWorkspace: ${data.workspace.name} (${data.workspace.id})\nRole: ${data.role}`,
  );
  return data;
}
export async function logout() {
  const c = credentials();
  if (c) {
    try {
      const r = await request(validateURL(c.apiURL), "v1/logout", {}, c.token);
      if (!r.response.ok)
        console.error(
          "Local credentials removed; remote revocation could not be confirmed. Revoke the CLI token in workspace settings.",
        );
    } catch {
      console.error(
        "API unavailable. Local credentials removed; revoke the CLI token in workspace settings when available.",
      );
    }
    if (existsSync(path())) unlinkSync(path());
  }
  console.log(
    "Signed out. Local protection and workspace ledger binding remain active.",
  );
}
