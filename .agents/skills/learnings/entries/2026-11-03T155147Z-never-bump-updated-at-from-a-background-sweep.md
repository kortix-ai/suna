---
recorded: 2026-11-03T15:51:47Z
incident_date: 2026-11-03
---
# Never bump updated_at from a background sweep

**Rule:** A worker that writes bookkeeping to `kortix.project_sessions`
(markers, repairs, GC state) does not set `updatedAt`. Clients read
`updated_at` as the last activity of a session with no activity stamp
(`sessionLastActivityAt` in
`packages/ui/src/session/actions/project-session-list-helpers.ts`). A sweep is
not activity.

**Trigger surface:** Any `db.update(projectSessions)` in `apps/api/src/workers/`
or a tick it calls (`projects/maintenance.ts`, `projects/reaping/`,
`projects/session-log-purge.ts`).

**Incident:** On prod, the branch sweep (`sweepExpiredSessionBranches`, 90-day
retention) set `updatedAt: new Date()` on every session whose branch it
deleted. The first sessions created in August crossed 90 days on 2026-11-01.
From then on, every user saw their 90-day-old sessions in the sidebar's
"Today" section. 3,146 sessions in 630 projects in 7 days. A user who opened
one waited ~100 s for a cold start of a 3-month-old box.

**Enforcement:**
`apps/api/src/__tests__/integration-branch-gc-keeps-updated-at.test.ts` (real
PostgreSQL + bare Git remote) fails when the sweep changes `updated_at`. Other
workers are not covered.
