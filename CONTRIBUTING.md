# Contributing

Use Node.js 22.13 or later and pnpm 10.30.3. Node 24 is recommended.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
node scripts/smoke.mjs
```

`npm install && npm test` is also supported. Keep `pnpm-lock.yaml` as the committed lockfile. Use `pnpm exec prettier --write .` to format changes.

Tests use synthetic fixtures, temporary homes and loopback mock servers. Do not point tests or demos at a real account. Keep prompts, paths, session IDs, emails and credentials synthetic. Do not add `.env` files or private service code.

Keep changes focused and use conventional commits, such as `fix(hooks): preserve other handlers on uninstall`. Explain the observed problem, the new behavior and the checks you ran. Add regression coverage for enforcement and privacy changes. Never weaken a guard to make a test pass.

We do not accept PRs that add telemetry or content collection. Usage reporting must remain metadata only. Never read or forward an agent's OAuth or subscription tokens. Do not add prompts, responses, source code or credential contents to reports, logs or sync payloads.

The package deliberately has `private: true`. Publishing and hosted service deployment are separate maintainer tasks. This repository's CI does not need secrets.

See [SECURITY.md](SECURITY.md) for private reports and [docs/EXTRACTION-NOTES.md](docs/EXTRACTION-NOTES.md) for the extraction scope.
