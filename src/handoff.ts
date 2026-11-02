import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assessConversation,
  createHandoff,
  continuationPrompt,
  type Conversation,
} from "./core/index.js";
import { Store, type Session, type Event } from "./state.js";
import { config } from "./config.js";
export function handoff(
  id: string | undefined,
  options: {
    output?: string;
    goal?: string;
    completed?: string;
    decisions?: string;
    next?: string;
    json?: boolean;
  },
) {
  const store = new Store(config().dir);
  try {
    const sessions = store
      .all<Session>("session")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const session = id ? sessions.find((s) => s.id === id) : sessions[0];
    if (!session)
      throw new Error(
        "No matching session. Start an agent with leash run first.",
      );
    const event = store
      .all<Event>("event")
      .filter((e) => e.sessionId === session.id && !e.estimated)
      .sort((a, b) => b.ts.localeCompare(a.ts))[0];
    const input: Conversation = {
      ...session,
      latestInputTokens: event
        ? event.usage.input + event.usage.cacheRead + event.usage.cacheWrite
        : undefined,
    };
    if (options.json) {
      console.log(
        JSON.stringify(
          { session: input, recommendation: assessConversation(input) },
          null,
          2,
        ),
      );
      return;
    }
    const path = resolve(options.output ?? "HANDOFF.md");
    writeFileSync(path, createHandoff(input, options), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `Saved ${path}\n${assessConversation(input).title}\n\nFill in the handoff, end the old agent, then start a new conversation through leash run.\n\n${continuationPrompt(path)}`,
    );
  } finally {
    store.db.close();
  }
}
