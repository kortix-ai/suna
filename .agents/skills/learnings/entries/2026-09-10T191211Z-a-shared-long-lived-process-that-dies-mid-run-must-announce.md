---
recorded: 2026-09-10T19:12:11Z
incident_date: 2026-09-10
commit: 967fd61b47
---
# A shared long-lived process that dies mid-run must announce itself, or every test after it lies about the cause

**When:** a test harness starts a server the whole run shares, or you enable a
cache whose failed restore is fatal rather than a miss. `browser-2` reported
4 failed specs; none of them were broken. Turbopack's dev filesystem cache
(`experimental.turbopackFileSystemCacheForDev`, default-ON since Next 16.1)
failed a restore and panicked OUTSIDE turbo-tasks' per-task panic boundary:
`Restore of All for task TaskId 7979517 failed in another thread` → `Aborting.`
That killed the Next dev server. Every spec scheduled afterwards then failed
with `ERR_CONNECTION_REFUSED` on `localhost:3000` and named ITSELF, burying the
one real line ~500 lines up a shared stdout. **Rules.** (1) A cache is only a
cache if a failed read is a MISS. One whose failed restore aborts the process is
a liability — a one-shot CI job starts cold and deletes it afterwards, so it
gains nothing and can lose a whole shard. Turn it off there. (2) When the
harness owns a long-lived process, watch its exit for the whole run, not just
until readiness, and print one unmissable line the moment it dies. Diagnosis
cost here was ~40 minutes of log archaeology for a cause that was one line.
*Incident:* PR #7194's release-blocking lane, 2026-09-10, 14 min lane + a
20 min re-run. *Enforcers:* `tests/unit/local-web-environment.test.ts` asserts
the deterministic profile sets `KORTIX_TURBOPACK_FS_CACHE=off`;
`ensureLocalWeb` logs the dev server's exit code for the life of the run.
