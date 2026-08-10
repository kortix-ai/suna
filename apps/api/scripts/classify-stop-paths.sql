-- Stop-path classification for kortix.session_sandboxes.
--
-- Groups every park by `metadata->>'stopReason'` (apps/api/src/projects/
-- stop-reason.ts) so someone can measure which kill path dominates when a
-- user's session sandbox dies mid-work. Read-only. NOT YET RUN — there is no
-- database in this worktree to run it against; see the header of the
-- follow-ups report for what is and is not verified about this file.
--
-- Usage — the time window is a required parameter, never hardcoded: a
-- 24-hour slice hides the `run_cap` population (a full 24h stretch) almost
-- entirely.
--
--   psql "$DEV_DATABASE_URL" -v window="7 days" -f apps/api/scripts/classify-stop-paths.sql
--
-- (`-v window="7 days"` — NO nested quotes. `:'window'` below is psql's
-- quote-as-literal substitution: it takes the variable's raw content and
-- produces the SQL string literal `'7 days'`. Writing `-v window="'7 days'"`
-- double-quotes it and the `::interval` cast fails.)
--
-- ============================================================================
-- READ BEFORE TRUSTING A ZERO OR A COUNT BELOW. Three things a raw GROUP BY
-- cannot say for itself:
-- ============================================================================
--
-- 1. TWO REASONS ARE DECLARED BUT NEVER EMITTED. `idle_grace` and
--    `boot_floor_expired` are members of the closed StopReason union
--    (apps/api/src/projects/stop-reason.ts) but no writer sets them today —
--    see STOP_REASONS_NOT_YET_EMITTED in that file. Every deadline park goes
--    through `stopExpiredBox` (apps/api/src/projects/reaping/stop-box.ts),
--    which fires on the single comparison `deadline_at <= now` and stamps the
--    reason its caller passed it — `deadline_expired` from the reaper's
--    normal pass, `run_cap` from the request-path cap park. Neither the
--    reaper nor the deadline writers (sandbox-deadline.ts) currently record
--    WHICH grant last moved `deadline_at`, so a terminal-turn idle-tail park
--    is byte-identical, at stop time, to a 20-minute boot-floor park. A ZERO
--    for `idle_grace` / `boot_floor_expired` below means NOT IMPLEMENTED —
--    never "measured, and it never happens". SQL has no way to import that TS
--    constant, so it has to be said here in prose. This query re-derives an
--    approximation of that split under `path` for rows still labelled
--    `deadline_expired`, using timing and side-table evidence, precisely
--    because the reason column itself cannot make the distinction yet.
--
-- 2. `run_cap` UNDERCOUNTS BY CONSTRUCTION. `parkBoxAtRunCap`
--    (apps/api/src/projects/reaping/stop-box.ts) is fire-and-forget from the
--    request path that just refused a prompt at the cap. If that best-effort
--    park fails, the box is NOT stamped `run_cap` — it sits at the cap with
--    an expired `deadline_at` until the next reaper pass, which parks it
--    through the normal `deadline_expired` path instead. Treat the `run_cap`
--    count below as a FLOOR, not a true count of every 24h-cap park.
--
-- 3. TWO PARK PATHS WRITE `status='stopped'` WITH NO REASON AT ALL, and will
--    always read back as `(unrecorded)` here — both pre-existing and
--    deliberately out of scope for the change that added stopReason:
--      - apps/api/src/projects/session-lifecycle/actions.ts (~435-449): the
--        restart-in-place failure handler's non-missing-runtime branch —
--        updates session_sandboxes.status to 'stopped' without touching
--        metadata at all.
--      - apps/api/src/platform/services/session-sandbox.ts (~695-726): the
--        "session was stopped while provider.create was still in flight"
--        reconciliation branch — writes a metadata patch (stoppedAt,
--        stoppedDuringProvisioning) but no stopReason key.
--    A large `(unrecorded)` count is a real signal that one of these two
--    paths fires often, not that the query is broken.
-- ============================================================================
--
-- Column/table names verified against packages/db/src/schema/kortix.ts:
--   session_sandboxes    (~line 1614): status, metadata, active_since,
--                         deadline_at, updated_at, session_id.
--   session_pending_questions (~line 2803): session_id, answered_at — "still
--                         open" is answered_at IS NULL, which is also the
--                         partial index predicate (session_pending_questions_
--                         open_idx), so the EXISTS subquery below is cheap.
--   usage_events          (~line 2460): session_id, created_at.

SELECT
  coalesce(s.metadata->>'stopReason', '(unrecorded)') AS stop_reason,
  CASE
    -- Reasons that already say exactly which path fired — no inference
    -- needed. Ordered to match apps/api/src/projects/stop-reason.ts.
    WHEN s.metadata->>'stopReason' = 'run_cap'                    THEN 'C (run cap)'
    -- Declared in StopReason, never emitted today (Caveat 1). Kept as an
    -- explicit arm so the day a writer starts setting them, this query
    -- reflects it immediately instead of falling through to the heuristic.
    WHEN s.metadata->>'stopReason' = 'idle_grace'                 THEN 'B (idle-grace, emitted)'
    WHEN s.metadata->>'stopReason' = 'boot_floor_expired'         THEN 'A-prime (boot-floor, emitted)'
    WHEN s.metadata->>'stopReason' = 'provider_reconcile'         THEN 'D (provider reconcile)'
    WHEN s.metadata->>'stopReason' = 'provider_removed'           THEN 'D2 (provider removed)'
    WHEN s.metadata->>'stopReason' = 'runtime_wake_failed'        THEN 'wake-failed'
    WHEN s.metadata->>'stopReason' = 'runtime_boot_failed'        THEN 'boot-failed'
    WHEN s.metadata->>'stopReason' = 'restart_failed'             THEN 'restart-failed'
    WHEN s.metadata->>'stopReason' = 'provisioning_stalled'       THEN 'provisioning-stalled'
    WHEN s.metadata->>'stopReason' = 'unusable_runtime_state'     THEN 'control-plane-desync'
    WHEN s.metadata->>'stopReason' = 'manual'                     THEN 'manual'
    WHEN s.metadata->>'stopReason' = 'wedged_backlog_remediation' THEN 'ops-remediation'
    -- Below this line: stopReason is 'deadline_expired' (the default every
    -- deadline park takes today, per Caveat 1) or NULL (Caveat 3). Re-derive
    -- an approximate sub-path from timing and side-table evidence, because
    -- the flat reason cannot make this split on its own.
    --
    -- A box whose ENTIRE life was the 20-minute stopped->active boot floor
    -- never received a turn-start or LLM observation to push deadline_at
    -- past it, so active_since to deadline_at is <= ~21 minutes.
    WHEN s.deadline_at - s.active_since <= interval '21 minutes' THEN 'A-prime (inferred)'
    WHEN EXISTS (
      SELECT 1 FROM kortix.session_pending_questions q
       WHERE q.session_id = s.session_id AND q.answered_at IS NULL
    ) THEN 'B-waiting (inferred)'
    WHEN NOT EXISTS (
      SELECT 1 FROM kortix.usage_events u
       WHERE u.session_id = s.session_id
         AND u.created_at > s.updated_at - interval '4 hours'
    ) THEN 'B-silent-tools (inferred)'
    ELSE 'A (ordinary deadline expiry)'
  END AS path,
  count(*) AS stops,
  round(avg(extract(epoch FROM (s.deadline_at - s.active_since)) / 60)::numeric, 1) AS avg_life_min
FROM kortix.session_sandboxes s
WHERE s.status = 'stopped'
  AND s.updated_at > now() - :'window'::interval
GROUP BY 1, 2
ORDER BY stops DESC;
