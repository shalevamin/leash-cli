import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HOOK_MARKER, localDir } from "./local-state.js";
import { nodeCommand } from "./node-path.js";

export type HookTarget = "claude" | "codex" | "cursor";
export const hookTargets: HookTarget[] = ["claude", "codex", "cursor"];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function hookCommand(tool: HookTarget, event: string) {
  // Prefer the standalone hook in source builds and releases; support older bundles.
  const entry = fileURLToPath(new URL("./local-hook.js", import.meta.url));
  const target = existsSync(entry)
    ? quote(entry)
    : `${quote(fileURLToPath(new URL("./index.js", import.meta.url)))} local-hook`;
  return `${nodeCommand()} ${target} ${HOOK_MARKER} ${tool} ${event}`;
}
export function configPath(tool: HookTarget, root = homedir()) {
  return tool === "claude"
    ? join(root, ".claude", "settings.json")
    : tool === "codex"
      ? join(root, ".codex", "hooks.json")
      : join(root, ".cursor", "hooks.json");
}
const TIMEOUT = 5;
/** Leash's hook groups per agent event, in each agent's own config shape. */
export function leashEntries(
  tool: HookTarget,
  command = hookCommand,
): Record<string, any[]> {
  if (tool === "cursor")
    return {
      beforeSubmitPrompt: [
        { command: command(tool, "prompt"), timeout: TIMEOUT },
      ],
      preToolUse: [{ command: command(tool, "tool"), timeout: TIMEOUT }],
      afterAgentResponse: [
        { command: command(tool, "usage"), timeout: TIMEOUT },
      ],
    };
  const handler = (event: string) => ({
    type: "command",
    command: command(tool, event),
    timeout: TIMEOUT,
  });
  return {
    UserPromptSubmit: [{ hooks: [handler("prompt")] }],
    // Claude treats "*" as every tool; Codex matches every tool when the matcher is absent.
    PreToolUse: [
      tool === "claude"
        ? { matcher: "*", hooks: [handler("tool")] }
        : { hooks: [handler("tool")] },
    ],
  };
}
const isLeash = (command: unknown) =>
  typeof command === "string" && command.includes(HOOK_MARKER);
/** Removes only Leash handlers; groups the user owns keep their other handlers. */
function withoutLeash(tool: HookTarget, groups: unknown): any[] {
  if (!Array.isArray(groups)) return [];
  if (tool === "cursor") return groups.filter((h) => !isLeash(h?.command));
  return groups
    .map((g) =>
      Array.isArray(g?.hooks)
        ? { ...g, hooks: g.hooks.filter((h: any) => !isLeash(h?.command)) }
        : g,
    )
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
}
export type HookManifest = {
  tool: HookTarget;
  path: string;
  createdFile: boolean;
  createdHooksKey: boolean;
  createdEvents: string[];
  backup: string | null;
  installedAt: string;
};
export function mergeHooks(
  tool: HookTarget,
  data: any,
  entries = leashEntries(tool),
) {
  const next = structuredClone(data ?? {});
  if (tool === "cursor") next.version ??= 1;
  const createdHooksKey = next.hooks === undefined;
  if (
    next.hooks !== undefined &&
    (typeof next.hooks !== "object" || Array.isArray(next.hooks))
  )
    throw new Error(
      "Unexpected hooks value in the agent config; nothing was changed.",
    );
  next.hooks ??= {};
  const createdEvents: string[] = [];
  for (const [event, groups] of Object.entries(entries)) {
    if (next.hooks[event] === undefined) createdEvents.push(event);
    else if (!Array.isArray(next.hooks[event]))
      throw new Error(
        `Unexpected ${event} hooks in the agent config; nothing was changed.`,
      );
    next.hooks[event] = [...withoutLeash(tool, next.hooks[event]), ...groups];
  }
  return { data: next, createdHooksKey, createdEvents };
}
export function removeHooks(
  tool: HookTarget,
  data: any,
  manifest?: Pick<HookManifest, "createdEvents" | "createdHooksKey">,
) {
  const next = structuredClone(data ?? {});
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    const kept = withoutLeash(tool, next.hooks[event]);
    if (!kept.length && manifest?.createdEvents.includes(event))
      delete next.hooks[event];
    else next.hooks[event] = kept;
  }
  if (manifest?.createdHooksKey && !Object.keys(next.hooks).length)
    delete next.hooks;
  return next;
}

function atomicWrite(path: string, text: string) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.leash-${randomUUID()}`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}
const manifestPath = (tool: HookTarget, root: string) =>
  join(
    localDir(),
    "hooks",
    `${tool}-${Buffer.from(root).toString("base64url")}.json`,
  );
function readConfig(path: string) {
  if (!existsSync(path)) return { data: undefined, text: "" };
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return { data: {}, text };
  // Parse before backup or mutation, so a malformed file stays untouched.
  return { data: JSON.parse(text), text };
}
export function installHooks(tool: HookTarget, root = homedir()) {
  if (!hookTargets.includes(tool))
    throw new Error("Choose claude, codex or cursor");
  const path = configPath(tool, root);
  const { data } = readConfig(path);
  const merged = mergeHooks(tool, data);
  const previous = existsSync(manifestPath(tool, root))
    ? (JSON.parse(
        readFileSync(manifestPath(tool, root), "utf8"),
      ) as HookManifest)
    : undefined;
  let backup: string | null = null;
  if (data !== undefined) {
    backup = `${path}.leash-backup-${Date.now()}`;
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(merged.data, null, 2) + "\n");
  // A re-install keeps what the first install created, so uninstall still restores cleanly.
  const manifest: HookManifest = {
    tool,
    path,
    createdFile: previous?.createdFile ?? data === undefined,
    createdHooksKey: previous?.createdHooksKey ?? merged.createdHooksKey,
    createdEvents: previous?.createdEvents ?? merged.createdEvents,
    backup: previous?.backup ?? backup,
    installedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(manifestPath(tool, root)), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(manifestPath(tool, root), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return {
    path,
    backup,
    events: Object.keys(leashEntries(tool)),
    note: installNote(tool),
  };
}
export function uninstallHooks(tool: HookTarget, root = homedir()) {
  if (!hookTargets.includes(tool))
    throw new Error("Choose claude, codex or cursor");
  const path = configPath(tool, root);
  const mPath = manifestPath(tool, root);
  const manifest = existsSync(mPath)
    ? (JSON.parse(readFileSync(mPath, "utf8")) as HookManifest)
    : undefined;
  const { data } = readConfig(path);
  let removedFile = false;
  if (data !== undefined) {
    const next = removeHooks(tool, data, manifest);
    const skeleton = tool === "cursor" ? { version: 1 } : {};
    if (
      manifest?.createdFile &&
      JSON.stringify(next) === JSON.stringify(skeleton)
    ) {
      unlinkSync(path);
      removedFile = true;
    } else if (JSON.stringify(next) !== JSON.stringify(data)) {
      // Unchanged since install apart from Leash: put the original bytes back.
      const original =
        manifest?.backup && existsSync(manifest.backup)
          ? readFileSync(manifest.backup, "utf8")
          : undefined;
      let same = false;
      try {
        same =
          original !== undefined &&
          JSON.stringify(JSON.parse(original)) === JSON.stringify(next);
      } catch {}
      atomicWrite(
        path,
        same ? original! : JSON.stringify(next, null, 2) + "\n",
      );
    }
  }
  if (manifest) unlinkSync(mPath);
  return { path, removedFile, backup: manifest?.backup ?? null };
}
function installNote(tool: HookTarget) {
  if (tool === "codex")
    return "Codex reviews new hooks before running them. Open Codex and approve the two Leash hooks when asked. Until then only the watcher's process fallback can stop Codex.";
  if (tool === "cursor")
    return "Restart Cursor's agent (or reload the window) to load the hooks. Cursor usage is metered from the afterAgentResponse hook.";
  return "Applies to the Claude Code CLI and the Claude desktop Code tab on their next session.";
}
