import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Store, type Session } from "./state.js";
import { createProxy } from "./proxy.js";
import { defaultPolicy } from "./core/index.js";
let dir: string, store: Store, server: Server, calls: number;
let upstreamBody: any;
const cfg = {
  dir: "",
  path: "",
  token: "test-local-secret",
  port: 8787,
  policy: defaultPolicy,
  prices: {},
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "leash-test-"));
  store = new Store(dir);
  calls = 0;
  upstreamBody = undefined;
  server = createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const b = JSON.parse(body);
    upstreamBody = b;
    if (b.metadata?.fail) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.url === "/v1/messages") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          type: "message",
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        }),
      );
      return;
    }
    if (b.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.created"}\n\n');
      setTimeout(() => {
        res.end(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":100,"input_tokens_details":{"cached_tokens":200}}}}\n\n',
        );
      }, 100);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 200 },
          },
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LEASH_OPENAI_UPSTREAM = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.LEASH_ANTHROPIC_UPSTREAM = process.env.LEASH_OPENAI_UPSTREAM;
});
afterEach(async () => {
  delete process.env.LEASH_OPENAI_UPSTREAM;
  delete process.env.LEASH_ANTHROPIC_UPSTREAM;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function request(
  app: ReturnType<typeof createProxy>,
  id: string,
  body: object = {},
) {
  return app.request(`/s/${id}/openai/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-leash-local-token": cfg.token,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "hi",
      max_output_tokens: 100,
      ...body,
    }),
  });
}
describe("proxy enforcement with a real mock upstream", () => {
  it("cancels an open provider body even if fetch ignores its abort signal", async () => {
    const s = store.create("ignored-fetch-abort", 100);
    const app = createProxy(store, cfg);
    let cancelled = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    try {
      const response = await request(app, s.id, { stream: true });
      const reading = response.text();
      const rejected = expect(reading).rejects.toThrow();
      await app.request("/control/kill-all", {
        method: "POST",
        headers: { "x-leash-local-token": cfg.token },
      });
      await rejected;
      expect(cancelled).toBe(true);
      expect(store.snapshot().reserved).toBe(0);
      expect(store.snapshot().events).toHaveLength(1);
      expect(store.snapshot().events[0].estimated).toBe(true);
      expect(store.snapshot().events[0].cost).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("rejects explicit zero or malformed output limits before dispatch", async () => {
    const s = store.create("invalid-output-limit", 100);
    const app = createProxy(store, cfg);
    for (const max_output_tokens of [-1, 0, null, false, ""]) {
      const response = await request(app, s.id, { max_output_tokens });
      expect(response.status).toBe(400);
      expect((await response.json()).error.type).toBe("leash_unpriced_request");
    }
    expect(calls).toBe(0);
    expect(store.snapshot().reserved).toBe(0);
    expect(store.snapshot().events).toHaveLength(0);
  });
  it("rejects premium and background work before reservation or provider dispatch", async () => {
    const s = store.create("unsupported-billing", 100);
    const app = createProxy(store, cfg);
    for (const change of [
      { background: true },
      { background: "false" },
      { service_tier: "priority" },
      { service_tier: "auto" },
      { service_tier: null },
      { speed: "fast" },
      { inference_geo: "us" },
    ]) {
      expect((await request(app, s.id, change)).status).toBe(400);
      const response = await app.request(`/s/${s.id}/anthropic/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-leash-local-token": cfg.token,
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }],
          ...change,
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
    expect(store.snapshot().events).toHaveLength(0);
    expect(store.snapshot().reserved).toBe(0);
  });
  it("sends explicit standard tier and global inference to the provider", async () => {
    const s = store.create("standard-billing", 100);
    const app = createProxy(store, cfg);
    const openai = await request(app, s.id, { background: false });
    expect(openai.status).toBe(200);
    await openai.text();
    expect(upstreamBody.service_tier).toBe("default");
    const anthropic = await app.request(`/s/${s.id}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-leash-local-token": cfg.token,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(anthropic.status).toBe(200);
    await anthropic.text();
    expect(upstreamBody.service_tier).toBe("standard_only");
    expect(upstreamBody.inference_geo).toBe("global");
    expect(calls).toBe(2);
  });
  it("preserves native client tool namespaces and rejects hidden hosted tools", async () => {
    const s = store.create("native-tools", 10);
    const app = createProxy(store, cfg);
    const tools = [
      {
        type: "namespace",
        name: "multi_agent_v1",
        description: "Client functions",
        tools: [
          {
            type: "function",
            name: "wait_agent",
            parameters: { type: "object" },
          },
        ],
      },
    ];
    const response = await request(app, s.id, { tools });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamBody.tools).toEqual(tools);
    for (const rejected of [
      null,
      { type: "namespace", tools: null },
      { type: "namespace", tools: [null] },
      { type: "namespace", tools: [{ type: "web_search" }] },
      { type: "namespace", tools: [{ type: "namespace", tools: [] }] },
    ])
      expect((await request(app, s.id, { tools: [rejected] })).status).toBe(
        400,
      );
    expect(calls).toBe(1);
  });
  it("routes before admission, bills the selected model and records no prompt text", async () => {
    const s = store.create("routing", 0.2);
    const app = createProxy(store, {
      ...cfg,
      routing: {
        mode: "economy",
        allowlist: ["gpt-4o-mini"],
        pinnedModels: [],
      },
    });
    const r = await request(app, s.id, {
      model: "gpt-4.1",
      input: "PRIVATE_ROUTING_PROMPT",
      stream: true,
    });
    expect(r.status).toBe(200); // Original GPT-4.1 full-context reservation exceeds $2.
    expect(r.headers.get("x-leash-used-model")).toBe("gpt-4o-mini");
    await r.text();
    expect(upstreamBody.model).toBe("gpt-4o-mini");
    expect(upstreamBody.input).toBe("PRIVATE_ROUTING_PROMPT");
    const event = store.snapshot().events[0];
    expect(event.model).toBe("gpt-4o-mini");
    expect(event.cost).toBeCloseTo(0.000195);
    expect(event.optimization?.routing).toMatchObject({
      requestedModel: "gpt-4.1",
      usedModel: "gpt-4o-mini",
      changed: true,
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE_ROUTING_PROMPT");
    expect(calls).toBe(1);
  });
  it("still blocks a routed call whose selected-model reservation exceeds the cap", async () => {
    const s = store.create("routing", 0.001);
    const app = createProxy(store, {
      ...cfg,
      routing: {
        mode: "economy",
        allowlist: ["gpt-4o-mini"],
        pinnedModels: [],
      },
    });
    expect((await request(app, s.id, { model: "gpt-4.1" })).status).toBe(429);
    expect(calls).toBe(0);
  });
  it("routes a plain Anthropic request within its provider and settles Haiku usage", async () => {
    const s = store.create("anthropic-routing", 0.4);
    const app = createProxy(store, {
      ...cfg,
      routing: {
        mode: "balanced",
        allowlist: ["claude-haiku-4-5-20251001"],
        pinnedModels: [],
      },
    });
    const response = await app.request(`/s/${s.id}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-leash-local-token": cfg.token,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 100,
        messages: [{ role: "user", content: "Write a short title." }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamBody.model).toBe("claude-haiku-4-5-20251001");
    expect(store.snapshot().events[0].cost).toBeCloseTo(0.0018);
    expect(
      store.snapshot().events[0].optimization?.routing?.requestedModel,
    ).toBe("claude-sonnet-4-5-20250929");
    expect(calls).toBe(1);
  });
  it("cannot route a forbidden original model into an allowed candidate", async () => {
    const s = store.create("routing", 20);
    const app = createProxy(store, {
      ...cfg,
      policy: { ...defaultPolicy, modelAllowlist: ["gpt-4o-mini"] },
      routing: {
        mode: "economy",
        allowlist: ["gpt-4o-mini"],
        pinnedModels: [],
      },
    });
    expect((await request(app, s.id, { model: "gpt-4.1" })).status).toBe(429);
    expect(calls).toBe(0);
  });
  it("keeps tool requests on the original model and never retries provider rejection", async () => {
    const s = store.create("routing", 20);
    const app = createProxy(store, {
      ...cfg,
      routing: {
        mode: "economy",
        allowlist: ["gpt-4o-mini"],
        pinnedModels: [],
      },
    });
    const tools = [
      { type: "function", name: "lookup", parameters: { type: "object" } },
    ];
    const r = await request(app, s.id, { model: "gpt-4.1", tools });
    await r.text();
    expect(upstreamBody.model).toBe("gpt-4.1");
    expect(store.snapshot().events[0].optimization?.routing?.reason).toBe(
      "unsupported-request",
    );
    const failed = await request(app, s.id, {
      model: "gpt-4.1",
      metadata: { fail: true },
    });
    await failed.text();
    expect(failed.status).toBe(401);
    expect(calls).toBe(2);
    expect(upstreamBody.model).toBe("gpt-4o-mini");
  });
  it("authenticates before touching a provider", async () => {
    const app = createProxy(store, cfg);
    expect((await app.request("/control/status")).status).toBe(401);
    expect(calls).toBe(0);
  });
  it("meters non-streaming cached tokens", async () => {
    const s = store.create("test", 20),
      app = createProxy(store, cfg);
    const r = await request(app, s.id);
    expect(r.status).toBe(200);
    await r.text();
    expect(store.snapshot().events[0].cost).toBeCloseTo(0.00325);
    expect(store.snapshot().reserved).toBe(0);
  });
  it("passes the first SSE chunk before provider completion", async () => {
    const s = store.create("test", 20),
      app = createProxy(store, cfg),
      r = await request(app, s.id, { stream: true });
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    while (!(await reader.read()).done) {
      /* Drain the stream to observe final metering. */
    }
    expect(store.snapshot().events[0].estimated).toBe(false);
    expect(store.snapshot().events[0].cost).toBeCloseTo(0.00325);
  });
  it("blocks before spend and reserves across concurrent sessions", async () => {
    const app = createProxy(store, {
        ...cfg,
        policy: { ...defaultPolicy, dailyCap: 0.5 },
      }),
      a = store.create("a", 20),
      b = store.create("b", 20);
    const first = await request(app, a.id, { stream: true });
    const denied = await request(app, b.id, { stream: true });
    expect(denied.status).toBe(429);
    expect(calls).toBe(1);
    await first.text();
  });
  it("charges zero for explicit provider rejection", async () => {
    const s = store.create("test", 20),
      r = await request(createProxy(store, cfg), s.id, {
        metadata: { fail: true },
      });
    expect(r.status).toBe(401);
    await r.text();
    expect(store.snapshot().events[0].cost).toBe(0);
  });
  it("retains conservative spend on interrupted streams", async () => {
    const s = store.create("test", 20),
      app = createProxy(store, cfg),
      r = await request(app, s.id, { stream: true });
    await r.body!.cancel();
    expect(store.snapshot().events[0].estimated).toBe(true);
    expect(store.snapshot().events[0].cost).toBeGreaterThan(0.3);
    expect(store.snapshot().reserved).toBe(0);
  });
  it("persists kills and panic across store reopen", async () => {
    const s = store.create("test", 20),
      app = createProxy(store, cfg);
    await app.request("/control/kill-all", {
      method: "POST",
      headers: { "x-leash-local-token": cfg.token },
    });
    const other = new Store(dir);
    expect(other.snapshot().panic).toBe(true);
    expect(other.get<any>("session", s.id).status).toBe("killed");
    other.db.close();
    expect((await request(app, s.id)).status).toBe(429);
    expect(calls).toBe(0);
  });
  it("keeps prompts and credentials out of SQLite", async () => {
    const s = store.create("test", 20),
      r = await request(createProxy(store, cfg), s.id, {
        input: "TOP_SECRET_PROMPT",
      });
    await r.text();
    expect(JSON.stringify(store.snapshot())).not.toContain("TOP_SECRET_PROMPT");
  });
});

it("meters Anthropic exclusive input and cache buckets through the proxy", async () => {
  const s = store.create("claude", 20),
    app = createProxy(store, cfg);
  const r = await app.request(`/s/${s.id}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-leash-local-token": cfg.token,
      "x-api-key": "test-not-real",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(r.status).toBe(200);
  await r.text();
  expect(store.snapshot().events[0].cost).toBeCloseTo(0.0054, 6);
});
it("manual kill aborts an in-flight stream and prevents its next call", async () => {
  const s = store.create("test", 20),
    app = createProxy(store, cfg),
    r = await request(app, s.id, { stream: true });
  const reader = r.body!.getReader();
  await reader.read();
  await app.request(`/control/sessions/${s.id}/kill`, {
    method: "POST",
    headers: { "x-leash-local-token": cfg.token },
  });
  await expect(reader.read()).rejects.toThrow();
  expect(store.snapshot().events[0].estimated).toBe(true);
  expect((await request(app, s.id)).status).toBe(429);
});

it("kills identical tool loops even when generated call IDs change", async () => {
  const app = createProxy(store, {
      ...cfg,
      policy: { ...defaultPolicy, repeatThreshold: 3 },
    }),
    s = store.create("loop", 20);
  for (let i = 0; i < 2; i++) {
    const r = await request(app, s.id, {
      input: [
        {
          type: "function_call",
          name: "read_file",
          call_id: `call-${i}`,
          arguments: '{"path":"same"}',
        },
      ],
    });
    expect(r.status).toBe(200);
    await r.text();
  }
  expect(
    (
      await request(app, s.id, {
        input: [
          {
            type: "function_call",
            name: "read_file",
            call_id: "new-id",
            arguments: '{"path":"same"}',
          },
        ],
      })
    ).status,
  ).toBe(429);
  expect(calls).toBe(2);
  expect(store.snapshot().kills[0].reason).toBe("loop_repeat");
});
it("preserves an installed session across SessionEnd and merges policy patches", async () => {
  const app = createProxy(store, cfg),
    s = store.create("claude-code", 20);
  store.put("install", "claude-code:/test", { id: s.id });
  const post = (path: string, body = {}) =>
    app.request(`/control/${path}`, {
      method: "POST",
      headers: {
        "x-leash-local-token": cfg.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  await post(`sessions/${s.id}/end`);
  expect(store.get<any>("session", s.id).status).toBe("active");
  await post("policy", { dailyCap: 30 });
  await post("policy", { monthlyCap: 90 });
  expect(store.get("setting", "policy")).toMatchObject({
    dailyCap: 30,
    monthlyCap: 90,
  });
});
it("deduplicates spawn hooks and releases failed tool slots", async () => {
  const app = createProxy(store, cfg),
    s = store.create("claude-code", 20);
  const hook = (event: string) =>
    app.request("/control/hook", {
      method: "POST",
      headers: {
        "x-leash-local-token": cfg.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: s.id,
        event,
        tool: "Agent",
        toolUseId: "tool-1",
      }),
    });
  await hook("pre-tool-use");
  await hook("pre-tool-use");
  expect(store.get<any>("session", s.id).subagents).toBe(1);
  await hook("tool-failed");
  await hook("tool-failed");
  expect(store.get<any>("session", s.id).subagents).toBe(0);
});
it("limits concurrent sessions and expires learning mode after 24 hours", async () => {
  const app = createProxy(store, {
      ...cfg,
      policy: {
        ...defaultPolicy,
        spawnLimit: 1,
        learningMode: true,
        repeatThreshold: 2,
      },
    }),
    s = store.create("a", 20);
  const headers = {
    "x-leash-local-token": cfg.token,
    "content-type": "application/json",
  };
  expect(
    (
      await app.request("/control/sessions", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(429);
  store.put("setting", "learning-start", { ts: Date.now() - 86400001 });
  const r = await request(app, s.id);
  await r.text();
  expect((await request(app, s.id)).status).toBe(429);
});

it("emits real threshold and kill webhook deliveries once per event", async () => {
  const { vi } = await import("vitest");
  const payloads: any[] = [];
  const webhook = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body));
    res.end("ok");
  });
  await new Promise<void>((r) => webhook.listen(0, "127.0.0.1", r));
  process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${(webhook.address() as any).port}`;
  try {
    const s = store.create("threshold", 0.003),
      app = createProxy(store, cfg);
    s.budgetAction = "alert";
    store.put("session", s.id, s);
    const first = await request(app, s.id);
    expect(first.status).toBe(200);
    await first.text();
    await vi.waitFor(() =>
      expect(payloads.some((p) => p.text.includes("100%"))).toBe(true),
    );
    const post = () =>
      app.request(`/control/sessions/${s.id}/kill`, {
        method: "POST",
        headers: { "x-leash-local-token": cfg.token },
      });
    await post();
    await post();
    await vi.waitFor(() =>
      expect(payloads.filter((p) => p.text.includes("killed."))).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().alertsPending).toBe(0));
  } finally {
    delete process.env.SLACK_WEBHOOK_URL;
    webhook.closeAllConnections();
    await new Promise<void>((r) => webhook.close(() => r()));
  }
});

describe("automatic tool optimization under real proxy admission", () => {
  const toolOutput = JSON.stringify(
    Array(100).fill({
      resource_name: "private-tool-value",
      resource_status: "ok",
    }),
    null,
    2,
  );
  const toolInput = [
    { type: "function_call_output", call_id: "call-123", output: toolOutput },
  ];
  it("compresses eligible tools after admission, streams unchanged and meters provider usage", async () => {
    const s = store.create("test", 20);
    const app = createProxy(store, cfg);
    const response = await request(app, s.id, {
      input: toolInput,
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-leash-tool-compression")).toBe("optimized");
    expect(
      Number(response.headers.get("x-leash-tool-chars-saved")),
    ).toBeGreaterThan(0);
    const stream = await response.text();
    expect(stream).toContain("response.completed");
    expect(upstreamBody.input[0].output.length).toBeLessThan(toolOutput.length);
    const snapshot = store.snapshot();
    expect(snapshot.events[0].cost).toBeCloseTo(0.00325);
    expect(snapshot.events[0].estimated).toBe(false);
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.events[0].optimization?.mode).toBe("lossless");
    const metrics = snapshot.events[0].optimization!.observations[0];
    expect(metrics.originalBytes).toBe(Buffer.byteLength(toolOutput));
    expect(metrics.forwardedBytes).toBe(
      Buffer.byteLength(upstreamBody.input[0].output),
    );
    const report = await app.request("/control/token-xray", {
      headers: { "x-leash-local-token": cfg.token },
    });
    const xray = (await report.json()) as any;
    expect(xray.totals.estimatedReducedTokens).toBeGreaterThan(0);
    expect(xray.observedRequests).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("private-tool-value");
  });
  it("respects explicit compression off and records reducible metadata", async () => {
    const s = store.create("test", 20);
    const response = await request(
      createProxy(store, { ...cfg, toolCompression: "off" }),
      s.id,
      {
        input: toolInput,
      },
    );
    await response.text();
    expect(upstreamBody.input[0].output).toBe(toolOutput);
    expect(response.headers.has("x-leash-tool-compression")).toBe(false);
    expect(
      store.snapshot().events[0].optimization?.observations[0]
        .estimatedReducibleTokens,
    ).toBeGreaterThan(0);
  });
  it("still blocks the first upstream request when the full-context reservation cannot fit", async () => {
    const s = store.create("test", 0.01);
    const app = createProxy(store, { ...cfg, toolCompression: "lossless" });
    const response = await request(app, s.id, { input: toolInput });
    expect(response.status).toBe(429);
    expect(calls).toBe(0);
    expect(store.get<Session>("session", s.id)?.status).toBe("killed");
  });
});

it("composes routing, automatic tool compression and metering without routing complex tool traffic", async () => {
  const session = store.create("combined", 100);
  const app = createProxy(store, {
    ...cfg,
    toolCompression: "lossless",
    routing: { mode: "economy", allowlist: ["gpt-4o-mini"], pinnedModels: [] },
  });
  const instructions = "Preserve every record and return the exact status.";
  const output = JSON.stringify(
    Array(100).fill({ name: "resource", status: "ok" }),
    null,
    2,
  );
  const first = await request(app, session.id, {
    model: "gpt-4o",
    input: "Reply hello",
  });
  expect(first.status).toBe(200);
  await first.text();
  expect(upstreamBody.model).toBe("gpt-4o-mini");
  const second = await request(app, session.id, {
    model: "gpt-4o",
    instructions,
    input: [{ type: "function_call_output", call_id: "test", output }],
    stream: true,
  });
  expect(second.status).toBe(200);
  await second.text();
  expect(upstreamBody.model).toBe("gpt-4o");
  expect(upstreamBody.instructions).toBe(instructions);
  expect(upstreamBody.input[0].output.length).toBeLessThan(output.length);
  const events = store.snapshot().events;
  expect(events).toHaveLength(2);
  expect(events.some((e) => e.optimization?.routing?.changed === true)).toBe(
    true,
  );
  expect(
    events.some((e) => e.optimization?.observations[0]?.reason === "optimized"),
  ).toBe(true);
  expect(store.snapshot().reserved).toBe(0);
  expect(calls).toBe(2);
});
