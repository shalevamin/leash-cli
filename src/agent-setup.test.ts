import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { Command } from "commander";
import {
  registerAgentSetupCommands,
  setupAgentProject,
} from "./agent-setup.js";

vi.mock("./detect.js", () => ({
  detectAgents: () => ({
    agents: [
      { agent: "codex", installed: true },
      { agent: "claude-code", installed: false },
    ],
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const dirs: string[] = [];
function fixture() {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "leash-project-setup-")),
  );
  dirs.push(base);
  const repo = join(base, "project"),
    leashHome = join(base, "private-leash"),
    home = join(base, "user-home");
  mkdirSync(repo);
  mkdirSync(home);
  const paths = {
    codex: join(repo, ".codex", "config.toml"),
    claude: join(repo, ".mcp.json"),
    codexSkill: join(repo, ".agents", "skills", "leash-protection", "SKILL.md"),
    claudeSkill: join(
      repo,
      ".claude",
      "skills",
      "leash-protection",
      "SKILL.md",
    ),
  };
  return {
    base,
    repo,
    home,
    leashHome,
    paths,
    options: {
      repo,
      home,
      leashHome,
      agents: ["codex", "claude-code"] as ("codex" | "claude-code")[],
      executable: "/trusted/node",
      entrypoint: "/trusted/leash/index.js",
    },
  };
}
function put(path: string, text: string, mode = 0o640) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}
function contents(paths: string[]) {
  return paths.map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
    mode: statSync(path).mode & 0o777,
  }));
}
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("project-local agent setup", () => {
  it("installs both stdio servers and skills with private backups, without copying provider keys or touching agent home config", () => {
    const f = fixture();
    put(join(f.home, ".codex", "config.toml"), "# User-owned home config\n");
    vi.stubEnv("OPENAI_API_KEY", "fixture-sensitive-provider-value");
    const result = setupAgentProject(f.options);
    expect(result.configured).toBe(true);
    const codex: any = TOML.parse(readFileSync(f.paths.codex, "utf8"));
    const claude = JSON.parse(readFileSync(f.paths.claude, "utf8"));
    expect(codex.mcp_servers.leash_memory).toEqual({
      command: "/trusted/node",
      args: ["/trusted/leash/index.js", "memory", "serve", "--repo", f.repo],
      env: { LEASH_HOME: f.leashHome },
    });
    expect(claude.mcpServers.leash_memory).toEqual({
      ...codex.mcp_servers.leash_memory,
      type: "stdio",
    });
    for (const file of result.files) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).not.toContain(
        "fixture-sensitive-provider-value",
      );
    }
    expect(readFileSync(f.paths.codexSkill, "utf8")).toContain(
      "never trust a stale snippet",
    );
    expect(readFileSync(join(f.home, ".codex", "config.toml"), "utf8")).toBe(
      "# User-owned home config\n",
    );
    const backup = result.backup!;
    expect(backup.startsWith(f.repo)).toBe(false);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(backup)).mode & 0o777).toBe(0o700);
  });

  it("repeat installation retains absent originals and restore removes all newly installed files", () => {
    const f = fixture(),
      first = setupAgentProject(f.options),
      original = contents(first.files);
    const repeated = setupAgentProject(f.options);
    expect(contents(repeated.files)).toEqual(original);
    expect(
      JSON.parse(readFileSync(repeated.backup!, "utf8")).entries.every(
        (entry: any) => entry.before === null,
      ),
    ).toBe(true);
    setupAgentProject({ ...f.options, agents: [], restore: true });
    for (const path of first.files) expect(existsSync(path)).toBe(false);
    expect(existsSync(first.backup!)).toBe(false);
  });

  it("preserves TOML comments and unrelated MCP entries and restores exact original bytes and modes after reconfiguration", () => {
    const f = fixture();
    const toml =
      '# Personal preference\nmodel = "gpt-fixture" # retained inline\n\n[mcp_servers.other]\ncommand = "other-server"\n# trailing comment  \n\n';
    const json =
      '{ "mcpServers": { "other": { "command": "other-server" } }, "custom": true }\n\n';
    put(f.paths.codex, toml, 0o640);
    put(f.paths.claude, json, 0o644);
    setupAgentProject(f.options);
    setupAgentProject({ ...f.options, executable: "/trusted/new-node" });
    const codex = readFileSync(f.paths.codex, "utf8");
    expect(codex.startsWith(toml)).toBe(true);
    expect((TOML.parse(codex) as any).mcp_servers.other.command).toBe(
      "other-server",
    );
    expect(
      JSON.parse(readFileSync(f.paths.claude, "utf8")).mcpServers.other.command,
    ).toBe("other-server");
    setupAgentProject({ ...f.options, agents: [], restore: true });
    expect(readFileSync(f.paths.codex, "utf8")).toBe(toml);
    expect(readFileSync(f.paths.claude, "utf8")).toBe(json);
    expect(statSync(f.paths.codex).mode & 0o777).toBe(0o640);
    expect(statSync(f.paths.claude).mode & 0o777).toBe(0o644);
  });

  it("preserves an originally empty config file across repeat setup and restore", () => {
    const f = fixture();
    put(f.paths.codex, "", 0o640);
    setupAgentProject(f.options);
    setupAgentProject(f.options);
    setupAgentProject({ ...f.options, restore: true });
    expect(readFileSync(f.paths.codex, "utf8")).toBe("");
    expect(statSync(f.paths.codex).mode & 0o777).toBe(0o640);
  });

  it.each(["codex", "codexSkill", "claude", "claudeSkill"] as const)(
    "refuses install and restore after a managed %s file changes, without changing any other file",
    (key) => {
      const f = fixture(),
        result = setupAgentProject(f.options);
      put(
        f.paths[key],
        readFileSync(f.paths[key], "utf8") + "\n# User change\n",
      );
      const before = contents([...result.files, result.backup!]);
      expect(() => setupAgentProject(f.options)).toThrow(
        /managed file changed/,
      );
      expect(() => setupAgentProject({ ...f.options, restore: true })).toThrow(
        /managed file changed/,
      );
      expect(contents([...result.files, result.backup!])).toEqual(before);
    },
  );

  it("refuses a missing managed skill instead of recreating it or losing its original backup", () => {
    const f = fixture(),
      result = setupAgentProject(f.options);
    rmSync(f.paths.codexSkill);
    expect(() => setupAgentProject(f.options)).toThrow(/managed file changed/);
    expect(existsSync(f.paths.codexSkill)).toBe(false);
    expect(existsSync(result.backup!)).toBe(true);
  });

  it.each(["", "# Existing skill\n"])(
    "refuses foreign skill files even when their contents are empty",
    (text) => {
      const f = fixture();
      put(f.paths.codexSkill, text);
      expect(() => setupAgentProject(f.options)).toThrow(/not owned/);
      expect(readFileSync(f.paths.codexSkill, "utf8")).toBe(text);
      expect(existsSync(f.paths.codex)).toBe(false);
      expect(existsSync(f.leashHome)).toBe(false);
    },
  );

  it.each(["codex", "claude"] as const)(
    "refuses a foreign leash_memory server in %s",
    (key) => {
      const f = fixture();
      put(
        f.paths[key],
        key === "codex"
          ? '[mcp_servers.leash_memory]\ncommand = "foreign"\n'
          : '{"mcpServers":{"leash_memory":{"command":"foreign"}}}',
      );
      const original = readFileSync(f.paths[key], "utf8");
      expect(() => setupAgentProject(f.options)).toThrow(
        /already defines leash_memory/,
      );
      expect(readFileSync(f.paths[key], "utf8")).toBe(original);
      expect(existsSync(f.leashHome)).toBe(false);
    },
  );

  it.each([
    ["directory", false],
    ["directory", true],
    ["file", false],
    ["file", true],
  ] as const)(
    "rejects %s symlinks including dangling=%s without changing the target",
    (kind, dangling) => {
      const f = fixture(),
        outside = join(f.base, "outside");
      if (!dangling) {
        if (kind === "directory") mkdirSync(outside);
        else put(outside, "external original\n");
      }
      const link =
        kind === "directory" ? join(f.repo, ".codex") : f.paths.codex;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(outside, link);
      expect(() => setupAgentProject(f.options)).toThrow(/symlinked/);
      expect(existsSync(f.leashHome)).toBe(false);
      if (dangling) expect(existsSync(outside)).toBe(false);
      else if (kind === "file")
        expect(readFileSync(outside, "utf8")).toBe("external original\n");
      else expect(readdirSync(outside)).toEqual([]);
    },
  );

  it("dry run, including default LEASH_HOME resolution and restore, writes nothing", () => {
    const f = fixture();
    vi.stubEnv("LEASH_HOME", f.leashHome);
    const result = setupAgentProject({
      ...f.options,
      leashHome: undefined,
      dryRun: true,
    });
    expect(result.configured).toBe(false);
    expect(readdirSync(f.repo)).toEqual([]);
    expect(existsSync(f.leashHome)).toBe(false);
    const installed = setupAgentProject(f.options),
      before = contents([...installed.files, installed.backup!]);
    setupAgentProject({ ...f.options, restore: true, dryRun: true });
    expect(contents([...installed.files, installed.backup!])).toEqual(before);
  });

  it("refuses backups inside a repository and symlinked private backup stores", () => {
    const f = fixture();
    expect(() =>
      setupAgentProject({ ...f.options, leashHome: join(f.repo, ".leash") }),
    ).toThrow(/outside the project/);
    symlinkSync(join(f.base, "not-created"), f.leashHome);
    expect(() => setupAgentProject(f.options)).toThrow(
      /symlinked private backup/,
    );
    expect(readdirSync(f.repo)).toEqual([]);
  });

  it("retains other agent ownership when only one agent is reconfigured", () => {
    const f = fixture(),
      installed = setupAgentProject(f.options);
    setupAgentProject({
      ...f.options,
      agents: ["codex"],
      executable: "/trusted/new-node",
    });
    expect(
      JSON.parse(readFileSync(installed.backup!, "utf8")).entries,
    ).toHaveLength(4);
    setupAgentProject({ ...f.options, agents: [], restore: true });
    for (const path of installed.files) expect(existsSync(path)).toBe(false);
  });

  it("rolls a failed reinstall back to its pre-operation state rather than the first originals", () => {
    const f = fixture();
    put(f.paths.codex, '# original config\nmodel = "fixture"\n');
    const installed = setupAgentProject(f.options),
      before = contents([...installed.files, installed.backup!]);
    let failed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === f.paths.codexSkill && !failed) {
        failed = true;
        throw new Error("fixture disk failure");
      }
      actualFs.renameSync(from, to);
    });
    expect(() =>
      setupAgentProject({ ...f.options, executable: "/trusted/updated-node" }),
    ).toThrow(/fixture disk failure/);
    expect(contents([...installed.files, installed.backup!])).toEqual(before);
    expect(readdirSync(dirname(f.paths.codex))).toEqual(["config.toml"]);
    expect(readdirSync(dirname(installed.backup!))).toEqual([
      installed.backup!.split("/").at(-1),
    ]);
  });

  it("rolls back a failed manifest commit and leaves original files exactly intact", () => {
    const f = fixture();
    put(f.paths.codex, "# before\n");
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(to).includes("project-setups"))
        throw new Error("fixture backup failure");
      actualFs.renameSync(from, to);
    });
    expect(() => setupAgentProject(f.options)).toThrow(
      /fixture backup failure/,
    );
    expect(readFileSync(f.paths.codex, "utf8")).toBe("# before\n");
    expect(statSync(f.paths.codex).mode & 0o777).toBe(0o640);
    expect(existsSync(f.paths.codexSkill)).toBe(false);
    expect(existsSync(f.paths.claude)).toBe(false);
  });

  it("rolls back a partially failed restore to the installed state", () => {
    const f = fixture();
    put(f.paths.codex, "# before Codex\n");
    put(f.paths.claude, '{"custom":true}\n');
    const installed = setupAgentProject(f.options);
    const before = contents([...installed.files, installed.backup!]);
    let failed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === f.paths.claude && !failed) {
        failed = true;
        throw new Error("fixture restore failure");
      }
      actualFs.renameSync(from, to);
    });
    expect(() => setupAgentProject({ ...f.options, restore: true })).toThrow(
      /fixture restore failure/,
    );
    expect(contents([...installed.files, installed.backup!])).toEqual(before);
  });

  it("preserves a concurrent file edit during rollback and reports manual recovery", () => {
    const f = fixture(),
      installed = setupAgentProject(f.options);
    let failed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === f.paths.codexSkill && !failed) {
        failed = true;
        writeFileSync(f.paths.codex, "# Concurrent user edit\n");
        throw new Error("fixture concurrent failure");
      }
      actualFs.renameSync(from, to);
    });
    expect(() =>
      setupAgentProject({ ...f.options, executable: "/trusted/new-node" }),
    ).toThrow(/manual review/);
    expect(readFileSync(f.paths.codex, "utf8")).toBe(
      "# Concurrent user edit\n",
    );
    expect(existsSync(installed.backup!)).toBe(true);
  });

  it("auto setup uses detector agent names and does not configure an uninstalled agent", async () => {
    const f = fixture();
    vi.stubEnv("LEASH_HOME", f.leashHome);
    const program = new Command(),
      output = vi.spyOn(console, "log").mockImplementation(() => {});
    registerAgentSetupCommands(program);
    try {
      await program.parseAsync([
        "node",
        "/trusted/leash/index.js",
        "setup",
        "--repo",
        f.repo,
        "--agent",
        "auto",
        "--dry-run",
        "--json",
      ]);
      const result = JSON.parse(output.mock.calls[0][0]);
      expect(result.agents).toEqual(["codex"]);
      expect(result.files).toEqual([f.paths.codex, f.paths.codexSkill]);
      expect(readdirSync(f.repo)).toEqual([]);
      expect(existsSync(f.leashHome)).toBe(false);
    } finally {
      output.mockRestore();
    }
  });

  it("rejects a corrupted manifest entry rather than restoring unrelated project files", () => {
    const f = fixture(),
      installed = setupAgentProject(f.options);
    const foreign = join(f.repo, "README.md");
    put(foreign, "keep me\n");
    const manifest = JSON.parse(readFileSync(installed.backup!, "utf8"));
    manifest.entries[0].path = foreign;
    writeFileSync(installed.backup!, JSON.stringify(manifest));
    expect(() => setupAgentProject({ ...f.options, restore: true })).toThrow(
      /Invalid private setup manifest/,
    );
    expect(readFileSync(foreign, "utf8")).toBe("keep me\n");
  });
});
