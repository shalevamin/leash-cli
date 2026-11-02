import { canonical } from "./fingerprint.js";
/** Count consecutive identical logged tool operations. This is a signal, not proof of a loop. */
export function longestToolRepeat(
  text: string,
  source: "claude-code" | "codex",
  since = 0,
): number {
  const seen = new Set<string>(),
    runs = new Map<string, { fingerprint: string; count: number }>();
  let longest = 0,
    session = "unknown";
  for (const line of text.split("\n")) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    if (r.type === "session_meta") session = r.payload?.id ?? session;
    if (r.sessionId) session = r.sessionId;
    if (since && !(Date.parse(r.timestamp) >= since)) continue;
    const calls =
      source === "claude-code" &&
      r.type === "assistant" &&
      Array.isArray(r.message?.content)
        ? r.message.content.filter((v: any) => v?.type === "tool_use")
        : source === "codex" &&
            r.type === "response_item" &&
            r.payload?.type === "function_call"
          ? [r.payload]
          : [];
    for (const call of calls) {
      const id = call.id ?? call.call_id;
      if (id && seen.has(`${session}:${id}`)) continue;
      if (id) seen.add(`${session}:${id}`);
      let args = call.input ?? call.arguments;
      try {
        if (typeof args === "string") args = JSON.parse(args);
      } catch {}
      const fingerprint = canonical({ name: call.name, args }),
        prev = runs.get(session),
        count = prev?.fingerprint === fingerprint ? prev.count + 1 : 1;
      runs.set(session, { fingerprint, count });
      longest = Math.max(longest, count);
    }
  }
  return longest;
}
