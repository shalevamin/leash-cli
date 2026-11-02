import { classifyAgent } from "./agent-classifier.js";
import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
export type DetectedAgent = "codex" | "claude-code";
export function detectAgents(
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
) {
  const env = options.env ?? process.env,
    home = options.home ?? homedir();
  const executable = (name: string) =>
    (env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .some((dir) => {
        try {
          const path = join(dir, name);
          accessSync(path, constants.X_OK);
          return !lstatSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  const agents = (["codex", "claude-code"] as const).map((agent) => {
    const evidence: ("path" | "config")[] = [];
    if (executable(agent === "codex" ? "codex" : "claude"))
      evidence.push("path");
    // Existence only: never read provider OAuth tokens, settings, conversations or credentials.
    if (
      existsSync(
        join(
          home,
          agent === "codex" ? ".codex/config.toml" : ".claude/settings.json",
        ),
      )
    )
      evidence.push("config");
    return { agent, installed: evidence.length > 0, evidence };
  });
  const classification = classifyAgent({
    codexContext: !!env.CODEX_THREAD_ID?.trim(),
    claudeContext:
      env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_ENTRYPOINT?.trim(),
    codexExecutable: agents[0].evidence.includes("path"),
    codexConfig: agents[0].evidence.includes("config"),
    claudeExecutable: agents[1].evidence.includes("path"),
    claudeConfig: agents[1].evidence.includes("config"),
  });
  return {
    classification,
    agents,
    executionContext: {
      codex: !!env.CODEX_THREAD_ID?.trim(),
      claudeCode:
        env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_ENTRYPOINT?.trim(),
    },
    providers: {
      openrouter: {
        environmentPresent: !!env.OPENROUTER_API_KEY?.trim(),
        environmentVariable: "OPENROUTER_API_KEY",
      },
      openai: {
        environmentPresent: !!env.OPENAI_API_KEY?.trim(),
        environmentVariable: "OPENAI_API_KEY",
      },
      anthropic: {
        environmentPresent: !!env.ANTHROPIC_API_KEY?.trim(),
        environmentVariable: "ANTHROPIC_API_KEY",
      },
    },
  };
}
export function resolveDetectedAgent(
  requested: string,
  detection = detectAgents(),
  planAgent?: string,
): string {
  const explicit =
    requested === "auto" && planAgent && planAgent !== "auto"
      ? planAgent
      : requested;
  if (explicit !== "auto") {
    if (
      ![
        "codex",
        "claude-code",
        "openai-sdk",
        "anthropic-sdk",
        "openrouter-sdk",
      ].includes(explicit)
    )
      throw new Error(
        "Choose auto, codex, claude-code, openai-sdk, anthropic-sdk or openrouter-sdk",
      );
    return explicit;
  }
  const context = detection.executionContext;
  const installed = detection.agents.filter((agent) => agent.installed);
  // A learned proposal can only choose an adapter supported by independently
  // observed markers. Explicit user/account plans above remain authoritative.
  const verified =
    context?.codex && !context.claudeCode
      ? "codex"
      : context?.claudeCode && !context.codex
        ? "claude-code"
        : context?.codex && context.claudeCode
          ? undefined
          : installed.length === 1
            ? installed[0].agent
            : undefined;
  const proposed = detection.classification?.label;
  if (verified && proposed === verified) return proposed;
  throw new Error(
    installed.length
      ? "Both Codex and Claude Code were detected. Rerun with --agent codex or --agent claude-code; no agent was changed."
      : "No supported agent was detected. Install Codex or Claude Code, or pass --agent codex, --agent claude-code, --agent openai-sdk, --agent anthropic-sdk or --agent openrouter-sdk explicitly.",
  );
}
export function registerDetectCommands(program: Command) {
  program
    .command("detect")
    .description(
      "Detect agent executables/config markers and provider environment presence without reading secrets",
    )
    .option("--json", "Print safe detection metadata as JSON")
    .action((options) => {
      const result = detectAgents();
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `Local classifier: ${result.classification.label} (model v${result.classification.modelVersion}); ambiguous detection requires an explicit choice`,
        );
        for (const agent of result.agents)
          console.log(
            `${agent.agent}: ${agent.installed ? `detected (${agent.evidence.join(", ")})` : "not detected"}`,
          );
        for (const [provider, value] of Object.entries(result.providers))
          console.log(
            `${provider}: ${value.environmentVariable} ${value.environmentPresent ? "present" : "absent"} (value never read into output)`,
          );
      }
    });
}
