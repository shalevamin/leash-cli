import { it, expect } from "vitest";
import { createServer } from "node:http";
import { alert } from "./alerts.js";
it("delivers correct Slack and Discord payloads and respects offline mode", async () => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SLACK_WEBHOOK_URL = url;
  process.env.DISCORD_WEBHOOK_URL = url;
  try {
    await alert("Leash test");
    expect(received).toContainEqual({ text: "Leash test" });
    expect(received).toContainEqual({ content: "Leash test" });
    process.env.LEASH_OFFLINE = "1";
    await alert("must not send");
    expect(received).toHaveLength(2);
  } finally {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.LEASH_OFFLINE;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("retains failed deliveries across restart and deduplicates successful retries", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("./state.js");
  const { queueAlert, flushAlerts } = await import("./alerts.js");
  const { vi } = await import("vitest");
  const dir = mkdtempSync(join(tmpdir(), "leash-alert-"));
  let store = new Store(dir);
  process.env.SLACK_WEBHOOK_URL = "http://unused.test";
  const send = vi.fn(async () => new Response("", { status: 500 }));
  vi.stubGlobal("fetch", send);
  try {
    queueAlert(store, "kill-1", "Leash paused session");
    await vi.waitFor(() =>
      expect(store.all<any>("delivery")[0].attempts).toBe(1),
    );
    expect(store.snapshot().alertsPending).toBe(1);
    store.db.close();
    store = new Store(dir);
    const pending = store.all<any>("delivery")[0];
    pending.next = 0;
    store.put("delivery", pending.id, pending);
    send.mockImplementation(async () => new Response("", { status: 200 }));
    await flushAlerts(store);
    queueAlert(store, "kill-1", "Leash paused session");
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.snapshot().alertsPending).toBe(0);
    expect(JSON.stringify(store.all("delivery"))).not.toContain("unused.test");
  } finally {
    vi.unstubAllGlobals();
    delete process.env.SLACK_WEBHOOK_URL;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
