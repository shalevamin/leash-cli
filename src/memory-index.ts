import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  lstatSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import ignore, { type Ignore } from "ignore";
import { outlineCode } from "./memory-ast.js";
const MAX_FILE = 512 * 1024,
  MAX_TOTAL = 32 * 1024 * 1024,
  MAX_FILES = 10000;
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".sh",
]);
const forbidden = (name: string) =>
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|\.leash|node_modules|vendor|dist|build|coverage|\.next|\.nuxt|\.venv|venv|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(
    name,
  ) ||
  /(?:credential|secret|private[-_]?key|id_rsa|id_ed25519)/i.test(name) ||
  /\.(?:pem|key|p12|pfx|sqlite|db|log|lock)$/i.test(name);
function ignoredBy(rules: Rule[], absolute: string, directory: boolean) {
  let excluded = false;
  for (const rule of rules) {
    const result = rule.matcher.test(
      relative(rule.base, absolute).split(sep).join("/") +
        (directory ? "/" : ""),
    );
    if (result.ignored) excluded = true;
    else if (result.unignored) excluded = false;
  }
  return excluded;
}
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type FileRow = {
  path: string;
  hash: string;
  content: string;
  bytes: number;
  parser: string;
  language: string;
};
type Rule = { base: string; matcher: Ignore };
export type CodeMemoryStats = {
  repoId: string;
  files: number;
  symbols: number;
  indexedBytes: number;
  languages: { language: string; files: number }[];
  indexedAt: string | null;
  changedFiles: number;
  removedFiles: number;
  excludedFiles: number;
  parserCoverage: string;
};
export class CodeMemory {
  readonly root: string;
  readonly repoId: string;
  readonly path: string;
  readonly db: DatabaseSync;
  constructor(
    repo: string,
    home = process.env.LEASH_HOME ?? join(homedir(), ".leash"),
  ) {
    this.root = realpathSync(resolve(repo));
    if (
      !lstatSync(this.root).isDirectory() ||
      this.root === sep ||
      this.root === homedir()
    )
      throw new Error(
        "Choose a project directory, not a home or filesystem root",
      );
    this.repoId = hash(this.root);
    const dir = join(home, "code-memory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (
      lstatSync(dir).isSymbolicLink() ||
      (existsSync(home) && lstatSync(home).isSymbolicLink())
    )
      throw new Error("Code-memory storage must not be a symlink");
    chmodSync(dir, 0o700);
    this.path = join(dir, this.repoId + ".sqlite");
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink())
      throw new Error("Code-memory database must not be a symlink");
    if (!existsSync(this.path)) closeSync(openSync(this.path, "wx", 0o600));
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, content TEXT NOT NULL,bytes INTEGER NOT NULL,parser TEXT NOT NULL,language TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY,path TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,start INTEGER,end INTEGER,line INTEGER,exported INTEGER);
      CREATE INDEX IF NOT EXISTS symbol_names ON symbols(name,path);
      CREATE TABLE IF NOT EXISTS refs (path TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,target TEXT,line INTEGER);
      CREATE INDEX IF NOT EXISTS reference_names ON refs(name);
      CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(path UNINDEXED,content,tokenize='unicode61');`);
  }
  close() {
    this.db.close();
  }
  private read(path: string, max = MAX_FILE) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((v) => v === ".." || v === "")
    )
      throw new Error("Use a relative indexed path without traversal");
    const absolute = join(this.root, path);
    const current = realpathSync(absolute);
    if (relative(this.root, current).startsWith("..") || current !== absolute)
      throw new Error("Symlinks and paths outside the project are excluded");
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink > 1 || before.size > max)
        throw new Error("Unsupported or oversized file");
      const bytes = readFileSync(fd);
      const after = lstatSync(absolute);
      if (
        after.isSymbolicLink() ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        realpathSync(absolute) !== current
      )
        throw new Error("File changed while reading; retry");
      if (bytes.length > max || bytes.includes(0))
        throw new Error("Binary or oversized file");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/.test(
          content,
        )
      )
        throw new Error("Recognized secret pattern excluded");
      return { content, hash: hash(bytes), bytes: bytes.length };
    } finally {
      closeSync(fd);
    }
  }
  refresh(): CodeMemoryStats {
    if (realpathSync(this.root) !== this.root)
      throw new Error("Project root changed");
    const current = new Map<string, Omit<FileRow, "parser" | "language">>();
    let excluded = 0,
      total = 0,
      visited = 0;
    const walk = (dir: string, inherited: Rule[], depth: number) => {
      if (depth > 40) {
        excluded++;
        return;
      }
      let rules = inherited;
      for (const name of [".gitignore", ".leashignore"]) {
        const p = join(dir, name);
        if (present(p)) {
          try {
            rules = [
              ...rules,
              {
                base: dir,
                matcher: ignore().add(
                  this.read(relative(this.root, p).split(sep).join("/"), 65536)
                    .content,
                ),
              },
            ];
          } catch {
            throw new Error(
              "Cannot safely read project ignore rules; indexing stopped",
            );
          }
        }
      }
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (++visited > MAX_FILES * 3)
          throw new Error(
            "Project exceeds traversal limit; narrow --repo or add .leashignore",
          );
        const absolute = join(dir, entry.name),
          path = relative(this.root, absolute).split(sep).join("/");
        if (
          forbidden(entry.name) ||
          entry.isSymbolicLink() ||
          ignoredBy(rules, absolute, entry.isDirectory())
        ) {
          excluded++;
          continue;
        }
        if (entry.isDirectory()) {
          walk(absolute, rules, depth + 1);
          continue;
        }
        if (
          !entry.isFile() ||
          !textExtensions.has(extname(entry.name).toLowerCase()) ||
          /(?:package-lock|pnpm-lock|yarn\.lock)/.test(entry.name)
        ) {
          excluded++;
          continue;
        }
        try {
          const file = this.read(path);
          total += file.bytes;
          if (total > MAX_TOTAL || current.size >= MAX_FILES)
            throw new Error(
              "Project exceeds indexing limit; narrow --repo or add .leashignore",
            );
          current.set(path, { path, ...file });
        } catch (error) {
          if ((error as Error).message.startsWith("Project exceeds"))
            throw error;
          excluded++;
        }
      }
    };
    walk(this.root, [], 0);
    const old = this.db.prepare("SELECT path,hash FROM files").all() as {
      path: string;
      hash: string;
    }[];
    const prior = new Map(old.map((f) => [f.path, f.hash]));
    let changedFiles = 0,
      removedFiles = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = (path: string) => {
        for (const table of ["files", "symbols", "refs", "content_search"])
          this.db.prepare(`DELETE FROM ${table} WHERE path=?`).run(path);
      };
      for (const item of old)
        if (!current.has(item.path)) {
          remove(item.path);
          removedFiles++;
        }
      for (const file of current.values()) {
        if (prior.get(file.path) === file.hash) continue;
        remove(file.path);
        changedFiles++;
        const parsed = outlineCode(file.path, file.content);
        this.db
          .prepare("INSERT INTO files VALUES(?,?,?,?,?,?)")
          .run(
            file.path,
            file.hash,
            file.content,
            file.bytes,
            parsed.parser,
            extname(file.path).slice(1),
          );
        this.db
          .prepare("INSERT INTO content_search(path,content) VALUES(?,?)")
          .run(file.path, file.content);
        for (const symbol of parsed.symbols)
          this.db
            .prepare("INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?)")
            .run(
              hash(file.path + ":" + symbol.start + ":" + symbol.name).slice(
                0,
                24,
              ),
              file.path,
              symbol.name,
              symbol.kind,
              symbol.start,
              symbol.end,
              symbol.line,
              Number(symbol.exported),
            );
        for (const ref of parsed.refs)
          this.db
            .prepare("INSERT INTO refs VALUES(?,?,?,?,?)")
            .run(file.path, ref.name, ref.kind, ref.target, ref.line);
      }
      const summary = {
        indexedAt: new Date().toISOString(),
        changedFiles,
        removedFiles,
        excludedFiles: excluded,
      };
      this.db
        .prepare("INSERT OR REPLACE INTO meta VALUES('last',?)")
        .run(JSON.stringify(summary));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.status(false);
  }
  status(fresh = true): CodeMemoryStats {
    if (fresh) return this.refresh();
    const counts = this.db
      .prepare(
        "SELECT count(*) files,coalesce(sum(bytes),0) indexedBytes FROM files",
      )
      .get() as { files: number; indexedBytes: number };
    const symbols = (
      this.db.prepare("SELECT count(*) n FROM symbols").get() as { n: number }
    ).n;
    const last = this.db
      .prepare("SELECT value FROM meta WHERE key='last'")
      .get() as { value: string } | undefined;
    const languages = this.db
      .prepare(
        "SELECT language,count(*) files FROM files GROUP BY language ORDER BY files DESC,language",
      )
      .all() as { language: string; files: number }[];
    return {
      repoId: this.repoId,
      ...counts,
      symbols,
      languages,
      ...(last
        ? JSON.parse(last.value)
        : {
            indexedAt: null,
            changedFiles: 0,
            removedFiles: 0,
            excludedFiles: 0,
          }),
      parserCoverage:
        "TypeScript/JavaScript AST; other indexed languages use text outlines",
    };
  }
  search(query: string, limit = 8) {
    this.refresh();
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 160 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error("Search needs 1–160 characters and a limit from 1 to 20");
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
    if (!words.length) throw new Error("Search needs a word or identifier");
    const expression = words.map((word) => '"' + word + '"*').join(" AND ");
    const hits = this.db
      .prepare(
        "SELECT path,snippet(content_search,1,'','', ' … ',40) snippet,bm25(content_search) score FROM content_search WHERE content_search MATCH ? ORDER BY score,path LIMIT ?",
      )
      .all(expression, limit) as {
      path: string;
      snippet: string;
      score: number;
    }[];
    return this.bound(
      {
        matches: hits.map((hit) => ({
          ...hit,
          symbols: this.db
            .prepare(
              "SELECT id,name,kind,line FROM symbols WHERE path=? ORDER BY line LIMIT 12",
            )
            .all(hit.path),
        })),
      },
      hits.map((h) => h.path),
    );
  }
  symbol(name: string, path?: string) {
    this.refresh();
    this.validateName(name);
    if (path) this.validatePath(path);
    const rows = (
      path
        ? this.db
            .prepare(
              "SELECT * FROM symbols WHERE name=? AND path=? ORDER BY line LIMIT 8",
            )
            .all(name, path)
        : this.db
            .prepare(
              "SELECT * FROM symbols WHERE name=? ORDER BY path,line LIMIT 8",
            )
            .all(name)
    ) as {
      id: string;
      path: string;
      start: number;
      end: number;
      line: number;
      name: string;
      kind: string;
    }[];
    return this.bound(
      {
        symbols: rows.map((row) => {
          const file = this.db
            .prepare("SELECT content FROM files WHERE path=?")
            .get(row.path) as { content: string };
          return {
            ...row,
            snippet: file.content.slice(
              row.start,
              Math.min(row.end, row.start + 2400),
            ),
            truncated: row.end - row.start > 2400,
          };
        }),
      },
      rows.map((r) => r.path),
    );
  }
  impact(name: string) {
    this.refresh();
    this.validateName(name);
    const references = this.db
      .prepare(
        "SELECT path,name,kind,target,line FROM refs WHERE name=? ORDER BY path,line LIMIT 40",
      )
      .all(name) as { path: string }[];
    return this.bound(
      {
        name,
        references,
        resolution:
          "Syntactic call/import name matches, not type-resolved or exhaustive runtime dependencies",
      },
      references.map((r) => r.path),
    );
  }
  architecture() {
    this.refresh();
    const files = this.db
      .prepare(
        "SELECT path,language,parser,bytes FROM files ORDER BY path LIMIT 80",
      )
      .all() as { path: string }[];
    const imports = this.db
      .prepare(
        "SELECT path,target,count(*) bindings FROM refs WHERE kind='import' GROUP BY path,target ORDER BY path,target LIMIT 80",
      )
      .all();
    return this.bound(
      {
        summary: this.status(false),
        files,
        imports,
        limitation:
          "Static module imports and declared symbols; no runtime tracing or cross-language type resolution",
      },
      files.map((r) => r.path),
    );
  }
  private validateName(name: string) {
    if (typeof name !== "string" || !/^[\p{L}\p{N}_$.-]{1,120}$/u.test(name))
      throw new Error("Use a symbol identifier up to 120 characters");
  }
  private validatePath(path: string) {
    if (
      typeof path !== "string" ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === ".." || forbidden(p))
    )
      throw new Error("Use a relative indexed path without traversal");
  }
  private bound<T extends Record<string, any>>(value: T, paths: string[]) {
    const baselineBytes = [...new Set(paths)].reduce(
      (total, path) =>
        total +
        Number(
          (
            this.db
              .prepare("SELECT bytes FROM files WHERE path=?")
              .get(path) as any
          )?.bytes ?? 0,
        ),
      0,
    );
    const result: Record<string, any> = { ...value, truncated: false };
    let text = JSON.stringify(result);
    while (Buffer.byteLength(text) > 24000) {
      const array = Object.values(result)
        .filter(Array.isArray)
        .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (!array?.length) throw new Error("Result exceeds context budget");
      array.pop();
      result.truncated = true;
      text = JSON.stringify(result);
    }
    return {
      ...(result as T),
      truncated: Boolean(result.truncated),
      measurement: {
        responseBytes: Buffer.byteLength(text),
        estimatedTokens: Math.ceil(text.length / 4),
        fullMatchedFilesBytes: baselineBytes,
        basis:
          "Exact UTF-8 payload bytes before this measurement envelope; tokens use characters/4. Baseline is full unique matched files, not measured provider savings.",
      },
    };
  }
}
