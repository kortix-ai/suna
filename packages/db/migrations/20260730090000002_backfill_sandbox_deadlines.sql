-- Migration: backfill_sandbox_deadlines
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 3/7 -- give every LIVE row an evidence-based
-- starting deadline, BEFORE the CHECK (step 4) and the triggers (steps 6/7).
--
-- WHY NOT `active_since = created_at`. That was the obvious backfill and it is
-- a trap. 175 of the 187 running boxes are older than 12h and the oldest is 264
-- hours, so anchoring at creation would make every one of them PERMANENTLY and
-- IRREVERSIBLY expired: step 6 makes active_since immutable within a run, so
-- every later LEAST(active_since + 24h, ...) clamps into the past and no write
-- could rescue the row. Shadow mode's entire purpose is to measure whether
-- these rules would kill LIVE boxes; a backfill that condemns them first makes
-- that measurement unsatisfiable rather than informative.
--
-- So the population is split by EVIDENCE, not by age:
--
--   LIVE cohort       billed LLM progress inside the last 2h. Treated as a box
--                     mid-turn: a fresh anchor and a real 2h window, extendable
--                     normally from here.
--   BACKFILLED cohort everything else. Anchored at most 23h ago -- close enough
--                     to the cap to be honest about the row's age, far enough
--                     inside it that the step-4 CHECK admits the row and later
--                     writes remain expressible. The deadline is derived from
--                     the row's last real evidence, so a genuinely dead
--                     264-hour box lands with a deadline HOURS IN THE PAST and
--                     appears in the very first shadow pass. That is exactly
--                     the comparison we want to see.
--
-- `metadata.deadlineCohort` records which branch each row took. Shadow
-- reporting MUST bucket on it: against a ~150-row backfilled noise floor, a
-- handful of genuine live-cohort false positives is otherwise statistically
-- invisible, and "would_have_been_wrong_rate < 1%" would pass vacuously.
--
-- WHY ONE STATEMENT AND NOT BATCHED. An earlier revision batched this 200 rows
-- at a time with COMMITs between, to bound row-lock hold against the still-live
-- in-sandbox lease reporter writing these same rows at ~3.3 writes/sec. That
-- needs procedural transaction control, which needs the .concurrent.ts
-- noTransaction escape hatch -- and this repo deliberately restricts that hatch
-- to actual CONCURRENTLY operations (enforced by scripts/lint-migrations.ts),
-- for the good reason that opting out of the wrapping transaction throws away
-- the all-or-nothing guarantee. It is also unnecessary at this scale: the
-- candidate set is ~300 rows platform-wide, so this is milliseconds. The
-- safety header is the real bound -- lock_timeout 2s means that if the lease
-- heartbeat is holding these rows, the migration fails LOUDLY and is retried,
-- rather than blocking the deploy or half-applying.
--
-- The LEFT JOIN LATERAL reads through idx_usage_events_session_created, built
-- CONCURRENTLY in step 2 precisely so this max() is an index scan rather than
-- the full-index-plus-heap-fetch the pre-existing session_id-only index forces.
-- Bounded to 30 days: nothing older can influence any branch below.
--
-- `now()` is the transaction timestamp, so every row in this backfill shares
-- one clock -- the cohorts are consistent with each other by construction.
UPDATE "kortix"."session_sandboxes" s
   SET "active_since" = CASE
         WHEN u.last_at IS NOT NULL AND u.last_at > now() - interval '2 hours'
           THEN now()
         ELSE GREATEST(s."created_at", now() - interval '23 hours')
       END,
       "deadline_at" = CASE
         WHEN u.last_at IS NOT NULL AND u.last_at > now() - interval '2 hours'
           THEN now() + interval '2 hours'
         ELSE LEAST(
           GREATEST(s."created_at", now() - interval '23 hours') + interval '24 hours',
           GREATEST(
             s."created_at" + interval '20 minutes',
             COALESCE(u.last_at, s."created_at") + interval '2 hours'
           )
         )
       END,
       "metadata" = COALESCE(s."metadata", '{}'::jsonb) || jsonb_build_object(
         'deadlineCohort',
         CASE
           WHEN u.last_at IS NOT NULL AND u.last_at > now() - interval '2 hours'
             THEN 'live'
           ELSE 'backfilled'
         END
       )
  FROM (
    SELECT sb."sandbox_id", ue.last_at
      FROM "kortix"."session_sandboxes" sb
      LEFT JOIN LATERAL (
        SELECT max(e."created_at") AS last_at
          FROM "kortix"."usage_events" e
         WHERE e."session_id" = sb."session_id"
           AND e."created_at" > now() - interval '30 days'
      ) ue ON true
     WHERE sb."status" IN ('active', 'provisioning')
  ) u
 WHERE s."sandbox_id" = u."sandbox_id";
