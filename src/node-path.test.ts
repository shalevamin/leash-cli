import { describe, it, expect } from "vitest";
import {
  ENV_NODE,
  isVersionedNodePath,
  nodeCommand,
  stableNodePath,
} from "./node-path.js";

const CELLAR = "/opt/homebrew/Cellar/node/24.1.0/bin/node";
const links: Record<string, string> = {
  "/opt/homebrew/bin/node": CELLAR,
  "/usr/local/bin/node": "/usr/local/Cellar/node/22.0.0/bin/node",
};
const probe = (present: string[], pathEnv = "/usr/bin:/bin") => ({
  execPath: CELLAR,
  pathEnv,
  executable: (p: string) => present.includes(p),
  realpath: (p: string) => links[p] ?? p,
});

describe("stable node path for agent hooks", () => {
  it("recognises versioned install directories", () => {
    expect(isVersionedNodePath(CELLAR)).toBe(true);
    expect(
      isVersionedNodePath("/home/example/.nvm/versions/node/v24.1.0/bin/node"),
    ).toBe(true);
    expect(isVersionedNodePath("/opt/homebrew/bin/node")).toBe(false);
    expect(isVersionedNodePath("/usr/bin/node")).toBe(false);
  });

  it("keeps a running node that is already outside a versioned directory", () => {
    expect(stableNodePath({ execPath: "/usr/local/bin/node" })).toBe(
      "/usr/local/bin/node",
    );
  });

  it("prefers the Homebrew symlink over the Cellar path, without following it", () => {
    expect(stableNodePath(probe(["/opt/homebrew/bin/node"]))).toBe(
      "/opt/homebrew/bin/node",
    );
  });

  it("prefers a PATH symlink that points at the running node", () => {
    const p = probe(
      ["/usr/local/bin/node", "/opt/homebrew/bin/node"],
      "/usr/local/bin:/opt/homebrew/bin",
    );
    expect(stableNodePath(p)).toBe("/opt/homebrew/bin/node");
  });

  it("never picks a versioned PATH entry", () => {
    const dir = "/home/example/.nvm/versions/node/v24.1.0/bin";
    expect(stableNodePath(probe([dir + "/node"], dir))).toBe(ENV_NODE);
  });

  it("falls back to /usr/bin/env node, unquoted, when no stable node exists", () => {
    expect(stableNodePath(probe([]))).toBe(ENV_NODE);
    expect(nodeCommand(probe([]))).toBe("/usr/bin/env node");
    expect(nodeCommand(probe(["/opt/homebrew/bin/node"]))).toBe(
      "'/opt/homebrew/bin/node'",
    );
  });
});
