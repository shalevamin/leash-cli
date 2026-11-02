import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "leash-smoke-"));
try {
  const run = (...args) =>
    spawnSync(process.execPath, [resolve("bin/leash.mjs"), ...args], {
      cwd: home,
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LEASH_HOME: join(home, ".leash"),
        LEASH_ENV_FILE: "",
        LEASH_OFFLINE: "1",
      },
    });
  const version = run("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.2.9");
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hooks/);
  const who = run("whoami");
  assert.equal(who.status, 1);
  assert.match(who.stderr, /Not signed in/);
  console.log("CLI smoke checks passed in an isolated home.");
} finally {
  rmSync(home, { recursive: true, force: true });
}
