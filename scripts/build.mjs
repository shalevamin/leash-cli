import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { copyFileSync } from "node:fs";
import { build } from "esbuild";

const hook = await build({
  entryPoints: ["src/local-hook.ts"],
  outfile: "dist/local-hook.js",
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "node",
  target: "node22.13",
  format: "esm",
  metafile: true,
  legalComments: "eof",
});
assert(
  Object.keys(hook.metafile.inputs).every(
    (path) => !path.includes("node_modules/"),
  ),
  "Standalone hook must use only Node built-ins",
);
for (const output of Object.values(hook.metafile.outputs))
  for (const dependency of output.imports)
    assert(
      builtinModules.includes(dependency.path.replace(/^node:/, "")),
      `Unexpected hook dependency: ${dependency.path}`,
    );
copyFileSync("runtime/egress.mjs", "dist/sandbox-egress.mjs");
