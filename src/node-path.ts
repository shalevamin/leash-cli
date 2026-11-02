import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Install directories that change with every Node upgrade (Homebrew Cellar, nvm, fnm, asdf, mise, n). */
const VERSIONED =
  /\/(Cellar|\.nvm\/versions|fnm\/node-versions|\.asdf\/installs|mise\/installs|n\/versions)\//;
export const isVersionedNodePath = (path: string) => VERSIONED.test(path);

/** Well-known stable locations, checked after PATH. */
const WELL_KNOWN = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

export const ENV_NODE = "/usr/bin/env node";

type Probe = {
  execPath?: string;
  pathEnv?: string;
  executable?: (path: string) => boolean;
  realpath?: (path: string) => string;
};

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const safeRealpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The node path to write into agent configs that outlive this process. A path
 * inside a versioned install directory breaks on the next upgrade, so prefer a
 * stable symlink (PATH entry or Homebrew bin) without following it; prefer one
 * that points at the running node. Falls back to `/usr/bin/env node`.
 */
export function stableNodePath(probe: Probe = {}): string {
  const execPath = probe.execPath ?? process.execPath;
  const executable = probe.executable ?? isExecutable;
  const realpath = probe.realpath ?? safeRealpath;
  if (!isVersionedNodePath(execPath)) return execPath;
  const pathDirs = (probe.pathEnv ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d.startsWith("/"));
  const candidates = [
    ...new Set([...pathDirs.map((d) => join(d, "node")), ...WELL_KNOWN]),
  ].filter((p) => !isVersionedNodePath(p) && executable(p));
  const running = realpath(execPath);
  return (
    candidates.find((p) => realpath(p) === running) ?? candidates[0] ?? ENV_NODE
  );
}

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/** Shell-ready node invocation for a hook command line. */
export function nodeCommand(probe?: Probe) {
  const path = stableNodePath(probe);
  return path === ENV_NODE ? ENV_NODE : quote(path);
}
