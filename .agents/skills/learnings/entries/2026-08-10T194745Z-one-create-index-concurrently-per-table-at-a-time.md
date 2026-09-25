---
recorded: 2026-08-10T19:47:45Z
incident_date: 2026-08-10
commit: 427fc1a175
---
# One CREATE INDEX CONCURRENTLY per table at a time

**When:** building indexes on a live table (runbooks, .concurrent.ts migrations).
Two concurrent CIC builds on the same table starve each other's
lock-acquisition points — every acquisition 55P03s until one finishes. Build
strictly serially. If a builder's client process dies, its CIC keeps running
SERVER-side, holds ShareUpdateExclusive, and its final commit is unreliable —
find it in `pg_stat_progress_create_index`, `pg_terminate_backend` it, and
`DROP INDEX CONCURRENTLY` the INVALID shell before rebuilding (`IF NOT EXISTS`
silently keeps invalid shells).
*Incident:* v0.12.7 audit-v2 index pass — parallel lanes 55P03-thrashed, a
killed lane left an orphaned build that starved the retry run.
