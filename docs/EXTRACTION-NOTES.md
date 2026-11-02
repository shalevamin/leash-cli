# CLI extraction notes

Extracted on 2 November 2026 from private source revision `bb139d6941f2bbe2e23a5070f8cbe531a2c2d959`. The private source was read-only. This repository has a fresh Git history and no remote. No repository was created on GitHub, no push was made and no npm package was published.

## Included

- `apps/cli/src` and `apps/cli/bin` became root `src/` and `bin/`, including colocated CLI tests. Hooks, the standalone local hook, local watcher, SQLite ledgers, node path resolution, login/device commands, proxy and gateway clients, optimization, handoff and memory remain available.
- The CLI's transitive shared dependencies are under `src/core`: pricing and its JSON snapshot, usage, parsers, policy, fingerprint, log loops, handoff, optimization, provider optimization, token inspection, model routing, provider request validation, router validation, setup plans and local usage. Their corresponding tests, core parser tests and hardening tests were retained. Only `listenHost` was copied from the shared runtime module; server environment validation was excluded.
- `runtime/egress.mjs` is the dependency-free local sandbox sidecar required by `src/sandbox.ts`. Its destination-security tests and local relay tests were retained, with the relay import rewritten for this repository. This is the local sandbox helper, not the hosted gateway implementation.
- Synthetic parser fixtures were retained. Placeholder home paths in tests were changed to generic example paths. The agent classifier artifact describes a synthetic boolean training set, not user observations.
- The approved dark lockup was copied unchanged. IBM Plex font files retain their own OFL notice. Banner and social SVG text is outlined from those fonts, and the PNGs are rendered from those SVGs.

## Excluded

No database package, database schema, migrations, tenant/RLS implementation, hosted API, hosted gateway, dashboard, billing or server code was copied. The unused reconciliation, release, readiness, billing plans, server savings aggregation, spend insights, run comparisons and optimization fixture modules were left out.

The monorepo benchmark, development environment script, workspace configuration, service deployment scripts and private release tooling were omitted. No environment files were copied. Database dependency notices were not needed: neither the main CLI nor the standalone hook bundles those dependencies. Installed external dependencies keep their own license files.

## Behavior differences

- `leash login` and `leash connect` now default to `https://api.useleash.dev`. Explicit compatible HTTPS APIs and loopback test APIs remain supported.
- Legacy direct PostgreSQL sync was removed. `sync` uses an enrolled device's HTTPS transport only. A legacy database environment variable does not enable transport. Dry runs still return the local snapshot. Without enrollment the command explains how to enroll instead of claiming database sync succeeded.
- Encrypted webhook records that depended on the server's secret decryption function are not supported. Existing saved records suppress that channel rather than silently falling back to a different URL. Explicit environment-configured Slack/Discord webhooks and their local retry queue remain supported.
- `doctor` no longer inspects or reports hosted authentication and billing service credentials.
- The build compiles the root package, bundles the standalone hook and copies the local sandbox egress helper. It verifies that the hook has no third-party input or external import. The sandbox source fallback is relative to this standalone repository.
- The package is MIT, version 0.2.9, and remains `private: true`. It requires Node.js 22.13 or later. The lockfile uses pnpm 10.30.3. Esbuild was moved to 0.28 to satisfy the test tooling's peer range. The HTTP server adapter was updated to 2.1.6 and Vitest to 4.1.12 after dependency auditing; all checks were repeated with those versions.
- Test setup supplies an isolated home for every test file, including tests whose helpers fall back to the default configuration. Nothing in the test suite needs a real account.

Enforcement policy and hook cache/fail-open rules were retained. Subscription mode reads usage logs and sends metadata; it does not proxy subscription authentication. Optional API-key proxy/gateway clients necessarily forward explicitly configured inference traffic. The README distinguishes that traffic from control-plane metadata. Local code indexing and handoff input are also described separately from telemetry.

## Verification

- 35 test files, 291 tests passed on macOS with Node 24.22.1 and Node 22.23.4.
- Frozen pnpm installation, typecheck, ESLint, Prettier, tests and build passed in the working checkout.
- A fresh local Git clone passed frozen pnpm installation, typecheck, lint, all 291 tests, build and CLI smoke checks without monorepo dependencies.
- A separate source export passed `npm install`, `npm test` (all 291 tests), `npm run build` and CLI smoke checks.
- Smoke checks use an isolated home and a working directory outside the package. `--version` prints `0.2.9`, `--help` succeeds and signed-out `whoami` reports `Not signed in` with exit status 1.
- The GitHub workflow covers Ubuntu and macOS, Node 22 and 24, with no secrets. Hosted CI has not run because nothing was pushed. Ubuntu execution is left to that workflow; local results are not presented as Linux results.
- The banner is 1280 × 320 and the social preview is exactly 1280 × 640. The GIF is 6.66 seconds and 39,040 bytes. The SVGs, PNGs and representative GIF output were visually checked. The recording invokes the real compiled hook against a fresh cached mock block in an isolated home, with no network or actual agent command.
- `gitleaks dir .` and `gitleaks git .` passed with the default rules and no custom allowlist. Final scans include the extraction notes and all local commits.

The final production dependency audit reports zero vulnerabilities. The full development audit still reports the moderate [minimatch pattern-amplification advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) through the ESLint/TypeScript lint dependency tree. pnpm counts this as one advisory; npm counts affected packages in the tree separately. The patched minimatch major is outside those dependencies' declared ranges, so no forced transitive major override was applied. This toolchain consumes repository lint patterns, not CLI user requests. The original HTTP adapter and Vitest advisory findings were resolved by the version updates above.

The requested identifier search has four intentional source matches:

| File                 | Explanation                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `README.md`          | The public GitHub owner in the explicitly requested CI badge and link.                                                        |
| `src/hooks.ts`       | The generated configuration-backup filename suffix, not a real backup path or copied backup.                                  |
| `src/install.ts`     | The same generated configuration-backup suffix, with a timestamp and random identifier.                                       |
| `src/memory.test.ts` | A synthetic API-key prefix followed by 40 repeated `x` characters, used to verify secret exclusion from the local code index. |

No real account identifiers, user prompts, deployment IDs, personal home paths or credential values were found in the extracted files. Build output, installed dependencies and temporary verification tools are ignored and are not part of the tracked source.

## Tracked files

The following is the complete sorted `git ls-files` inventory, including this document.

```text
.github/workflows/ci.yml
.gitignore
.prettierignore
CONTRIBUTING.md
LICENSE
README.md
SECURITY.md
assets/README.md
assets/banner.png
assets/banner.svg
assets/demo.cast
assets/demo.gif
assets/demo.tape
assets/fonts/OFL.txt
assets/fonts/ibm-plex-sans-latin-400-normal.woff2
assets/fonts/ibm-plex-sans-latin-600-normal.woff2
assets/leash-lockup-on-dark.svg
assets/social-preview.png
assets/social-preview.svg
bin/leash.mjs
docs/EXTRACTION-NOTES.md
eslint.config.mjs
fixtures/claude-code.jsonl
fixtures/codex.jsonl
fixtures/local-agent/claude-session.jsonl
fixtures/local-agent/codex-legacy.jsonl
fixtures/local-agent/codex-rollout.jsonl
fixtures/local-agent/cursor-spool.jsonl
package.json
pnpm-lock.yaml
runtime/egress.mjs
runtime/egress.test.mjs
runtime/relay.test.mjs
scripts/build.mjs
scripts/demo-session.mjs
scripts/render-brand.py
scripts/smoke.mjs
scripts/test-setup.mjs
src/agent-classifier-model.json
src/agent-classifier.test.ts
src/agent-classifier.ts
src/agent-setup.test.ts
src/agent-setup.ts
src/alerts.test.ts
src/alerts.ts
src/auth.test.ts
src/auth.ts
src/config.ts
src/connect.test.ts
src/connect.ts
src/core/core.test.ts
src/core/fingerprint.ts
src/core/handoff.test.ts
src/core/handoff.ts
src/core/hardening.test.ts
src/core/index.ts
src/core/local-usage.test.ts
src/core/local-usage.ts
src/core/log-loops.ts
src/core/model-routing.test.ts
src/core/model-routing.ts
src/core/openrouter.test.ts
src/core/openrouter.ts
src/core/optimization.test.ts
src/core/optimization.ts
src/core/parsers.ts
src/core/policy.ts
src/core/prices.json
src/core/pricing.ts
src/core/provider-optimization.ts
src/core/provider-request.ts
src/core/runtime.ts
src/core/setup-plan.test.ts
src/core/setup-plan.ts
src/core/token-xray.test.ts
src/core/token-xray.ts
src/core/usage.test.ts
src/core/usage.ts
src/detect.ts
src/device.test.ts
src/device.ts
src/gateway-vault.test.ts
src/gateway-vault.ts
src/handoff.test.ts
src/handoff.ts
src/hooks.test.ts
src/hooks.ts
src/index.ts
src/install.test.ts
src/install.ts
src/local-hook.ts
src/local-secrets.test.ts
src/local-secrets.ts
src/local-state.ts
src/local.test.ts
src/local.ts
src/memory-ast.ts
src/memory-index.ts
src/memory-mcp.ts
src/memory.test.ts
src/memory.ts
src/node-path.test.ts
src/node-path.ts
src/openrouter.test.ts
src/optimize.test.ts
src/optimize.ts
src/proxy.test.ts
src/proxy.ts
src/report.test.ts
src/report.ts
src/sandbox-memory.test.ts
src/sandbox-memory.ts
src/sandbox-relay.ts
src/sandbox.ts
src/setup-local.test.ts
src/setup-local.ts
src/state.test.ts
src/state.ts
src/sync.test.ts
src/sync.ts
src/tool-compression.test.ts
src/tool-compression.ts
tsconfig.build.json
tsconfig.json
vitest.config.ts
```
