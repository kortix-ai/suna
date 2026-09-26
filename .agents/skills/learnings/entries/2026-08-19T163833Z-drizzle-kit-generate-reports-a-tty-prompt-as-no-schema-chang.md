---
recorded: 2026-08-19T16:38:33Z
incident_date: 2026-08-19
commit: 1addb77a0c
---
# `drizzle-kit generate` reports a TTY prompt as "no schema changes"

**When:** running `bun packages/db/scripts/generate.ts <slug>` from any
non-interactive shell (an agent, CI, a piped command).
When a diff contains BOTH a created and a deleted table, drizzle-kit opens an
interactive "created or renamed?" picker. Without a TTY it throws
`Interactive prompts require a TTY terminal`, and the wrapper still prints
`No schema changes detected — kortix.ts matches the snapshot. Nothing generated.`
— the snapshot is NOT written, and `schema-sync` then rubber-stamps a stale one.
The rule: **read the line drizzle-kit itself prints (`No schema changes, nothing
to migrate 😴`), not the wrapper's summary**, and verify
`drizzle/meta/_journal.json`'s tail plus the snapshot `prevId` chain by hand. To
avoid the prompt entirely, split the change into two generate runs — deletions
first, then creations — so neither diff has both sides.
*Near-miss:* the canonical-RBAC cutover; `account_memberships` (created) landed
in the same diff as three dropped tables, and the first run silently produced no
snapshot. Same failure class as the 2026-07-16 forked-snapshot incident
(MIGRATIONS.md "Why drizzle-kit generate needed fixing").
