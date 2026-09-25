---
recorded: 2026-08-23T18:30:33Z
incident_date: 2026-08-23
commit: e4ec815f21
---
# Resolve a pnpm global package through `pnpm root -g`

**When:** validating or linking a binary installed by `pnpm add -g`. Build the
path as `$(pnpm root -g)/<package>`; do not parse `pnpm list --parseable` output.
That output changed shape and made the E2B template fail after a successful
OpenCode install, so new sessions continued using a stale warm template.
*Enforcer:* `apps/sandbox/opencode-warmup.test.ts` pins the Dockerfile command.
