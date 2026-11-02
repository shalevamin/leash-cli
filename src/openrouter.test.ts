import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  cost,
  defaultPolicy,
  normalizeUsage,
  reserveCost,
} from "./core/index.js";
import { Store } from "./state.js";
import { createProxy } from "./proxy.js";

let dir: string, store: Store, server: Server, calls: number;
let upstreamBody: any,
  upstreamPath: string | undefined,
  upstreamAuth: string | undefined;
let reportedCost: number | undefined,
  upstreamStatus: number,
  incomplete: boolean;
const model = "openai/gpt-4.1-mini";
const cfg = {
  dir: "",
  path: "",
  token: "test-openrouter-control",
  port: 8787,
  policy: defaultPolicy,
  prices: {},
};
const usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
  completion_tokens_details: { reasoning_tokens: 60 },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "leash-openrouter-"));
  store = new Store(dir);
  calls = 0;
  reportedCost = undefined;
  upstreamStatus = 200;
  incomplete = false;
  upstreamBody = undefined;
  upstreamPath = undefined;
  upstreamAuth = undefined;
  server = createServer(async (req, res) => {
    calls++;
    upstreamPath = req.url;
    upstreamAuth = req.headers.authorization;
    let text = "";
    for await (const chunk of req) text += chunk;
    upstreamBody = JSON.parse(text);
    const reply = {
      model,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Mock response" },
        },
      ],
      usage: {
        ...(incomplete ? {} : usage),
        ...(reportedCost === undefined ? {} : { cost: reportedCost }),
      },
    };
    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Mock provider rejected" } }));
    } else if (upstreamBody.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        ': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Mock "}}]}\n\n',
      );
      res.end(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.LEASH_OPENROUTER_UPSTREAM = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
afterEach(async () => {
  delete process.env.LEASH_OPENROUTER_UPSTREAM;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function request(
  app: ReturnType<typeof createProxy>,
  id: string,
  change: object = {},
  endpoint = "chat/completions",
) {
  return app.request(`/s/${id}/openrouter/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-leash-local-token": cfg.token,
      authorization: "Bearer mock-provider-only",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "PRIVATE_MOCK_PROMPT" }],
      max_tokens: 100,
      ...change,
    }),
  });
}

describe("OpenRouter real proxy with a loopback-only mock provider", () => {
  it.each([false, true])(
    "meters text chat (stream=%s), clamps provider prices and stores no prompt",
    async (stream) => {
      const app = createProxy(store, cfg),
        session = store.create("router", 20);
      const response = await request(app, session.id, {
        stream,
        provider: {
          only: ["openai"],
          allow_fallbacks: true,
          require_parameters: false,
          max_price: { prompt: 999, completion: 0.8, request: 9 },
        },
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toBe(1);
      expect(upstreamPath).toBe("/api/v1/chat/completions");
      expect(upstreamAuth).toBe("Bearer mock-provider-only");
      expect(upstreamBody.provider).toMatchObject({
        only: ["openai"],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: 0.4, completion: 0.8, request: 0, image: 0 },
      });
      const event = store.snapshot().events[0];
      expect(event).toMatchObject({
        provider: "openrouter",
        model,
        estimated: false,
        usage: {
          input: 500,
          cacheRead: 200,
          cacheWrite: 300,
          output: 100,
          reasoning: 60,
        },
      });
      expect(event.cost).toBe(cost(model, normalizeUsage(usage)));
      expect(JSON.stringify(event)).not.toContain("PRIVATE_MOCK_PROMPT");
      expect(JSON.stringify(event)).not.toContain("mock-provider-only");
    },
  );
  it("preserves max_completion_tokens intent as one canonical output limit", async () => {
    const app = createProxy(store, cfg),
      session = store.create("router", 20);
    const response = await request(app, session.id, {
      max_tokens: undefined,
      max_completion_tokens: 90,
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(upstreamBody.max_tokens).toBe(90);
    expect(upstreamBody).not.toHaveProperty("max_completion_tokens");
    expect(
      (await request(app, session.id, { max_completion_tokens: 90 })).status,
    ).toBe(400);
    expect(calls).toBe(1);
  });
  it("uses reported router account charges as a conservative floor, never a discount", async () => {
    const app = createProxy(store, cfg),
      session = store.create("router", 20);
    reportedCost = 0.0123;
    await (await request(app, session.id, { stream: true })).text();
    expect(store.snapshot().events[0].cost).toBe(0.0123);
    reportedCost = 0;
    await (await request(app, session.id)).text();
    expect(
      store
        .snapshot()
        .events.map((event) => event.cost)
        .sort(),
    ).toEqual([cost(model, normalizeUsage(usage)), 0.0123].sort());
  });
  it("retains a full reservation when accounting is incomplete", async () => {
    incomplete = true;
    reportedCost = 0.001;
    const app = createProxy(store, cfg),
      session = store.create("router", 20);
    await (await request(app, session.id, { stream: true })).text();
    expect(store.snapshot().events[0]).toMatchObject({
      estimated: true,
      cost: reserveCost(model, { max_tokens: 100 }),
    });
  });
  it("rejects budgets, manual kills and missing local authentication before network calls", async () => {
    const app = createProxy(store, cfg);
    const low = store.create("low", 0.001),
      killed = store.create("killed", 20);
    store.kill(killed.id, "manual");
    expect((await request(app, low.id)).status).toBe(429);
    expect((await request(app, killed.id)).status).toBe(429);
    expect(
      (
        await app.request(`/s/${killed.id}/openrouter/v1/chat/completions`, {
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(calls).toBe(0);
  });
  it("blocks unknown prices, fallbacks, plugins, caches and billing extensions before admission", async () => {
    const app = createProxy(store, cfg),
      session = store.create("router", 20);
    for (const change of [
      { model: "unknown/future-model" },
      { model: `${model}:online` },
      { plugins: [{ id: "web" }] },
      { models: [model] },
      { preset: "hidden" },
      { reasoning: { mode: "pro" } },
      { service_tier: "priority" },
      { n: 2 },
      { provider: { future_extension: true } },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "x", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "x",
                prompt_cache_breakpoint: { mode: "explicit" },
              },
            ],
          },
        ],
      },
      {
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: {} },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
      expect(
        (await request(app, session.id, change)).status,
        JSON.stringify(change),
      ).toBe(400);
    expect(calls).toBe(0);
    expect(store.snapshot().events).toHaveLength(0);
  });
  it("does not send OpenRouter traffic to a hosted gateway or retry failed calls", async () => {
    const session = store.create("router", 20);
    const app = createProxy(store, {
      ...cfg,
      gateway: {
        url: process.env.LEASH_OPENROUTER_UPSTREAM!,
        token: "mock-scoped-key",
        keyId: "mock-key",
      } as any,
    });
    expect((await request(app, session.id)).status).toBe(400);
    expect(calls).toBe(0);
    const local = createProxy(store, cfg);
    expect((await request(local, session.id, {}, "responses")).status).toBe(
      400,
    );
    upstreamStatus = 503;
    const response = await request(local, session.id);
    await response.text();
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });
});
