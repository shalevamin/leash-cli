import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough } from "node:stream";
import {
  hostname,
  publicIPv4,
  publicAddress,
  tlsServerName,
  createEgress,
  heartbeatMonitor,
} from "./egress.mjs";
describe("controller heartbeat", () => {
  it("expires an unchanged heartbeat despite host/VM clock skew", () => {
    let elapsed = 0;
    const expired = heartbeatMonitor(
      () => "1792291217162",
      () => elapsed,
    );
    expect(expired()).toBe(false);
    elapsed = 15000;
    expect(expired()).toBe(false);
    elapsed = 15001;
    expect(expired()).toBe(true);
  });
  it("renews only on progress, including host wall-clock corrections", () => {
    let elapsed = 0,
      heartbeat = 100000;
    const expired = heartbeatMonitor(
      () => heartbeat,
      () => elapsed,
    );
    expect(expired()).toBe(false);
    for (let n = 0; n < 10; n++) {
      elapsed += 3000;
      heartbeat -= 1000;
      expect(expired()).toBe(false);
    }
    elapsed += 15001;
    expect(expired()).toBe(true);
  });
  it("does not renew on unreadable or invalid heartbeat data", () => {
    let elapsed = 0,
      heartbeat = "100000";
    const expired = heartbeatMonitor(
      () => {
        if (heartbeat === "missing") throw new Error("missing");
        return heartbeat;
      },
      () => elapsed,
    );
    expect(expired()).toBe(false);
    for (const invalid of ["", "NaN", "Infinity", "-1", "missing"]) {
      elapsed += 3000;
      heartbeat = invalid;
      expect(expired()).toBe(false);
    }
    elapsed++;
    expect(expired()).toBe(true);
  });
});
function hello(name, ech = false) {
  const n = Buffer.from(name);
  const s = Buffer.alloc(5 + n.length);
  s.writeUInt16BE(n.length + 3);
  s[2] = 0;
  s.writeUInt16BE(n.length, 3);
  n.copy(s, 5);
  const e = Buffer.alloc(4 + s.length + (ech ? 4 : 0));
  e.writeUInt16BE(0);
  e.writeUInt16BE(s.length, 2);
  s.copy(e, 4);
  if (ech) e.writeUInt16BE(0xfe0d, 4 + s.length);
  const b = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    Buffer.from([e.length >> 8, e.length & 255]),
    e,
  ]);
  const h = Buffer.alloc(4);
  h[0] = 1;
  h.writeUIntBE(b.length, 1, 3);
  const body = Buffer.concat([h, b]);
  const r = Buffer.from([22, 3, 3, body.length >> 8, body.length & 255]);
  return Buffer.concat([r, body]);
}
async function withBroker(options, fn) {
  const server = createEgress(options);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const request = (port, path, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers,
      },
      (res) => {
        const out = [];
        res.on("data", (c) => out.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(out).toString(),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(body);
  });
describe("egress destination security", () => {
  it("blocks private, linklocal, loopback, multicast, reserved and IPv6 destinations", () => {
    for (const ip of [
      "0.1.2.3",
      "10.1.1.1",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.2",
      "192.168.1.2",
      "192.0.0.1",
      "198.18.1.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
    ])
      expect(publicIPv4(ip), ip).toBe(false);
    expect(publicIPv4("93.184.215.14")).toBe(true);
  });
  it("rejects mixed DNS answers and rebinding to private addresses", async () => {
    await expect(
      publicAddress("example.com", async () => ["93.184.215.14", "127.0.0.1"]),
    ).rejects.toThrow();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(["93.184.215.14"])
      .mockResolvedValueOnce(["10.1.2.3"]);
    expect(await publicAddress("example.com", lookup)).toBe("93.184.215.14");
    await expect(publicAddress("example.com", lookup)).rejects.toThrow();
  });
  it("requires exact DNS names without wildcards or IP encodings", () => {
    for (const name of [
      "*.example.com",
      "127.1",
      "2130706433",
      "[::1]",
      "a.local",
      "example.com.",
      "foo..bar.com",
    ])
      expect(() => hostname(name)).toThrow();
  });
  it("parses TLS SNI and waits for fragmented records", () => {
    const b = hello("example.com");
    expect(tlsServerName(b)).toBe("example.com");
    expect(tlsServerName(b.subarray(0, 10))).toBeNull();
    const raw = b.subarray(5),
      left = raw.subarray(0, 20),
      right = raw.subarray(20);
    const records = Buffer.concat([
      Buffer.from([22, 3, 3, 0, left.length]),
      left,
      Buffer.from([22, 3, 3, 0, right.length]),
      right,
    ]);
    expect(tlsServerName(records)).toBe("example.com");
  });
  it("rejects nonTLS, ECH and malformed ClientHello", () => {
    expect(() => tlsServerName(Buffer.from("GET / HTTP/1.1\r\n"))).toThrow();
    expect(() => tlsServerName(hello("example.com", true))).toThrow();
    const b = hello("example.com");
    b[9] = 99;
    expect(() => tlsServerName(b)).toThrow();
  });
  it("denies non-allowlisted hosts and private DNS even when allowlisted", async () => {
    await withBroker(
      { allowedHosts: ["example.com"], lookup: async () => ["127.0.0.1"] },
      async (port) => {
        for (const path of [
          "http://example.com/",
          "http://other.example.com/",
          "http://127.0.0.1/",
          "http://example.com:8080/",
          "/health",
        ])
          expect((await request(port, path)).status).toBe(403);
      },
    );
  });
  it("terminates CONNECT if TLS SNI differs without opening upstream", async () => {
    await withBroker(
      { allowedHosts: ["example.com"], lookup: async () => ["93.184.215.14"] },
      (port) =>
        new Promise((resolve, reject) => {
          const socket = net.connect(port, "127.0.0.1", () =>
            socket.write(
              "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
            ),
          );
          let response = "";
          socket.setTimeout(3000, () => {
            socket.destroy();
            reject(new Error("TLS mismatch was not closed"));
          });
          socket.once("data", (chunk) => {
            response += chunk;
            socket.write(hello("other.example.com"));
          });
          socket.on("error", reject);
          socket.on("close", () => {
            expect(response).toContain("200 Connection Established");
            resolve();
          });
        }),
    );
  });
});
describe("gateway credential broker", () => {
  it("injects only the sidecar key and restricts provider paths", async () => {
    const captured = [];
    const spy = vi
      .spyOn(https, "request")
      .mockImplementation((options, callback) => {
        captured.push(options);
        const output = new PassThrough();
        output.on("data", () => {});
        output.on("finish", () => {
          const reply = new PassThrough();
          reply.statusCode = 200;
          reply.headers = { "content-type": "application/json" };
          callback(reply);
          reply.end('{"ok":true}');
        });
        return output;
      });
    try {
      await withBroker(
        {
          gateway: {
            url: "https://gateway.example.com/gateway",
            tokens: { openai: "lsh_" + "a".repeat(48) },
          },
          lookup: async () => ["93.184.215.14"],
        },
        async (port) => {
          const response = await request(
            port,
            "/llm/openai/v1/responses",
            '{"model":"test"}',
            {
              "content-type": "application/json",
              authorization: "Bearer attacker",
              "x-api-key": "provider-secret",
              "x-leash-key": "attacker",
            },
          );
          expect(response.status).toBe(200);
          expect(captured[0].headers.authorization).toBe(
            "Bearer lsh_" + "a".repeat(48),
          );
          expect(captured[0].headers["x-api-key"]).toBeUndefined();
          expect(captured[0].headers["x-leash-key"]).toBeUndefined();
          expect(captured[0].path).toBe("/gateway/openai/v1/responses");
          expect(captured[0].servername).toBe("gateway.example.com");
          for (const path of [
            "/llm/openai/v1/admin",
            "/llm/anthropic/v1/responses",
            "/llm/openai/v1/responses?redirect=x",
            "/llm/anthropic/v1/messages",
          ])
            expect(
              (
                await request(port, path, "{}", {
                  "content-type": "application/json",
                })
              ).status,
            ).toBeGreaterThanOrEqual(400);
          expect(captured).toHaveLength(1);
        },
      );
    } finally {
      spy.mockRestore();
    }
  });
});
