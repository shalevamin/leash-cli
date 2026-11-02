import { randomBytes } from "node:crypto";
import { LOCAL_CREDENTIAL_MARKER } from "./local-secrets.js";
export type LocalProxyConnection = {
  url: string;
  token: string;
  sessionId: string;
  providers: string[];
};
export function validateLocalProxyConnection(input: LocalProxyConnection) {
  const url = new URL(input.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !input.token ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.sessionId) ||
    !input.providers.length ||
    input.providers.some(
      (p) => !["openai", "anthropic", "openrouter"].includes(p),
    )
  )
    throw new Error(
      "Local sandbox relay requires an authenticated loopback proxy, existing session and explicit providers",
    );
  return { ...input, url: url.origin };
}
export function relayCredential() {
  return randomBytes(32).toString("hex");
}
export function startSandboxRelay(
  base: string,
  token: string,
  connection: LocalProxyConnection,
  onFailure: () => void,
) {
  const local = validateLocalProxyConnection(connection),
    controller = new AbortController(),
    active = new Set<AbortController>();
  const headers = { authorization: `Bearer ${token}` };
  let stopped = false;
  async function handle(job: any) {
    const signal = new AbortController();
    active.add(signal);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (
        !/^[a-f0-9-]{36}$/.test(job.id) ||
        !local.providers.includes(job.provider) ||
        !/^v1\/(messages|responses|chat\/completions)$/.test(job.endpoint) ||
        (job.provider === "anthropic") !== (job.endpoint === "v1/messages") ||
        typeof job.body !== "string" ||
        job.body.length > 4 * 1024 * 1024
      )
        throw new Error("Invalid relay job");
      timer = setInterval(() => {
        void fetch(`${base}/__leash/relay/jobs/${job.id}`, {
          headers,
          signal: AbortSignal.timeout(2500),
        })
          .then((r) => {
            if (r.status !== 200) signal.abort();
          })
          .catch(() => signal.abort());
      }, 750);
      const requestHeaders: Record<string, string> = {
        "content-type": "application/json",
        "x-leash-local-token": local.token,
        ...(job.provider === "anthropic"
          ? { "x-api-key": LOCAL_CREDENTIAL_MARKER }
          : { authorization: `Bearer ${LOCAL_CREDENTIAL_MARKER}` }),
      };
      for (const key of ["anthropic-version", "anthropic-beta", "accept"])
        if (typeof job.headers?.[key] === "string")
          requestHeaders[key] = job.headers[key];
      const reply = await fetch(
        `${local.url}/s/${local.sessionId}/${job.provider}/${job.endpoint}`,
        {
          method: "POST",
          headers: requestHeaders,
          body: job.body,
          signal: signal.signal,
          redirect: "error",
        },
      );
      const outgoing: Record<string, string> = {
        ...headers,
        "x-relay-status": String(reply.status),
      };
      for (const key of [
        "content-type",
        "retry-after",
        "x-leash-session",
        "x-leash-cost",
      ])
        if (reply.headers.has(key))
          outgoing[`x-relay-${key}`] = reply.headers.get(key)!;
      const upload = await fetch(
        `${base}/__leash/relay/jobs/${job.id}/result`,
        {
          method: "POST",
          headers: outgoing,
          body: reply.body,
          signal: signal.signal,
          duplex: "half",
        } as RequestInit,
      );
      if (!upload.ok) signal.abort();
    } catch {
      // A disconnect cancels the same request; never replay an agent/provider call.
      if (!stopped)
        await fetch(`${base}/__leash/relay/jobs/${job.id}/result`, {
          method: "POST",
          headers: {
            ...headers,
            "x-relay-status": "502",
            "x-relay-content-type": "application/json",
          },
          body: '{"error":"protected_local_proxy_unavailable"}',
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
    } finally {
      if (timer) clearInterval(timer);
      signal.abort();
      active.delete(signal);
    }
  }
  const task = (async () => {
    while (!stopped) {
      try {
        if (active.size >= 8) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        const response = await fetch(`${base}/__leash/relay/jobs`, {
          headers,
          signal: controller.signal,
        });
        if (response.status === 204) continue;
        if (!response.ok) throw new Error("Relay refused authentication");
        void handle(await response.json());
      } catch {
        if (!stopped) {
          stopped = true;
          for (const running of active) running.abort();
          onFailure();
        }
      }
    }
  })();
  return {
    stop: () => {
      stopped = true;
      controller.abort();
      for (const running of active) running.abort();
    },
    done: task,
  };
}
