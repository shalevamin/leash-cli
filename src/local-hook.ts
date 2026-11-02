// Entry point for agent hooks installed by `leash hooks install`. It reads the
// hook payload on stdin and prints the agent's native block response. Any error
// allows the action: hooks fail open.
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentDecision, localDir, type Decision } from "./local-state.js";

export type HookTool = "claude" | "codex" | "cursor";
export type HookEvent = "prompt" | "tool" | "usage";

/** The JSON each agent expects on stdout, or undefined to allow silently. */
export function hookResponse(
  tool: HookTool,
  event: HookEvent,
  decision: Decision,
): object | undefined {
  if (event === "usage") return tool === "cursor" ? {} : undefined;
  if (!decision.block) return tool === "cursor" ? {} : undefined;
  const message = decision.message ?? "Leash stopped this agent.";
  if (tool === "cursor")
    return event === "prompt"
      ? { continue: false, user_message: message }
      : { permission: "deny", user_message: message, agent_message: message };
  // Prompt blocking is shared; Codex rejects Claude's PreToolUse stop fields.
  return event === "prompt"
    ? { decision: "block", reason: message }
    : {
        ...(tool === "claude" ? { continue: false, stopReason: message } : {}),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      };
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
/** Cursor afterAgentResponse: keep ids, model and token counts; drop the response text. */
export function cursorUsageLine(input: any, now = new Date()) {
  const tokens = {
    input: count(input?.input_tokens),
    output: count(input?.output_tokens),
    cacheRead: count(input?.cache_read_tokens),
    cacheWrite: count(input?.cache_write_tokens),
  };
  if (Object.values(tokens).every((v) => v === undefined)) return undefined;
  if (
    typeof input.conversation_id !== "string" ||
    typeof input.generation_id !== "string"
  )
    return undefined;
  return {
    v: 1,
    conversationId: input.conversation_id.slice(0, 200),
    generationId: input.generation_id.slice(0, 200),
    model:
      typeof input.model === "string" ? input.model.slice(0, 200) : "unknown",
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    ts: now.toISOString(),
  };
}
export function cursorSpoolDir() {
  return join(localDir(), "cursor-spool");
}

export async function runHook(argv: string[]) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const [tool, event] = args as [HookTool, HookEvent];
  if (!["claude", "codex", "cursor"].includes(tool)) return;
  if (!["prompt", "tool", "usage"].includes(event)) return;
  let input: any = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {}
  if (event === "usage") {
    const line = tool === "cursor" ? cursorUsageLine(input) : undefined;
    if (line) {
      mkdirSync(cursorSpoolDir(), { recursive: true, mode: 0o700 });
      appendFileSync(
        join(cursorSpoolDir(), `usage-${line.ts.slice(0, 7)}.jsonl`),
        JSON.stringify(line) + "\n",
        { mode: 0o600 },
      );
    }
    const out = hookResponse(tool, event, { block: false, source: "cache" });
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  const out = hookResponse(tool, event, await currentDecision());
  if (out) process.stdout.write(JSON.stringify(out));
}
if (process.argv[1] && /local-hook\.js$/.test(process.argv[1])) {
  // Never hold the agent longer than this, whatever happens.
  setTimeout(() => process.exit(0), 3000).unref();
  runHook(process.argv.slice(2)).catch(() => {});
}
