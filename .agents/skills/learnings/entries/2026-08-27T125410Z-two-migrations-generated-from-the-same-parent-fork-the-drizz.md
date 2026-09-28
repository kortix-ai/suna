---
recorded: 2026-08-27T12:54:10Z
incident_date: 2026-08-27
commit: 2749692516
---
# Two migrations generated from the same parent fork the drizzle chain, and main then cannot generate ANY migration

**When:** two PRs are open at once and each runs `pnpm migrate:generate`. Each
snapshot records `prevId` = whatever the tail was when it was cut. Merge both
and `drizzle/meta/` has two snapshots claiming the same parent; the next
generate anywhere on main dies with
`[a_snapshot.json, b_snapshot.json] are pointing to a parent snapshot: … which
is a collision` — and the wrapper still prints the reassuring
`No schema changes detected` line (same lie as the 2026-08-19 TTY entry), so it
reads as "nothing to do" rather than "the repo is wedged".

The second snapshot is also WRONG on content, not just on lineage: it was
diffed against the older parent, so it is missing whatever the other PR added
(here `accounts.branding`, from #6947, absent from #6953's snapshot).

**The repair** (metadata only — no applied migration file is touched, so
immutability holds): in the LATER snapshot set `prevId` to the earlier
snapshot's `id`, and copy in the objects the earlier one added. Then generate
and READ THE SQL: it must contain only your own change. If it re-proposes the
other PR's DDL, the content merge was incomplete.

**The prevention:** regenerate your migration against the current tail
immediately before merging (rebase → delete your snapshot + journal entry →
`migrate:generate` again), the same way a lockfile is refreshed.
*Incident:* main was un-generatable between #6947/#6953 merging (2026-08-26
21:26Z) and the repair on the `app-viewer-token` branch. No deploy was affected
— both migrations applied fine; only generation was blocked.
*Enforcer:* none — a CI check that asserts one linear `prevId` chain over
`drizzle/meta/*_snapshot.json` is the TODO.
