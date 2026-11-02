// Every test file starts with a private home, even when a helper falls back to
// config(). Tests must never discover the developer's real agent credentials.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "leash-test-home-"));
const overrides = {
  HOME: home,
  USERPROFILE: home,
  LEASH_HOME: join(home, ".leash"),
  XDG_CONFIG_HOME: join(home, ".config"),
};
const previous = Object.fromEntries(
  Object.keys(overrides).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, overrides);
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
