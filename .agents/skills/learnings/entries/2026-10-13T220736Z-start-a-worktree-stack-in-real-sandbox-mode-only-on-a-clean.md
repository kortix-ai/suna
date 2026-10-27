---
recorded: 2026-10-13T22:07:36Z
incident_date: 2026-10-13
---
# Start a worktree stack in real-sandbox mode only on a clean database, or with KORTIX_WORKERS_ENABLED=false

**Rule:** `pnpm worktree start <n>` boots the API with real provider credentials, and its singleton workers act on every row in that worktree's database: the cron trigger scheduler, the Platinum volume deletion queue, maintenance. A worktree database that `pnpm test` runs have filled holds fixture triggers, sessions and queued deletions. Before a real-sandbox run on such a database, start the API with `KORTIX_WORKERS_ENABLED=false` (the pod then never joins the leader election), or reset the database first. Seed only the rows the check needs, and delete them after.

**Trigger surface:** Verifying a change through a real session on a local stack (CLAUDE.md rule 6) in a worktree whose database `pnpm test` flows or browser journeys already used.

**Incident:** 2026-10-13, local, near-miss. A real-mode start of a test worktree ran for about 90 s before it was stopped. Its drive worker drained 20 fixture volume deletions against Platinum: all no-ops (`missing_ok=true`), because the fixture volumes were never created. The trigger scheduler fired 2 fixture cron triggers; both sessions failed before a sandbox was created (their fixture repos no longer existed). No live resource changed. The rerun with `KORTIX_WORKERS_ENABLED=false` ran a real session end to end with no worker activity.

**Enforcement:** none yet: `pnpm worktree start` could refuse a real-mode start when the database holds rows a test run wrote (for example, accounts named `e2e-*`), unless `KORTIX_WORKERS_ENABLED=false` is set.
