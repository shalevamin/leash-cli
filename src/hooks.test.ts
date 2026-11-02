import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mergeHooks,
  removeHooks,
  leashEntries,
  hookCommand,
  installHooks,
  uninstallHooks,
  configPath,
} from "./hooks.js";
import { hookResponse, cursorUsageLine } from "./local-hook.js";
import {
  currentDecision,
  writeCachedState,
  blockMessage,
  HOOK_MARKER,
  FRESH_MS,
  BLOCK_GRACE_MS,
  type WorkspaceState,
} from "./local-state.js";

// The shape of the user's real ~/.claude/settings.json hooks (October 2026).
const claudeSettings = {
  effortLevel: "high",
  hooks: {
    PreToolUse: [
      {
        matcher: "Grep|Glob",
        hooks: [
          {
            type: "command",
            command: "~/.claude/hooks/cbm-code-discovery-gate",
            timeout: 5,
          },
        ],
      },
    ],
    SessionStart: ["startup", "resume", "clear", "compact"].map((matcher) => ({
      matcher,
      hooks: [
        { type: "command", command: "~/.claude/hooks/cbm-session-reminder" },
      ],
    })),
    SubagentStart: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "~/.claude/hooks/cbm-subagent-reminder" },
        ],
      },
    ],
  },
  theme: "dark",
};
const codexHooks = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Write|Edit|Bash",
        hooks: [
          {
            type: "command",
            command: "code-review-graph update || true",
            timeout: 30,
            statusMessage: "Updating",
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          { type: "command", command: "code-review-graph status", timeout: 10 },
        ],
      },
    ],
  },
};
const cursorHooks = {
  version: 1,
  hooks: {
    afterFileEdit: [{ command: "/u/.cursor/hooks/crg-update.sh", timeout: 5 }],
    sessionStart: [
      { command: "/u/.cursor/hooks/crg-session-start.sh", timeout: 5 },
    ],
    beforeShellExecution: [
      {
        matcher: "^git\\s+commit",
        command: "/u/.cursor/hooks/crg-pre-commit.sh",
        timeout: 10,
      },
    ],
  },
};
const command = (tool: string, event: string) =>
  `node hook.js ${HOOK_MARKER} ${tool} ${event}`;

describe("merging hook configs", () => {
  it("adds Leash hooks without touching the user's hooks", () => {
    const { data, createdEvents } = mergeHooks(
      "claude",
      claudeSettings,
      leashEntries("claude", command),
    );
    expect(data.hooks.PreToolUse[0]).toEqual(
      claudeSettings.hooks.PreToolUse[0],
    );
    expect(data.hooks.PreToolUse[1]).toEqual({
      matcher: "*",
      hooks: [
        { type: "command", command: command("claude", "tool"), timeout: 5 },
      ],
    });
    expect(data.hooks.SessionStart).toEqual(claudeSettings.hooks.SessionStart);
    expect(data.hooks.SubagentStart).toEqual(
      claudeSettings.hooks.SubagentStart,
    );
    expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      command("claude", "prompt"),
    );
    expect(createdEvents).toEqual(["UserPromptSubmit"]);
    expect(data.effortLevel).toBe("high");
    expect(claudeSettings.hooks.PreToolUse).toHaveLength(1);
  });
  it("is idempotent: re-merging never duplicates Leash hooks", () => {
    const once = mergeHooks(
      "codex",
      codexHooks,
      leashEntries("codex", command),
    ).data;
    const twice = mergeHooks(
      "codex",
      once,
      leashEntries("codex", command),
    ).data;
    expect(twice).toEqual(once);
    expect(once.hooks.PreToolUse).toEqual([
      {
        hooks: [
          { type: "command", command: command("codex", "tool"), timeout: 5 },
        ],
      },
    ]);
  });
  it("uses Cursor's flat hook shape", () => {
    const { data } = mergeHooks(
      "cursor",
      cursorHooks,
      leashEntries("cursor", command),
    );
    expect(data.version).toBe(1);
    expect(Object.keys(data.hooks)).toEqual([
      "afterFileEdit",
      "sessionStart",
      "beforeShellExecution",
      "beforeSubmitPrompt",
      "preToolUse",
      "afterAgentResponse",
    ]);
    expect(data.hooks.beforeShellExecution).toEqual(
      cursorHooks.hooks.beforeShellExecution,
    );
  });
  it("removes exactly what it added", () => {
    for (const [tool, original] of [
      ["claude", claudeSettings],
      ["codex", codexHooks],
      ["cursor", cursorHooks],
    ] as const) {
      const merged = mergeHooks(tool, original, leashEntries(tool, command));
      expect(removeHooks(tool, merged.data, merged)).toEqual(original);
    }
  });
  it("refuses unexpected shapes instead of guessing", () => {
    expect(() => mergeHooks("claude", { hooks: [] })).toThrow(
      /nothing was changed/,
    );
    expect(() => mergeHooks("claude", { hooks: { PreToolUse: {} } })).toThrow(
      /nothing was changed/,
    );
  });
});

describe("installing on disk", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leash-hooks-"));
    process.env.LEASH_HOME = join(root, ".leash");
  });
  it("backs up, installs and restores the original bytes", () => {
    const path = configPath("claude", root);
    mkdirSync(join(root, ".claude"));
    const original = JSON.stringify(claudeSettings, null, 4) + "\n";
    writeFileSync(path, original, { mode: 0o644 });
    const r = installHooks("claude", root);
    expect(readFileSync(r.backup!, "utf8")).toBe(original);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(installed)).toContain(HOOK_MARKER);
    installHooks("claude", root);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(installed);
    uninstallHooks("claude", root);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  it("keeps changes the user made after install", () => {
    const path = configPath("cursor", root);
    mkdirSync(join(root, ".cursor"));
    writeFileSync(path, JSON.stringify(cursorHooks));
    installHooks("cursor", root);
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.hooks.stop = [{ command: "/u/new-hook.sh" }];
    edited.hooks.preToolUse.unshift({ command: "/u/guard.sh" });
    writeFileSync(path, JSON.stringify(edited));
    uninstallHooks("cursor", root);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.stop).toEqual([{ command: "/u/new-hook.sh" }]);
    expect(after.hooks.preToolUse).toEqual([{ command: "/u/guard.sh" }]);
    expect(after.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(HOOK_MARKER);
  });
  it("creates a missing config and removes it again", () => {
    const path = configPath("codex", root);
    installHooks("codex", root);
    expect(existsSync(path)).toBe(true);
    uninstallHooks("codex", root);
    expect(existsSync(path)).toBe(false);
  });
  it("leaves a malformed config untouched and makes no backup", () => {
    const path = configPath("claude", root);
    mkdirSync(join(root, ".claude"));
    writeFileSync(path, "{ not json");
    expect(() => installHooks("claude", root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    expect(readdirSync(join(root, ".claude"))).toEqual(["settings.json"]);
  });
});

function state(over: Partial<WorkspaceState> = {}): WorkspaceState {
  const budget = {
    period: "day" as const,
    spentUsd: 1,
    reservedUsd: 0,
    capUsd: 100,
    action: "block",
    exhausted: false,
  };
  return {
    killed: false,
    blocked: false,
    reason: null,
    daily: budget,
    monthly: { ...budget, period: "month", capUsd: 1000 },
    checkedAt: new Date().toISOString(),
    ...over,
  };
}
const killed = () =>
  state({ killed: true, blocked: true, reason: "workspace_killed" });

describe("blocking decisions", () => {
  beforeEach(() => {
    process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), "leash-decide-"));
  });
  it("uses a fresh cache without calling the API", async () => {
    writeCachedState(killed(), 1_000_000);
    const d = await currentDecision(1_000_000 + FRESH_MS - 1, async () => {
      throw new Error("must not fetch");
    });
    expect(d).toMatchObject({ block: true, source: "cache" });
  });
  it("refreshes a stale cache and stores the answer", async () => {
    writeCachedState(killed(), 0);
    const d = await currentDecision(FRESH_MS + 1, async () => state());
    expect(d).toEqual({ block: false, source: "api" });
    expect(
      (await currentDecision(FRESH_MS + 2, async () => killed())).source,
    ).toBe("cache");
  });
  it("fails open on an outage, but honours a recent confirmed block", async () => {
    const down = async () => {
      throw new Error("timeout");
    };
    expect(await currentDecision(10 ** 9, down)).toEqual({
      block: false,
      source: "fail-open",
    });
    writeCachedState(killed(), 0);
    expect(await currentDecision(BLOCK_GRACE_MS - 1, down)).toMatchObject({
      block: true,
      source: "stale-block",
    });
    expect(await currentDecision(BLOCK_GRACE_MS + 1, down)).toEqual({
      block: false,
      source: "fail-open",
    });
  });
  it("allows when not signed in to Leash", async () => {
    expect(await currentDecision(0, async () => undefined)).toEqual({
      block: false,
      source: "signed-out",
    });
  });
  it("explains budget blocks with exact amounts", () => {
    const s = state({
      blocked: true,
      reason: "daily_budget",
      daily: {
        period: "day",
        spentUsd: 100.5,
        reservedUsd: 0,
        capUsd: 100,
        action: "block",
        exhausted: true,
      },
    });
    expect(blockMessage(s)).toBe(
      "Leash stopped this agent: the workspace daily budget of $100.00 is used ($100.50 metered spend). Raise the budget in the Leash dashboard at https://useleash.dev or wait for the next day.",
    );
  });
});

describe("hook responses", () => {
  const block = { block: true, message: "stop", source: "api" as const };
  const allow = { block: false, source: "api" as const };
  const deny = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "stop",
    },
  };
  it.each([
    ["claude", "prompt", { decision: "block", reason: "stop" }],
    ["claude", "tool", { continue: false, stopReason: "stop", ...deny }],
    ["codex", "prompt", { decision: "block", reason: "stop" }],
    ["codex", "tool", deny],
    ["cursor", "prompt", { continue: false, user_message: "stop" }],
    [
      "cursor",
      "tool",
      { permission: "deny", user_message: "stop", agent_message: "stop" },
    ],
  ] as const)(
    "%s %s emits the exact native deny shape",
    (tool, event, expected) => {
      expect(hookResponse(tool, event, block)).toEqual(expected);
    },
  );
  it("never emits unsupported Codex PreToolUse fields", () => {
    const response = hookResponse("codex", "tool", block);
    for (const field of ["continue", "stopReason", "suppressOutput"])
      expect(response).not.toHaveProperty(field);
  });
  it("never grants permissions when allowing", () => {
    expect(hookResponse("claude", "tool", allow)).toBeUndefined();
    expect(hookResponse("codex", "prompt", allow)).toBeUndefined();
    expect(hookResponse("cursor", "tool", allow)).toEqual({});
    expect(hookResponse("cursor", "usage", block)).toEqual({});
  });
  it("keeps only ids, model and counts from Cursor responses", () => {
    const line = cursorUsageLine(
      {
        conversation_id: "c1",
        generation_id: "g1",
        model: "claude-sonnet-4-6",
        text: "RESPONSE TEXT",
        user_email: "someone@example.test",
        input_tokens: 10,
        output_tokens: 5,
      },
      new Date("2026-10-18T00:00:00Z"),
    );
    expect(line).toEqual({
      v: 1,
      conversationId: "c1",
      generationId: "g1",
      model: "claude-sonnet-4-6",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      ts: "2026-10-18T00:00:00.000Z",
    });
    expect(
      cursorUsageLine({ conversation_id: "c", generation_id: "g", text: "x" }),
    ).toBeUndefined();
  });
});

describe("hook command node path", () => {
  it("invokes node through a stable path, never a versioned install directory", async () => {
    const { nodeCommand } = await import("./node-path.js");
    const cmd = hookCommand("claude", "tool");
    expect(cmd.startsWith(nodeCommand() + " ")).toBe(true);
    expect(cmd).not.toMatch(/\/Cellar\//);
  });
});
