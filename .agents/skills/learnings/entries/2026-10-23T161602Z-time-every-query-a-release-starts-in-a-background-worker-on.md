---
recorded: 2026-10-23T16:16:02Z
incident_date: 2026-10-23
---
# Time every query a release starts in a background worker on prod data before the Promote; a statement over the 25 s pool timeout repeats its batch forever

**Rule:** When a release adds or changes a query that a worker runs on prod by itself after the deploy (a backfill pass, a purge, a sweep, a SQL function it calls), run that query read-only against prod for a real batch and for the worst-case batch before the Promote. Read the plan for a correlated `EXISTS`/`= ANY` over a CTE and for a cast on an indexed column. Over 25 s (`DB_STATEMENT_TIMEOUT_MS`), the tick fails before it saves its cursor, and every later tick runs the same batch again. Give a legitimately long batch query its own `SET LOCAL statement_timeout` in a transaction.

**Trigger surface:** Planning a promote; writing or reviewing a worker tick or a SQL function that runs over every session, message or log row.

**Incident:** 2026-10-23, release v0.14.8. The session-log merge pass (#10827) starts on prod right after the deploy. Its function looked up each mirror part with `EXISTS (... key = ANY (keys))` against a materialized CTE. Read-only on prod, one session ran over 120 s, and prod's 50 largest mirrors ran 31 s even after the fix. The pass would never have finished. #10837 replaced the lookup with a hash join (1.5 s, same rows) and gave the batch query a 2 min local timeout. The PR had said "Not verified: the prod run".

**Enforcement:** none yet. To build: a pre-Promote step that lists queries and SQL functions new since the last release tag in worker-reached files, and fails until the release notes cite a prod timing for each.
