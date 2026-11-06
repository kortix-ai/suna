---
recorded: 2026-11-06T12:04:21Z
incident_date: 2026-11-06
---
# Keep a budget or a dedupe key that must hold for an hour in the database, never in the scheduler leader's memory

**Rule:** A limit, budget or once-per-episode key that must hold across minutes or hours lives in the database (count the rows you already write, or store the episode start). A `// replica-local:` map on the scheduler leader starts from 0 at every leader change, and every API deploy changes the leader.

**Trigger surface:** Writing a leader job that limits or deduplicates over time: restarts per hour, alerts per episode, retries per day. A `new Map()` keyed by an id, read on the next pass.

**Incident:** 2026-11-06, #11907 (merged as `7b2213b122`). Keep-alive allowed 3 supervisor restarts an hour per always-on App runtime, counted in a leader-local map, and a spent budget was meant to open the crash alert. The crash-path proof on dev, with a real always-on App, got 5 restarts in 21 minutes and no crash alert: two dev deploys in that window moved the leader, and each new leader allowed 3 more. Found before a release; fixed in #11917 (`0283ceb4e6`), which counts the release's `supervisor_restarted` events of the last hour and keys `kortix.app.crashed` on the open alert's start. After the fix, the next pass after one more kill opened the crash alert and started the repair session. The comment on the old map named the reset ("at most one extra hour of restarts") and judged it harmless; on dev, which deploys many times a day, it disabled the alert.

**Enforcement:** `apps/api/src/apps/keep-alive.integration.test.ts`, "the restart budget is the release's supervisor_restarted events": a new leader with no memory finds the budget spent and writes no second crash event. No general check yet; the enforcer to build: a lint rule that flags a `replica-local:` map read inside `worker/jobs/` or a leader tick without a comment naming why a reset is safe.
