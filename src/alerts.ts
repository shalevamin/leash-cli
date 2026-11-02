import type { Store } from "./state.js";
const channels = ["SLACK_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"] as const;
type Delivery = {
  id: string;
  channel: string;
  text: string;
  attempts: number;
  next: number;
  delivered: boolean;
};
export function alertPayload(channel: string, text: string) {
  const id = text.match(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/,
  )?.[0];
  return channel !== "SLACK_WEBHOOK_URL"
    ? { content: text }
    : {
        text,
        ...(id &&
        process.env.SLACK_SIGNING_SECRET &&
        process.env.LEASH_SLACK_USERS
          ? {
              blocks: [
                { type: "section", text: { type: "plain_text", text } },
                {
                  type: "actions",
                  elements: [
                    ["leash_resume", "Resume"],
                    ["leash_add10", "Resume +$10"],
                    ["leash_kill", "Keep killed"],
                  ].map(([action_id, label]) => ({
                    type: "button",
                    action_id,
                    value: id,
                    text: { type: "plain_text", text: label },
                  })),
                },
              ],
            }
          : {}),
      };
}
function webhook(channel: string, store?: Store) {
  // Legacy encrypted database webhook records are not supported in the CLI.
  // Preserve an existing record's disabled state; do not fall back to another URL.
  if (store?.get("webhook", channel)) return undefined;
  return process.env[channel];
}
async function deliver(channel: string, text: string, store?: Store) {
  try {
    const url = webhook(channel, store);
    if (!url) return false;
    return (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alertPayload(channel, text)),
        signal: AbortSignal.timeout(5000),
      })
    ).ok;
  } catch {
    return false;
  }
}
export async function alert(text: string) {
  if (process.env.LEASH_OFFLINE === "1") return;
  await Promise.all(
    channels.map(async (channel) => {
      if (!process.env[channel]) return;
      for (let i = 0; i < 3; i++) if (await deliver(channel, text)) return;
    }),
  );
}
export function queueAlert(store: Store, key: string, text: string) {
  if (process.env.LEASH_OFFLINE === "1") return;
  for (const channel of channels) {
    const id = `${key}:${channel}`;
    if (webhook(channel, store) && !store.get("delivery", id))
      store.put("delivery", id, {
        id,
        channel,
        text,
        attempts: 0,
        next: 0,
        delivered: false,
      } satisfies Delivery);
  }
  void flushAlerts(store);
}
const flushing = new WeakSet<Store>();
export async function flushAlerts(store: Store) {
  if (flushing.has(store) || process.env.LEASH_OFFLINE === "1") return;
  flushing.add(store);
  try {
    for (let count = 0; count < 50; count++) {
      const d = store
        .all<Delivery>("delivery")
        .find((d) => !d.delivered && d.next <= Date.now());
      if (!d) break;
      d.delivered = await deliver(d.channel, d.text, store);
      d.attempts++;
      d.next =
        Date.now() + Math.min(300000, 1000 * 2 ** Math.min(d.attempts, 9));
      store.put("delivery", d.id, d);
    }
  } finally {
    flushing.delete(store);
  }
}
