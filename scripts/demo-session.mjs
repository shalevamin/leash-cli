// This scripted terminal session invokes the actual compiled hook with a local
// fixture. It never runs the proposed agent command or contacts a service.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

mkdirSync(".artifacts", { recursive: true });
const home = mkdtempSync(resolve(".artifacts/leash-demo-"));
const hook = resolve("dist/local-hook.js");
try {
  mkdirSync(join(home, "local"));
  writeFileSync(
    join(home, "local/state.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      state: { killed: true, blocked: true, reason: "workspace_killed" },
    }),
  );
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  writeFileSync(join(home, "tool.json"), payload);
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  console.log("Leash / local mock demonstration\n");
  console.log("Agent requests: npm test");
  console.log("Workspace kill switch: ON\n");
  const command =
    "$ node dist/local-hook.js --leash-local-hook claude tool < tool.json";
  for (const char of command) {
    process.stdout.write(char);
    await wait(16);
  }
  process.stdout.write("\n\n");
  await wait(350);
  const result = spawnSync(
    process.execPath,
    [hook, "--leash-local-hook", "claude", "tool"],
    {
      input: payload,
      cwd: home,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: home, LEASH_HOME: home },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
  // Format the actual JSON for the recording; keep the native deny fields.
  console.log(JSON.stringify(response.hookSpecificOutput, null, 2));
  console.log("\nTool call denied. The proposed command did not run.");
  await wait(4000);
} finally {
  process.stdout.write("\x1b[?25h");
  rmSync(home, { recursive: true, force: true });
}
