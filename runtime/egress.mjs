// Deliberately dependency-free: the identical broker runs in the isolated sidecar.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import https from "node:https";
import net from "node:net";
import { resolve4 } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function heartbeatMonitor(readHeartbeat, now = () => performance.now()) {
  let lastValue,
    lastChangeAt = now();
  return () => {
    const current = now();
    try {
      const value = Number(readHeartbeat());
      if (Number.isFinite(value) && value > 0 && value !== lastValue) {
        lastValue = value;
        lastChangeAt = current;
      }
    } catch {}
    // Host and Docker VM wall clocks can differ. Only a changed heartbeat
    // renews the lease, measured by this process's monotonic clock.
    return current - lastChangeAt > 15000;
  };
}

export function hostname(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(
      value,
    )
  )
    throw new Error(
      "Use an exact public DNS hostname, without wildcards, a port or IP address",
    );
  const host = value.toLowerCase();
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new Error("Private hostnames are not allowed");
  return host;
}
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function publicAddress(host, lookup = resolve4) {
  const addresses = await lookup(host);
  if (!addresses.length || addresses.some((ip) => !publicIPv4(ip)))
    throw new Error("Destination DNS contains a private or reserved address");
  return addresses[0];
}
// Parse complete TLS ClientHello records without decrypting traffic. Reject ECH,
// missing/duplicate SNI and malformed extensions; do not treat CONNECT as raw TCP.
export function tlsServerName(buffer) {
  let offset = 0,
    handshake = Buffer.alloc(0);
  while (offset + 5 <= buffer.length) {
    if (buffer[offset] !== 22 || buffer[offset + 1] !== 3)
      throw new Error("Only TLS ClientHello is allowed after CONNECT");
    const length = buffer.readUInt16BE(offset + 3);
    if (length > 18432 || !length) throw new Error("Invalid TLS record");
    if (offset + 5 + length > buffer.length) return null;
    handshake = Buffer.concat([
      handshake,
      buffer.subarray(offset + 5, offset + 5 + length),
    ]);
    offset += 5 + length;
    if (handshake.length < 4) continue;
    if (handshake[0] !== 1) throw new Error("TLS ClientHello required");
    const size = handshake.readUIntBE(1, 3);
    if (size > 60000) throw new Error("TLS ClientHello too large");
    if (handshake.length < size + 4) continue;
    const b = handshake.subarray(4, 4 + size);
    if (b[0] !== 3 || b[1] < 1 || b[1] > 3)
      throw new Error("Unsupported TLS ClientHello version");
    let p = 34;
    const need = (n) => {
      if (p + n > b.length) throw new Error("Malformed ClientHello");
    };
    need(1);
    const session = b[p++];
    need(session + 2);
    p += session;
    const cipher = b.readUInt16BE(p);
    p += 2;
    need(cipher + 1);
    p += cipher;
    const compression = b[p++];
    need(compression + 2);
    p += compression;
    const extensions = b.readUInt16BE(p);
    p += 2;
    need(extensions);
    const end = p + extensions;
    if (end !== b.length)
      throw new Error("Invalid ClientHello extension length");
    let name;
    while (p < end) {
      need(4);
      const type = b.readUInt16BE(p),
        len = b.readUInt16BE(p + 2);
      p += 4;
      need(len);
      if (p + len > end) throw new Error("Invalid TLS extension");
      if (type === 0xfe0d)
        throw new Error(
          "Encrypted ClientHello is not supported by the allowlist",
        );
      if (type === 0) {
        if (name || len < 5) throw new Error("Invalid SNI");
        const s = b.subarray(p, p + len);
        if (
          s.readUInt16BE(0) !== len - 2 ||
          s[2] !== 0 ||
          s.readUInt16BE(3) !== len - 5
        )
          throw new Error("Exactly one DNS SNI is required");
        if ([...s.subarray(5)].some((byte) => byte > 127 || byte < 33))
          throw new Error("ASCII DNS SNI required");
        name = hostname(s.subarray(5).toString("ascii"));
      }
      p += len;
    }
    if (!name) throw new Error("TLS SNI required");
    return name;
  }
  return null;
}
const hop = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);
function cleanHeaders(headers) {
  const blocked = new Set([
    ...hop,
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((x) => x.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())),
  );
}
function deny(res, code = 403) {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "sandbox_destination_denied" }));
}
function connectDeny(socket) {
  socket.end(
    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}
const gatewayEndpoint =
  /^\/llm\/(openai|anthropic|openrouter)\/(v1\/(messages|chat\/completions|responses))$/;
export function createEgress({
  allowedHosts = [],
  gateway,
  relay,
  lookup = resolve4,
  onEvent = () => {},
} = {}) {
  const allowed = new Set(allowedHosts.map(hostname));
  if (
    relay &&
    (!/^[a-f0-9]{64}$/.test(relay.token ?? "") ||
      !Array.isArray(relay.providers) ||
      relay.providers.some(
        (p) => !["openai", "anthropic", "openrouter"].includes(p),
      ))
  )
    throw new Error("Invalid private relay configuration");
  const jobs = new Map();
  const relayAuthorized = (req) => {
    const value = String(req.headers.authorization ?? "");
    const expected = `Bearer ${relay?.token}`;
    return (
      value.length === expected.length &&
      timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    );
  };

  let target;
  if (gateway) {
    target = new URL(gateway.url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (target.port && target.port !== "443") ||
      !/^\/gateway\/?$/.test(target.pathname)
    )
      throw new Error("Gateway must be public HTTPS ending /gateway");
    hostname(target.hostname);
  }
  const server = http.createServer(
    { maxHeaderSize: 16384 },
    async (req, res) => {
      let upstream;
      try {
        const requestPath = req.url ?? "";
        if (requestPath.startsWith("/__leash/relay/")) {
          if (!relay || !relayAuthorized(req)) return deny(res, 401);
          if (req.method === "GET" && requestPath === "/__leash/relay/jobs") {
            let ended = false;
            const take = () => {
              if (ended || res.destroyed) return;
              const job = [...jobs.values()].find((j) => !j.dispatched);
              if (job) {
                ended = true;
                job.dispatched = true;
                clearInterval(interval);
                clearTimeout(timeout);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    id: job.id,
                    provider: job.provider,
                    endpoint: job.endpoint,
                    body: job.body,
                    headers: job.headers,
                  }),
                );
              }
            };
            const interval = setInterval(take, 30),
              timeout = setTimeout(() => {
                if (!ended) {
                  ended = true;
                  clearInterval(interval);
                  res.writeHead(204);
                  res.end();
                }
              }, 1000);
            res.on("close", () => {
              ended = true;
              clearInterval(interval);
              clearTimeout(timeout);
            });
            take();
            return;
          }
          const route =
              /^\/__leash\/relay\/jobs\/([a-f0-9-]{36})(\/result)?$/.exec(
                requestPath,
              ),
            job = route && jobs.get(route[1]);
          if (!job) return deny(res, 404);
          if (req.method === "GET" && !route[2]) {
            res.writeHead(200);
            res.end();
            return;
          }
          if (req.method !== "POST" || route[2] !== "/result" || job.streaming)
            return deny(res, 409);
          const status = Number(req.headers["x-relay-status"]);
          if (!Number.isInteger(status) || status < 200 || status > 599)
            return deny(res, 400);
          job.streaming = true;
          const headers = { "cache-control": "no-store" };
          for (const key of [
            "content-type",
            "retry-after",
            "x-leash-session",
            "x-leash-cost",
          ])
            if (typeof req.headers[`x-relay-${key}`] === "string")
              headers[key] = req.headers[`x-relay-${key}`];
          job.res.writeHead(status, headers);
          req.pipe(job.res);
          job.res.on("close", () => {
            if (!req.complete) req.destroy();
          });
          req.on("end", () => {
            jobs.delete(job.id);
            clearTimeout(job.timer);
            res.writeHead(200);
            res.end();
          });
          req.on("error", () => {
            jobs.delete(job.id);
            clearTimeout(job.timer);
            job.res.destroy();
            res.destroy();
          });
          return;
        }
        const match = gatewayEndpoint.exec(requestPath);
        if (requestPath.startsWith("/llm/")) {
          if (
            (!target && !relay) ||
            !match ||
            req.method !== "POST" ||
            (match[1] === "anthropic") !== (match[3] === "messages") ||
            !String(req.headers["content-type"]).startsWith("application/json")
          )
            return deny(res);
          const token = gateway?.tokens[match[1]];
          if (
            relay
              ? !relay.providers.includes(match[1])
              : !/^lsh_[A-Za-z0-9_-]{40,}$/.test(token ?? "")
          )
            return deny(res, 503);
          let bytes = 0;
          const body = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) {
              deny(res, 413);
              return;
            }
            body.push(chunk);
          }
          const raw = Buffer.concat(body);
          JSON.parse(raw.toString("utf8"));
          if (relay) {
            if (jobs.size >= 8) return deny(res, 429);
            const id = randomUUID(),
              headers = {};
            for (const key of ["anthropic-version", "anthropic-beta", "accept"])
              if (typeof req.headers[key] === "string")
                headers[key] = req.headers[key];
            const job = {
              id,
              provider: match[1],
              endpoint: match[2],
              body: raw.toString("utf8"),
              headers,
              res,
              dispatched: false,
              streaming: false,
              timer: undefined,
            };
            job.timer = setTimeout(() => {
              jobs.delete(id);
              if (!res.headersSent) deny(res, 504);
              else res.destroy();
            }, 300000);
            jobs.set(id, job);
            res.on("close", () => {
              jobs.delete(id);
              clearTimeout(job.timer);
            });
            onEvent({ type: "local_proxy_dispatch", provider: match[1] });
            return;
          }
          const address = await publicAddress(target.hostname, lookup);
          const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "content-length": String(raw.length),
          };
          for (const key of ["anthropic-version", "anthropic-beta", "accept"])
            if (typeof req.headers[key] === "string")
              headers[key] = req.headers[key];
          upstream = https.request(
            {
              hostname: address,
              servername: target.hostname,
              port: 443,
              path: `${target.pathname.replace(/\/$/, "")}/${match[1]}/${match[2]}`,
              method: "POST",
              headers: { ...headers, host: target.hostname },
              timeout: 120000,
            },
            (reply) => {
              res.writeHead(
                reply.statusCode ?? 502,
                cleanHeaders(reply.headers),
              );
              reply.pipe(res);
            },
          );
          upstream.on("error", () => {
            if (!res.headersSent) deny(res, 502);
            else res.destroy();
          });
          upstream.on("timeout", () => upstream.destroy());
          res.on("close", () => upstream.destroy());
          upstream.end(raw);
          onEvent({ type: "gateway_dispatch", provider: match[1] });
          return;
        }
        const url = new URL(requestPath);
        const host = hostname(url.hostname);
        if (
          url.protocol !== "http:" ||
          (url.port && url.port !== "80") ||
          url.username ||
          url.password ||
          !allowed.has(host) ||
          ![
            "GET",
            "HEAD",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
          ].includes(req.method ?? "")
        )
          return deny(res);
        const address = await publicAddress(host, lookup);
        upstream = http.request(
          {
            hostname: address,
            port: 80,
            path: url.pathname + url.search,
            method: req.method,
            headers: { ...cleanHeaders(req.headers), host },
            timeout: 30000,
          },
          (reply) => {
            res.writeHead(reply.statusCode ?? 502, cleanHeaders(reply.headers));
            reply.pipe(res);
          },
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!res.headersSent) deny(res, 502);
          else res.destroy();
        });
        req.on("aborted", () => upstream.destroy());
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
        onEvent({ type: "egress_allowed", host, protocol: "http" });
      } catch {
        if (upstream) upstream.destroy();
        if (!res.headersSent) deny(res);
        else res.destroy();
        onEvent({ type: "egress_denied" });
      }
    },
  );
  server.on("connect", async (req, client, head) => {
    try {
      if (!/^[a-z0-9.-]+:443$/i.test(req.url ?? "")) return connectDeny(client);
      const host = hostname(req.url.slice(0, -4));
      if (!allowed.has(host)) return connectDeny(client);
      const address = await publicAddress(host, lookup);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let hello = head,
        finished = false;
      const timer = setTimeout(() => client.destroy(), 5000);
      const inspect = () => {
        try {
          if (hello.length > 65536) throw new Error("ClientHello limit");
          const sni = tlsServerName(hello);
          if (!sni) return;
          if (sni !== host)
            throw new Error("TLS SNI must match CONNECT destination");
          finished = true;
          clearTimeout(timer);
          client.pause();
          client.removeListener("data", data);
          const remote = net.connect({ host: address, port: 443 }, () => {
            remote.write(hello);
            client.pipe(remote);
            remote.pipe(client);
            client.resume();
          });
          remote.setTimeout(120000, () => remote.destroy());
          remote.on("error", () => client.destroy());
          client.on("error", () => remote.destroy());
          client.on("close", () => remote.destroy());
          remote.on("close", () => client.destroy());
          onEvent({ type: "egress_allowed", host, protocol: "https" });
        } catch {
          finished = true;
          clearTimeout(timer);
          client.destroy();
          onEvent({ type: "egress_denied", reason: "tls_policy" });
        }
      };
      const data = (chunk) => {
        if (!finished) {
          hello = Buffer.concat([hello, chunk]);
          inspect();
        }
      };
      client.on("data", data);
      client.on("error", () => clearTimeout(timer));
      client.on("close", () => clearTimeout(timer));
      inspect();
    } catch {
      connectDeny(client);
      onEvent({ type: "egress_denied" });
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(readFileSync("/run/leash/config.json", "utf8"));
  const server = createEgress({
    ...config,
    onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const heartbeatExpired = heartbeatMonitor(() =>
    readFileSync("/run/leash/heartbeat", "utf8"),
  );
  heartbeatExpired();
  setInterval(() => {
    if (heartbeatExpired()) {
      console.log(
        JSON.stringify({ type: "sandbox_control_heartbeat_expired" }),
      );
      for (const socket of sockets) socket.destroy();
      process.exit(78);
    }
  }, 2000).unref();
  server.listen(3128, "0.0.0.0", () =>
    console.log(JSON.stringify({ type: "sandbox_egress_ready" })),
  );
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
