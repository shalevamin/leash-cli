import { it, expect, afterEach, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import TOML from "@iarna/toml";
import { install } from "./install.js";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leash-install-"));
  process.env.LEASH_HOME = join(root, "leash");
});
afterEach(() => {
  delete process.env.LEASH_HOME;
  rmSync(root, { recursive: true, force: true });
});
it("backs up Claude config and preserves existing unrelated hooks", () => {
  mkdirSync(join(root, ".claude"));
  const original = {
    env: {
      CUSTOM: "keep",
      CLAUDE_CODE_MAX_RETRIES: "10",
      CLAUDE_CODE_RETRY_WATCHDOG: "1",
    },
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "echo existing" }] }],
    },
    permissions: { allow: ["Read"] },
  };
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(original));
  const r = install("claude-code", root);
  const updated = JSON.parse(readFileSync(r.path, "utf8"));
  expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(original);
  expect(updated.env.CUSTOM).toBe("keep");
  expect(updated.env.CLAUDE_CODE_MAX_RETRIES).toBe("0");
  expect(updated.env.CLAUDE_CODE_RETRY_WATCHDOG).toBe("0");
  expect(updated.hooks.PreToolUse).toHaveLength(2);
  expect(updated.env.ANTHROPIC_BASE_URL).toMatch(/\/s\/.+\/anthropic$/);
  install("claude-code", root);
  expect(
    JSON.parse(readFileSync(r.path, "utf8")).hooks.PreToolUse,
  ).toHaveLength(2);
});
it("preserves TOML comments, unrelated tables and one provider on reinstall", () => {
  mkdirSync(join(root, ".codex"));
  writeFileSync(
    join(root, ".codex/config.toml"),
    '# my settings\nmodel = "gpt-4o"\n"web_search" = "cached"\n[projects."/tmp/foo"]\ntrust_level = "trusted"\n',
  );
  const r = install("codex", root);
  install("codex", root);
  const text = readFileSync(r.path, "utf8"),
    data: any = TOML.parse(text);
  expect(text).toContain("# my settings");
  expect(data.projects["/tmp/foo"].trust_level).toBe("trusted");
  expect(data.model_providers.leash.wire_api).toBe("responses");
  expect(data.web_search).toBe("disabled");
  expect(text.match(/\[model_providers.leash\]/g)).toHaveLength(1);
});

it("restores the exact original after repeated installations", async () => {
  const { uninstall } = await import("./install.js");
  mkdirSync(join(root, ".codex"));
  const path = join(root, ".codex/config.toml");
  const original =
    '# keep me\nmodel="gpt-4o"\nmodel_provider="original"\nweb_search="live"\n';
  writeFileSync(path, original);
  install("codex", root);
  install("codex", root);
  const r = uninstall("codex", root);
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(r.backup).toBeTruthy();
});
it("removes newly created configuration when uninstalled", async () => {
  const { uninstall } = await import("./install.js");
  const { existsSync } = await import("node:fs");
  const r = install("claude-code", root);
  uninstall("claude-code", root);
  expect(existsSync(r.path)).toBe(false);
});
