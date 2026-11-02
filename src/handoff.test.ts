import { it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./state.js";
import { handoff } from "./handoff.js";
it("writes a private handoff without overwriting files or resetting local policy", () => {
  const home = mkdtempSync(join(tmpdir(), "leash-handoff-"));
  vi.stubEnv("LEASH_HOME", home);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const store = new Store(home);
  try {
    const s = store.create("codex", 5);
    store.kill(s.id, "manual");
    const before = store.get("session", s.id);
    const output = join(home, "HANDOFF.md");
    handoff(s.id, { output, goal: "Ship safely" });
    expect(readFileSync(output, "utf8")).toContain("Ship safely");
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(() => handoff(s.id, { output })).toThrow();
    expect(store.get("session", s.id)).toEqual(before);
    handoff(s.id, { json: true });
    expect(log.mock.calls.at(-1)?.[0]).toContain('"level": "stopped"');
    expect(() =>
      handoff("missing", { output: join(home, "missing.md") }),
    ).toThrow("No matching session");
  } finally {
    store.db.close();
    log.mockRestore();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
