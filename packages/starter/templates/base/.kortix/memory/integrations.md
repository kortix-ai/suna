# Integrations

Third parties, MCP servers, channels, executor connectors — anything
this project talks to that lives outside its own repo.

> _Empty stub. The memory-reflector agent will fill this in as
> integrations are wired up._

For each integration, note:

- **What it is and why we use it** (one line).
- **Where it's configured** — `kortix.toml` connector slug, MCP server
  entry, channel platform, env var names. Cite file paths.
- **Scope** — which environments it runs in, which agents need it,
  what it has access to.
- **Gotchas** — auth quirks, rate limits, regional issues, anything
  that bit us once.

Do **not** store credentials here. Tokens and keys live in the Kortix
Secrets Manager.
