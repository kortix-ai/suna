---
recorded: 2026-10-19T19:56:00Z
incident_date: 2026-10-19
---
# Decide a shell allowlist per command, never against the whole line

**Rule:** A permission rule over a shell line decides each command of the line (split on unquoted `;` `&` `|` newline, plus every `$()`, backtick, `<()`, `>()` and `( )` body), and the strictest answer wins. Never test a pattern against the whole line: `allowed-prefix *` then matches `allowed-prefix x; anything`. A line that does not parse fails closed.

**Trigger surface:** Writing or porting a harness permission check (`harness/pi/interactions.ts` `resolvePolicyRule`, a new harness), or moving an agent with a `bash:` pattern allowlist from OpenCode to pi.

**Incident:** 2026-10-19, near-miss found while preparing a self-hosted enterprise project for pi. pi up to v0.14.2 matched the whole line, so a public-facing chat agent allowlisted to one connector command could run `cmd x; id`, `cmd x && whoami`, `cmd $(hostname)` (all ran in a real dev pi session). OpenCode asked per command, so the switch would have widened shell access. Fixed in #10309.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-permission-patterns.test.ts` "pi decides a bash line command by command" (separators, substitutions, quoting, deny-list and fail-closed rows).
