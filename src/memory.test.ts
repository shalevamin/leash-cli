import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CodeMemory } from "./memory-index.js";
import { createMemoryRpc, serveCodeMemory } from "./memory-mcp.js";
let root: string, repo: string, home: string, memory: CodeMemory;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leash-memory-test-"));
  repo = join(root, "project");
  home = join(root, "private");
  mkdirSync(repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "math.ts"),
    "export function add(a: number, b: number) { return a + b; }\nexport class Calculator { run() { return add(1, 2); } }\n",
  );
  writeFileSync(
    join(repo, "src", "main.ts"),
    "import { add } from './math';\nexport const answer = add(2, 3);\n",
  );
  memory = new CodeMemory(repo, home);
});
afterEach(() => {
  memory.close();
  rmSync(root, { recursive: true, force: true });
});
describe("private incremental code memory", () => {
  it("applies nested negation in order without overriding mandatory secret exclusions", () => {
    writeFileSync(join(repo, ".gitignore"), "*.ts\n");
    writeFileSync(
      join(repo, "src", ".gitignore"),
      "!math.ts\n!credentials.ts\n",
    );
    writeFileSync(
      join(repo, "src", "credentials.ts"),
      "const hidden = 'PRIVATE';",
    );
    expect(memory.refresh().files).toBe(1);
    expect(memory.symbol("add").symbols).toHaveLength(1);
    expect(memory.search("PRIVATE").matches).toEqual([]);
  });
  it("indexes real JS/TS AST declarations, imports and calls with persistent reuse", () => {
    expect(memory.refresh()).toMatchObject({
      files: 2,
      changedFiles: 2,
      symbols: 4,
    });
    expect(memory.refresh().changedFiles).toBe(0);
    expect(memory.symbol("add").symbols[0]).toMatchObject({
      name: "add",
      kind: "FunctionDeclaration",
      line: 1,
    });
    expect(memory.impact("add").references).toHaveLength(3);
    expect(memory.architecture().imports[0].target).toBe("./math");
    const second = new CodeMemory(repo, home);
    try {
      expect(second.refresh().changedFiles).toBe(0);
      expect(second.repoId).toBe(memory.repoId);
    } finally {
      second.close();
    }
    expect(statSync(memory.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "code-memory")).mode & 0o777).toBe(0o700);
  });
  it("fresh queries invalidate changed/deleted source and exclude newly ignored files", () => {
    memory.refresh();
    writeFileSync(
      join(repo, "src", "math.ts"),
      "export function multiply() { return 7; }",
    );
    expect(memory.symbol("add").symbols).toEqual([]);
    expect(memory.symbol("multiply").symbols).toHaveLength(1);
    unlinkSync(join(repo, "src", "main.ts"));
    expect(memory.impact("add").references).toEqual([]);
    writeFileSync(join(repo, ".gitignore"), "src/math.ts\n");
    expect(memory.search("multiply").matches).toEqual([]);
    expect(memory.status().files).toBe(0);
  });
  it("honors nested ignores, secret/binary/size/symlink exclusions and root isolation", () => {
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    mkdirSync(join(repo, "ignored"));
    writeFileSync(
      join(repo, "ignored", "private.ts"),
      "const ignored = 'HIDDEN';",
    );
    writeFileSync(join(repo, "src", ".gitignore"), "hidden.ts\n");
    writeFileSync(join(repo, "src", "hidden.ts"), "const hidden = 'HIDDEN';");
    writeFileSync(join(repo, ".env"), "API_KEY=HIDDEN");
    writeFileSync(join(repo, "credentials.json"), '{"token":"HIDDEN"}');
    writeFileSync(join(repo, "binary.ts"), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, "large.ts"), "x".repeat(512 * 1024 + 1));
    writeFileSync(
      join(repo, "key.ts"),
      "const value='sk-proj-" + "x".repeat(40) + "';",
    );
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "const escape = 'HIDDEN';");
    symlinkSync(outside, join(repo, "escape.ts"));
    expect(memory.refresh().files).toBe(2);
    expect(memory.search("HIDDEN").matches).toEqual([]);
    expect(() => memory.symbol("escape", "../outside.ts")).toThrow("traversal");
    expect(() => memory.symbol("escape", outside)).toThrow("traversal");
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "index.ts"), "export const another = 1;");
    const index = new CodeMemory(other, home);
    try {
      expect(index.repoId).not.toBe(memory.repoId);
      expect(index.search("Calculator").matches).toEqual([]);
    } finally {
      index.close();
    }
  });
  it("returns bounded ranked literal search and reports an honest full-file baseline", () => {
    writeFileSync(
      join(repo, "src", "math.ts"),
      readFileSync(join(repo, "src", "math.ts"), "utf8") +
        "\n// unrelated repeated details\n".repeat(2000),
    );
    const result = memory.search("add");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.measurement.responseBytes).toBeLessThan(
      result.measurement.fullMatchedFilesBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(25000);
    expect(memory.search('add" OR 1=1 --').matches).toEqual([]);
    expect(() => memory.search("add", 100)).toThrow();
    expect(() => memory.search("x".repeat(161))).toThrow();
    writeFileSync(
      join(repo, "helper.py"),
      "def greet(name):\n    return name\n",
    );
    expect(memory.symbol("greet").symbols[0].kind).toBe("text-outline");
  });
  it("never serves stale indexed source after a file becomes a symlink or ignore rules unsafe", () => {
    memory.refresh();
    const path = join(repo, "src", "math.ts");
    unlinkSync(path);
    symlinkSync(join(root, "missing"), path);
    expect(memory.symbol("add").symbols).toEqual([]);
    symlinkSync(join(root, "missing-ignore"), join(repo, ".gitignore"));
    // A dangling ignore symlink must not cause a previous snapshot to be trusted.
    expect(() => memory.search("answer")).toThrow();
  });
  it("rejects symlink storage without modifying the target permissions", () => {
    const outside = join(root, "shared");
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    const bad = join(root, "bad");
    mkdirSync(bad);
    symlinkSync(outside, join(bad, "code-memory"));
    expect(() => new CodeMemory(repo, bad)).toThrow("symlink");
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });
});
describe("MCP protocol", () => {
  it("negotiates stdio lifecycle, lists six tools and rejects unauthorized arguments", () => {
    const handle = createMemoryRpc(memory),
      call = (id: number, method: string, params = {}) =>
        handle({ jsonrpc: "2.0", id, method, params }) as any;
    expect(call(1, "tools/list").error.code).toBe(-32002);
    expect(
      call(2, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }).result.capabilities.tools,
    ).toEqual({});
    expect(
      handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(call(3, "tools/list").result.tools).toHaveLength(6);
    expect(
      call(4, "tools/call", {
        name: "search_code",
        arguments: { query: "add" },
      }).result.isError,
    ).toBe(false);
    expect(
      call(5, "tools/call", {
        name: "index_codebase",
        arguments: { repo: "/etc" },
      }).error.code,
    ).toBe(-32602);
    expect(
      call(6, "tools/call", {
        name: "search_code",
        arguments: { query: "add", limit: 21 },
      }).error.code,
    ).toBe(-32602);
    expect(
      call(7, "tools/call", { name: "raw_sql", arguments: {} }).error.code,
    ).toBe(-32602);
    expect(
      call(8, "tools/call", {
        name: "get_symbol",
        arguments: { name: "add", path: "../../outside" },
      }).result.isError,
    ).toBe(true);
  });
  it("writes only newline JSON-RPC, no reply to notifications, and handles malformed input", async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    let data = "";
    output.on("data", (chunk) => {
      data += chunk;
    });
    const serving = serveCodeMemory(memory, input, output);
    input.end(
      "{bad}\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
        "\n",
    );
    await serving;
    const replies = data
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(3);
    expect(replies[0].error.code).toBe(-32700);
    expect(replies[2].result.tools).toHaveLength(6);
  });
});
