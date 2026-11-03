#!/usr/bin/env node
import { existsSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("Leash requires Node.js 22.13 or later (Node 24 recommended).");
  process.exit(1);
}

// This file exists before compilation, so pnpm can link the workspace binary
// on a fresh install. The compiled command keeps its normal argv/environment.
if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
  console.error(
    "Leash has not been built. Reinstall with npm i -g useleash, or run pnpm build in a source checkout.",
  );
  process.exit(1);
}
await import("../dist/index.js");
