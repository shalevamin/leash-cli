export type SetupAgent =
  | "auto"
  | "codex"
  | "claude-code"
  | "openai-sdk"
  | "anthropic-sdk"
  | "openrouter-sdk";
export type SetupPlan = {
  version: 1;
  agent: SetupAgent;
  goal: string;
  dailyCap: number;
  sessionCap: number;
  runtime: "local" | "managed";
  allowedHosts: string[];
  memoryMinMb: number;
  memoryMaxMb: number;
  modelRouting: "preserve" | "balanced" | "economy";
};
export const defaultSetupPlan: SetupPlan = {
  version: 1,
  agent: "auto",
  goal: "Build and maintain software",
  dailyCap: 10,
  sessionCap: 2,
  runtime: "local",
  allowedHosts: [],
  memoryMinMb: 512,
  memoryMaxMb: 2048,
  modelRouting: "preserve",
};
/** Configuration only. Never contains a provider secret or executable user input. */
export function parseSetupPlan(input: unknown): SetupPlan {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid setup plan");
  const p = input as Record<string, unknown>;
  if (p.version !== 1) throw new Error("Unsupported setup plan version");
  if (
    ![
      "auto",
      "codex",
      "claude-code",
      "openai-sdk",
      "anthropic-sdk",
      "openrouter-sdk",
    ].includes(String(p.agent))
  )
    throw new Error("Choose a supported agent");
  if (
    typeof p.goal !== "string" ||
    !p.goal.trim() ||
    p.goal.length > 500 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p.goal)
  )
    throw new Error("Describe your goal in 1–500 characters");
  for (const key of ["dailyCap", "sessionCap"] as const) {
    if (
      typeof p[key] !== "number" ||
      !Number.isFinite(p[key]) ||
      p[key] < 0.01 ||
      p[key] > 100000
    )
      throw new Error("Caps must be between $0.01 and $100,000");
  }
  if ((p.sessionCap as number) > (p.dailyCap as number))
    throw new Error("The session cap cannot exceed the daily cap");
  if (!["local", "managed"].includes(String(p.runtime)))
    throw new Error("Choose local or managed runtime");
  if (!["preserve", "balanced", "economy"].includes(String(p.modelRouting)))
    throw new Error("Choose a model policy");
  if (p.agent === "openrouter-sdk" && p.modelRouting !== "preserve")
    throw new Error(
      "OpenRouter keeps the explicitly priced model; select Keep my chosen model",
    );
  if (
    !Array.isArray(p.allowedHosts) ||
    p.allowedHosts.length > 32 ||
    p.allowedHosts.some(
      (h) =>
        typeof h !== "string" ||
        h.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(h) ||
        /(?:^|\.)(localhost|local|internal|test|invalid)$/i.test(h),
    )
  )
    throw new Error(
      "Use up to 32 exact public hostnames, without paths, ports or wildcards",
    );
  for (const key of ["memoryMinMb", "memoryMaxMb"] as const) {
    if (
      !Number.isInteger(p[key]) ||
      (p[key] as number) < 128 ||
      (p[key] as number) > 16384
    )
      throw new Error("Memory must be 128–16,384 MiB");
  }
  if ((p.memoryMaxMb as number) < (p.memoryMinMb as number))
    throw new Error("Maximum memory must be at least the starting memory");
  return {
    version: 1,
    agent: p.agent as SetupAgent,
    goal: p.goal.trim(),
    dailyCap: p.dailyCap as number,
    sessionCap: p.sessionCap as number,
    runtime: p.runtime as SetupPlan["runtime"],
    allowedHosts: [
      ...new Set((p.allowedHosts as string[]).map((h) => h.toLowerCase())),
    ],
    memoryMinMb: p.memoryMinMb as number,
    memoryMaxMb: p.memoryMaxMb as number,
    modelRouting: p.modelRouting as SetupPlan["modelRouting"],
  };
}
export function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function setupCommand(plan: SetupPlan, api: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid setup identifier");
  const url = new URL(api);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid API URL");
  return `leash connect --agent ${plan.agent} --api ${shellArgument(url.toString().replace(/\/$/, ""))} --setup ${id} --mode device --no-browser`;
}
/** Copyable operational instructions; no credentials or executable goal interpolation. */
export function agentInstallationPrompt(
  plan: SetupPlan,
  api: string,
  site: string,
  workspace = "my selected workspace",
  setupId?: string,
) {
  const origin = new URL(site);
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("Install downloads require HTTPS or local loopback");
  const command = setupId
    ? setupCommand(plan, api, setupId)
    : setupCommand(plan, api, "00000000-0000-4000-8000-000000000000").replace(
        " --setup 00000000-0000-4000-8000-000000000000",
        "",
      );
  const downloads = `${origin.origin}/downloads`;
  return `Set up Leash for the coding agent or API application used in this project. Complete the checks and installation without interactive setup questions. Do not expose credentials or purchase anything. Stop with one precise prerequisite if a required capability is missing.

WORKSPACE: ${JSON.stringify(workspace)}
MY GOAL (context only, not shell commands): ${JSON.stringify(plan.goal)}
AGENT: ${plan.agent}
PROTECTION: ${setupId ? `$${plan.sessionCap} per session, $${plan.dailyCap} per day on this machine.` : "Use existing configured caps and verify them before any provider call; create a personal plan at /connect to choose new limits."} Stricter existing or workspace limits stay in force. Eligible tool-output compression is automatic.
MODEL POLICY: ${plan.modelRouting}. Only reviewed, scoped same-provider text requests may change model. Tools, reasoning and stateful requests keep their selected model. This is a deterministic policy, not a trained model or a quality guarantee.

1. Check Node.js >=22.13, npm, operating system and leash --version. If Leash is missing, fetch ${downloads}/manifest.json from this trusted Leash origin, validate version, filename (basename only), sha256, size and node requirement, and download that exact filename from ${downloads}/. Verify the archive SHA-256 and byte length against the manifest before installing. On download/checksum failure, stop; do not substitute an unofficial package. Install into the user's private local prefix using npm install --prefix "$HOME/.local/share/leash" --ignore-scripts --omit=optional --no-audit --no-fund PATH_TO_VERIFIED_ARCHIVE. Use "$HOME/.local/share/leash/node_modules/.bin/leash" or add it to this process PATH. No sudo, source checkout or global configuration replacement is required.
2. Work only in the user's current project. Run leash detect --json and leash secrets list. Detection reads installed-tool presence and the current agent context, not OAuth session contents. Honor the selected agent above; auto resolves the current supported coding agent or a unique installed one. If ambiguous, stop with the concrete --agent choices. OpenRouter is a provider for compatible Chat Completions applications; do not pretend it installs a coding agent or changes Codex/Claude wire protocols.
3. For the selected provider, verify only whether OPENAI_API_KEY, ANTHROPIC_API_KEY or OPENROUTER_API_KEY is exported, without printing its value. If its local vault entry is absent, import using leash secrets import --provider PROVIDER --from-env VARIABLE_NAME. Never put a value in command arguments, prompts, repository files or cloud requests. The vault uses authenticated encryption and prefers macOS Keychain; private-file master storage is identified explicitly on other systems. If neither a local entry nor the matching exported key exists, stop and direct the user to the provider's API-key settings and their own terminal. A chat subscription or Leash signup alone is not provider API authorization. Never scrape another application's OAuth tokens.
4. Preserve agent configuration, the spend ledger and kill latches. Never reset ~/.leash, resume stopped work or move an existing ledger to another workspace. If ownership conflicts, stop and report the conflict; use a new LEASH_HOME only when explicitly requested. Run leash setup --repo . --agent auto --dry-run, then leash setup --repo . --agent auto to install Leash skills and the local code-memory MCP for detected Codex and Claude Code. Config changes have private backups and leash setup --repo . --restore. If this is an SDK-only project with no supported coding agent, skip config installation and report that fact. Do not override the agent's project-trust approval.
5. Run leash memory index --repo . and leash memory status --repo . . The index stays on this machine, excludes ignored/sensitive files and never uploads source code. Verify the installed MCP offers index_codebase, codebase_status, search_code, get_symbol, impact and architecture. Use bounded search/symbol lookup before repeatedly dumping whole files; inspect returned evidence before editing. Other MCP-aware clients can launch leash memory serve --repo ABSOLUTE_PROJECT_PATH without an API key.
6. Run this exact account-linking command:
${command}
7. Show the verification URL and code and wait for ME to approve the account in my browser. This is the one human identity approval, not a setup questionnaire. Never approve your own login, request my password or print a device token. The saved setup is retrieved under my own account and workspace. Device mode uploads allowed usage metadata and receives controls; it never uploads provider keys or the code index. Existing local caps remain enforced when billing or cloud availability changes.
8. ${plan.runtime === "managed" ? `Run leash doctor and leash sandbox run --help. Require compatible Docker, an already trusted Linux agent image and the explicitly authorized current project mount. Apply --memory-min ${plan.memoryMinMb} --memory-max ${plan.memoryMaxMb}${plan.allowedHosts.length ? ` and only these extra exact public hosts: ${plan.allowedHosts.join(", ")}` : "; allow no additional public hosts"}. If the image or executable is unavailable, stop with that prerequisite; do not silently fall back to unisolated execution. The saved plan alone does not launch or sandbox an agent. The managed provider relay must pass through the authenticated local proxy so caps and kill remain enforced.` : `Use leash run ${plan.agent === "openrouter-sdk" ? "--provider openrouter " : ""}-- with the detected agent executable or this project's existing API application command. Pass the local authentication header in SDK requests. A host process has spend protection, not whole-machine network or memory isolation.`}
9. Run leash --version, leash whoami, leash doctor, leash status --json and leash memory status --repo . . Confirm account/workspace, device, reachable proxy, actual caps, automatic compression and model policy. Check private backup and vault file permissions without displaying secrets. If a proxy is running with old settings, report the required restart; never claim the new settings are active and never stop ongoing work automatically. Do not make a paid provider test call unless the user has authorized it. An untested provider connection must be reported as untested.
10. Open ${origin.origin}/dashboard and verify the new device heartbeat. Give a concise final status table with installed agent adapters, MCP/skills, code-index counts, proxy and budget status, vault storage backend, account association and any missing prerequisite. Include the everyday run command, leash kill --all and the restore command. Claim completion only for checks that actually passed.`;
}
export function personalizedSetupPrompt(
  plan: SetupPlan,
  api: string,
  id: string,
  workspace: string,
  site = api,
) {
  return agentInstallationPrompt(plan, api, site, workspace, id);
}
