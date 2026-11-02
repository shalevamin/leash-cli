import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createEgress } from "./egress.mjs";
import {
  startSandboxRelay,
  relayCredential,
  validateLocalProxyConnection,
} from "../src/sandbox-relay.ts";
const servers = [],
  controllers = [];
async function listen(server) {
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
describe("authenticated protected local relay", () => {
  it("streams through only the selected local session without forwarding caller credentials", async () => {
    const received = [],
      token = relayCredential();
    const upstream = await listen(
      createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        received.push({ path: req.url, headers: req.headers, body });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        setTimeout(() => res.end("data: last\n\n"), 20);
      }),
    );
    const broker = await listen(
      createEgress({ relay: { token, providers: ["openai"] } }),
    );
    controllers.push(
      startSandboxRelay(
        broker,
        token,
        {
          url: upstream,
          token: "host-control",
          sessionId: "session-1",
          providers: ["openai"],
        },
        () => {
          throw new Error("unexpected relay failure");
        },
      ),
    );
    expect((await fetch(broker + "/__leash/relay/jobs")).status).toBe(401);
    expect(
      (
        await fetch(broker + "/llm/openai/v1/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const result = await fetch(broker + "/llm/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-secret",
        "x-leash-local-token": "caller-injected-control",
      },
      body: '{"model":"gpt-4o"}',
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("data: first\n\ndata: last\n\n");
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/s/session-1/openai/v1/responses");
    expect(received[0].headers.authorization).toBe(
      "Bearer leash-local-managed",
    );
    expect(received[0].headers["x-leash-local-token"]).toBe("host-control");
    expect(
      (
        await fetch(broker + "/llm/anthropic/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });
  it("cancels a disconnected caller instead of replaying the provider request", async () => {
    let requests = 0,
      closed = false;
    const upstream = await listen(
      createServer((req, res) => {
        requests++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        res.on("close", () => {
          closed = true;
        });
      }),
    );
    const token = relayCredential(),
      broker = await listen(
        createEgress({ relay: { token, providers: ["openai"] } }),
      );
    controllers.push(
      startSandboxRelay(
        broker,
        token,
        {
          url: upstream,
          token: "host-token",
          sessionId: "session",
          providers: ["openai"],
        },
        () => {},
      ),
    );
    const abort = new AbortController();
    const response = await fetch(broker + "/llm/openai/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 30 && !closed; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    expect(requests).toBe(1);
  });
  it("refuses remote or URL-embedded control-plane credentials", () => {
    for (const url of [
      "http://localhost:8787",
      "https://example.com:443",
      "http://127.0.0.1:8787/control",
      "http://user:secret@127.0.0.1:8787",
    ]) {
      expect(() =>
        validateLocalProxyConnection({
          url,
          token: "token",
          sessionId: "session",
          providers: ["openai"],
        }),
      ).toThrow("loopback");
    }
  });
});
