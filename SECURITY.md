# Security

Report vulnerabilities privately to **hello@useleash.dev**. Do not open a public issue for a vulnerability or attach credentials, private code, conversation logs or customer data.

Include the affected CLI version, operating system, a short description, expected behavior and a minimal reproduction using synthetic data. If relevant, include the command and a redacted configuration. Share sensitive reproduction details only through an agreed private channel.

This repository covers the CLI, agent hooks, local SQLite ledgers, provider credential vault, local proxy, gateway client and optional sandbox helpers. Hosted API, gateway, dashboard and billing implementations are outside this repository; report issues with those services to the same address.

Hooks fail open and do not sandbox an agent. Report bypasses of documented proxy admission, credential isolation, metadata filtering or sandbox restrictions. Never test against another user's workspace or a production service without authorization.
