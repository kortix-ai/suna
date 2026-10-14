---
recorded: 2026-10-14T19:23:14Z
incident_date: 2026-10-13
---
# Never let a request wait on a per-key lock that an abandoned request may still hold: try-lock and answer 429

**Rule:** When a request takes a per-key advisory lock and its client gives up before the server
finishes, take the lock with `pg_try_advisory_xact_lock` and answer `429` with `Retry-After` when
it is held. Never block on it. Keep the client's timeout above the server's request deadline, so
a request the server is still committing is not abandoned and re-sent.

**Trigger surface:** writing or reviewing a route that runs `pg_advisory_xact_lock` per session,
account or object, especially one a daemon or worker calls in a retry loop.

**Incident:** 2026-10-13 to 2026-10-14, prod 0.13.56–0.13.57. `POST …/log/journal` waited on
`session-log:<session_id>`. kortixd aborted each post at 15 s and retried, and the API kept
running the abandoned transaction under the lock. Every retry queued behind it until the 25 s
statement timeout cancelled the wait (SQLSTATE 57014): up to 415 errors for one session in 6 h,
the largest Better Stack error group. Fixed in #9892: try-lock plus 429, and a 30 s daemon post
budget.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-ingest.test.ts`, "while another
batch of the session holds its lock, a batch answers 429 at once": it holds the lock in a second
transaction and fails if the route waits (500 57014 after 25 s). There is none yet for other routes:
a lint that flags `pg_advisory_xact_lock` in a route handler path.
