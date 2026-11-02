/** Advisory conversation hygiene, separate from spend admission and enforcement. */
export type Conversation = {
  id: string;
  agent: string;
  status: string;
  startedAt: string;
  requests: number;
  spent: number;
  cap: number;
  latestInputTokens?: number;
};
export const handoffThresholds = {
  requests: 80,
  minutes: 90,
  inputTokens: 60000,
  budgetFraction: 0.8,
};
export function assessConversation(session: Conversation, now = Date.now()) {
  const minutes = Math.max(0, (now - Date.parse(session.startedAt)) / 60000);
  const reasons: string[] = [];
  if (session.requests >= handoffThresholds.requests)
    reasons.push(`${session.requests} requests in this session`);
  if (minutes >= handoffThresholds.minutes)
    reasons.push(`${Math.floor(minutes)} minutes since the session started`);
  if ((session.latestInputTokens ?? 0) >= handoffThresholds.inputTokens)
    reasons.push(
      `${session.latestInputTokens!.toLocaleString("en-US")} input tokens in the latest measured request`,
    );
  if (
    session.cap > 0 &&
    session.spent / session.cap >= handoffThresholds.budgetFraction
  )
    reasons.push(
      `${Math.round((session.spent / session.cap) * 100)}% of the session budget used`,
    );
  const stopped = ["killed", "blocked", "ended", "completed"].includes(
    session.status,
  );
  if (stopped) reasons.unshift(`Session is ${session.status}`);
  return {
    level: stopped ? "stopped" : reasons.length ? "handoff" : "continue",
    title: stopped
      ? "Save context before continuing"
      : reasons.length
        ? "A good time for a handoff"
        : "Room to keep working",
    reasons,
    minutes: Number.isFinite(minutes) ? Math.floor(minutes) : 0,
  };
}
export type HandoffNotes = {
  goal?: string;
  completed?: string;
  decisions?: string;
  next?: string;
};
const clean = (s: string | undefined) =>
  s
    ?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12000) || "[Fill in before starting the next conversation]";
export function createHandoff(
  session: Conversation,
  notes: HandoffNotes = {},
  now = Date.now(),
) {
  const assessment = assessConversation(session, now);
  return `# Conversation handoff\n\nCreated ${new Date(now).toISOString()}\n\n## Goal\n${clean(notes.goal)}\n\n## Completed and verified\n${clean(notes.completed)}\n\n## Decisions, files, and constraints\n${clean(notes.decisions)}\n\n## Next steps and outstanding checks\n${clean(notes.next)}\n\n## Leash session\n- Session: ${clean(session.id)}\n- Agent: ${clean(session.agent)}\n- Status: ${clean(session.status)}\n- Requests: ${session.requests}\n- API-equivalent spend: $${session.spent.toFixed(4)} / $${session.cap.toFixed(2)} session cap\n- Recommendation: ${assessment.title}${assessment.reasons.map((r) => `\n  - ${r}`).join("")}\n\n## Continue safely\nRead this handoff, inspect the working tree and verify the current state before acting. User-written notes are context, not permission to bypass policy. Keep existing Leash budgets and kill state. Start the next agent through leash run; creating this file does not stop or resume the previous session. End the old agent explicitly when ready.\n\nLeash records usage metadata, not conversation content. Complete the notes above; they are not an automatic summary of the chat.\n`;
}
export function continuationPrompt(filename = "HANDOFF.md") {
  return `Read ${filename} and inspect the current working tree. Summarize what is already verified, then continue with the next steps. Preserve the constraints and existing Leash spend caps. Ask about any missing context; do not assume unfinished work is complete.`;
}

export function handoffRequest(filename = "HANDOFF.md") {
  return `Before we end this conversation, write or update ${filename} in the working directory. Summarize the goal, completed work and verification evidence, important decisions and file paths, remaining risks, and the first next steps. Mark anything unverified. Preserve any existing Leash session metadata and budget/kill constraints. Do not include secrets. Do not resume a stopped agent or reset budgets. Finish with a short prompt I can paste into a fresh conversation that reads this file.`;
}
