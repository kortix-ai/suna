---
recorded: 2026-09-27T03:15:13Z
incident_date: 2026-09-25
---
# A lifecycle command's failure path must always call markCommandFailed, never let the work throw uncaught

**Rule:** Every `commandType` branch in `session-lifecycle/drain.ts`'s
`runClaimedRow` must wrap its executor in a try/catch (or an equivalent
`.catch`) that ends in `markCommandFailed`. Never call an executor bare. A bare
call lets a throw (a `GitOperationError`, a DB error, anything unexpected)
escape the row's finalization entirely: the row stays `status: 'running'`
under its lease, `markCommandFailed`'s 5-attempt dead-letter budget and
backoff never run because that function is never reached, and the drain's
abandoned-claim reclaim (`claimDueLifecycleCommands`, `LIFECYCLE_*_GRACE_MS`)
retries the exact same doomed work forever once the lock lapses — unbounded,
with `attempts` climbing past any budget. The same applies to an inline
(synchronous) executor that holds a real command-row lease
(`withCommandLeaseHeartbeat`): finalize the row on throw, do not let it
propagate bare to the HTTP caller.

**Trigger surface:** adding or changing a `session-lifecycle` command
executor (`create-session.ts`, `queued-continue.ts`, or a new command type),
or any inline path that claims a command row with a lease
(`claimCreateSessionCommand`, `initialStatus: 'running'`).

**Incident:** prod, 2026-09-25 onward, v0.13.31 (`c30b60d038` / PR #7611
"lifecycle convergence") started giving INLINE `create_session` rows a real
`lockedBy`/`lockedUntil` lease (previously unset, so the abandoned-claim
reclaim never saw them) "so the drain's reclaim arm can take it over." The
`create_session` branch in `drain.ts`'s `runClaimedRow` called
`executeQueuedCreate(row)` with no catch — unlike the `continue_session`
branch just above it. `executeQueuedCreate` -> `createProjectSession` ->
`loadProjectAgents({ rethrowReadErrors: true })` -> `refreshMirror` can throw a
`GitOperationError` when the project's bare mirror needs a cold `git clone
--bare` (`git/mirror.ts`) and that clone times out (90 s,
`BARE_CLONE_TIMEOUT_MS`). The throw escaped uncaught, `markCommandFailed` was
never called, and the row was reclaimed and retried every ~5–10 minutes
forever. Better Stack: `[session-lifecycle] queue drain failed git clone
timed out after 90000ms (signal SIGTERM)`, climbing from ~5–15/day to
937 (09-25) and 1827 (09-26), plateauing at ~75–95/h. Prod DB (read-only):
16 distinct projects, 281 `create_session` rows `status='running'`, `attempts`
up to 256, oldest from 2026-09-25.

**Enforcement:**
`apps/api/src/services/sessions/lifecycle/__tests__/create-session-drain-error.test.ts`
— `executeQueuedCreate`/`createProjectSession` throwing must still resolve
`drainSessionLifecycleQueue()` and call `markCommandFailed` exactly once,
respecting the 5-attempt budget.
