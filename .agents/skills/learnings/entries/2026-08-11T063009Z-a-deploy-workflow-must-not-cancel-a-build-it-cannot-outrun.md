---
recorded: 2026-08-11T06:30:09Z
incident_date: 2026-08-10
commit: a53e9244dd
---
# A deploy workflow must not cancel a build it cannot outrun

**When:** setting `concurrency.cancel-in-progress` on any
`.github/workflows/deploy-*`. A workflow-wide group with `true` starves the
SLOWEST surface, because every surface shares the group: a frontend-only push
kills an in-flight multi-arch API build (~23 min) whenever `main` lands faster
than that build takes (~10–20 min by day). Queue instead — GitHub holds one
pending run and cancels the previous pending one, so a burst still collapses to a
single deploy and the newest commit still wins. `true` also lets an unrelated
push kill `migrate-db` mid-migration.
*Incident:* 2026-08-10 — 19 of 30 Deploy Dev runs cancelled, `dev-api` pinned to
`d1ed3589` for 3.5 h with 5 API commits stranded; it landed only once the trunk
went quiet that evening.
*Enforcer:* none — and `deploy-staging` is still `true`, where a cancelled
`migrate-db` would hit `STAGING_DATABASE_URL`. Build the guard.
