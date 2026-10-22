-- Migration: audit_events_partitioned_next
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: create the NEW, EMPTY, range-partitioned audit table `audit_events_next`, its
--   weekly partitions, its indexes and triggers, and the function that adds partitions.
--   Every statement creates a new object or replaces a function body: no lock on any
--   existing table (audit_events is read once, for its grants). Nothing writes to the
--   new table yet; the next migration swaps it in.
--
-- WHY: one unpartitioned heap with 11 btrees for an append-only series that never
--   shrinks has a working set that grows with history (210 GB, 145M rows, 4 GB
--   shared_buffers), so random-key index inserts fall off a cache cliff and the ingest
--   statement times out (503). Weekly partitions bound the hot set to the newest
--   partition and make retention a detach and drop of a partition instead of a DELETE.
--
-- Constraints that follow from partitioning (PostgreSQL 15):
--   * the primary key and every unique index include the partition key occurred_at.
--     The dedupe key becomes (source_ledger, source_record_id, phase,
--     coalesce(source_revision,''), occurred_at). A relay retry carries the same
--     occurred_at (the daemon stamps it before spooling), so it still conflicts.
--   * no FK can reference event_id alone (the previous migration removed the only one).
--   * PostgreSQL 15 clones BEFORE/AFTER row triggers onto every partition, new ones too.
--
-- Indexes are created on the parent: each partition gets its own copy. Names carry the
-- `_next` infix until the swap migration renames them, because the live table still
-- owns the unsuffixed names. Same set as the live table, minus the hash-keyed
-- resource index removed earlier; request/correlation become partial (NULL for 52% and
-- 68% of rows).
--
-- Partitions: weekly, Monday 00:00 UTC. kortix.audit_events_ensure_partitions creates a
-- table with LIKE and ATTACHes it. That is deliberate: CREATE TABLE ... PARTITION OF takes
-- ACCESS EXCLUSIVE on the parent (verified in pg_locks on PostgreSQL 15), ATTACH PARTITION
-- takes only SHARE UPDATE EXCLUSIVE on the parent (inserts keep flowing), ACCESS EXCLUSIVE on
-- the new, empty child, and ACCESS EXCLUSIVE on the DEFAULT partition (it scans that partition
-- to prove no row belongs to the new range; it is empty or nearly so).
-- A DEFAULT partition, audit_events_default, catches a row whose occurred_at has no weekly
-- partition (a sandbox offline for months, a skewed clock). Without it that INSERT fails, and
-- 9 source-table triggers run the audit INSERT inside the business transaction, so the failure
-- would abort a connector call or a session status change. A BEFORE INSERT trigger on the
-- parent cannot move such a row: PostgreSQL routes the tuple before the leaf trigger runs.
-- The ingest route clamps daemon-stamped instants itself, so the default stays empty. If it
-- is not empty, ensure_partitions moves the rows of a week into that week's new partition
-- before attaching it (PostgreSQL refuses the ATTACH otherwise), and the archive job logs it.
--
-- ROLL BACK: a forward migration that removes kortix.audit_events_next (CASCADE; nothing
--   references it before the swap) and kortix.audit_events_ensure_partitions.
CREATE OR REPLACE FUNCTION kortix.audit_events_ensure_partitions(
  parent regclass,
  first_week date,
  weeks_ahead integer
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = kortix, public
AS $$
DECLARE
  week_start date := date_trunc('week', first_week)::date;
  last_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date + weeks_ahead * 7;
  range_from text;
  range_to text;
  previous_maintenance text := COALESCE(current_setting('kortix.audit_maintenance', true), 'off');
  partition_name text;
  created integer := 0;
BEGIN
  -- Two replicas can run the daily job at once. Serialise them: concurrent CREATE TABLE of
  -- one name fails inside the catalog with a unique violation, not duplicate_table.
  PERFORM pg_advisory_xact_lock(hashtextextended('kortix.audit_events_ensure_partitions', 0));
  WHILE week_start <= last_week LOOP
    partition_name := 'audit_events_p' || to_char(week_start, 'YYYYMMDD');
    range_from := to_char(week_start, 'YYYY-MM-DD') || ' 00:00:00+00';
    range_to := to_char(week_start + 7, 'YYYY-MM-DD') || ' 00:00:00+00';
    IF to_regclass(format('kortix.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE kortix.%I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
        partition_name, parent);
      -- Rows that landed in the default partition for this week must move first.
      PERFORM set_config('kortix.audit_maintenance', 'on', true);
      EXECUTE format(
        'WITH moved AS (DELETE FROM kortix.audit_events_default WHERE occurred_at >= %L AND occurred_at < %L RETURNING *)
         INSERT INTO kortix.%I SELECT * FROM moved',
        range_from, range_to, partition_name);
      PERFORM set_config('kortix.audit_maintenance', previous_maintenance, true);
      EXECUTE format(
        'ALTER TABLE %s ATTACH PARTITION kortix.%I FOR VALUES FROM (%L) TO (%L)',
        parent, partition_name, range_from, range_to);
      created := created + 1;
    END IF;
    week_start := week_start + 7;
  END LOOP;
  RETURN created;
END;
$$;--> statement-breakpoint

CREATE TABLE kortix.audit_events_next (LIKE kortix.audit_events INCLUDING DEFAULTS)
  PARTITION BY RANGE (occurred_at);--> statement-breakpoint

CREATE TABLE kortix.audit_events_default PARTITION OF kortix.audit_events_next DEFAULT;--> statement-breakpoint

-- The table was created empty in this migration and nothing reads or writes it yet.
-- squawk-ignore adding-serial-primary-key-field
ALTER TABLE kortix.audit_events_next ADD CONSTRAINT audit_events_next_pkey PRIMARY KEY (event_id, occurred_at);--> statement-breakpoint

CREATE INDEX idx_audit_events_next_account_time
  ON kortix.audit_events_next (account_id, occurred_at);--> statement-breakpoint
CREATE INDEX idx_audit_events_next_actor_time
  ON kortix.audit_events_next (actor_user_id, occurred_at);--> statement-breakpoint
CREATE INDEX idx_audit_events_next_account_project_time
  ON kortix.audit_events_next (account_id, project_id, occurred_at);--> statement-breakpoint
CREATE INDEX idx_audit_events_next_account_session_time
  ON kortix.audit_events_next (account_id, session_id, occurred_at);--> statement-breakpoint
-- Per-session log order: (session_sequence NULLS LAST, event_id). New rows have no
-- sequence, so within a partition this is event_id order for one session.
CREATE INDEX idx_audit_events_next_session_sequence
  ON kortix.audit_events_next (session_id, session_sequence, event_id);--> statement-breakpoint
CREATE UNIQUE INDEX idx_audit_events_next_source_phase
  ON kortix.audit_events_next
    (source_ledger, source_record_id, phase, (coalesce(source_revision, '')), occurred_at)
  WHERE source_ledger IS NOT NULL AND source_record_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_audit_events_next_action_pattern
  ON kortix.audit_events_next (action text_pattern_ops);--> statement-breakpoint
CREATE INDEX idx_audit_events_next_request
  ON kortix.audit_events_next (request_id) WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_audit_events_next_correlation
  ON kortix.audit_events_next (correlation_id) WHERE correlation_id IS NOT NULL;--> statement-breakpoint
-- Serves "newest events" (ORDER BY occurred_at DESC LIMIT n) and the 24 h count in the ops
-- overview. A btree, not BRIN: BRIN cannot return rows in order. Append-only in time, so
-- its insert hot spot is the right-most leaf.
CREATE INDEX idx_audit_events_next_occurred_at
  ON kortix.audit_events_next (occurred_at);--> statement-breakpoint

CREATE TRIGGER audit_events_prepare
BEFORE INSERT ON kortix.audit_events_next
FOR EACH ROW EXECUTE FUNCTION kortix.audit_prepare_event();--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON kortix.audit_events_next
FOR EACH ROW EXECUTE FUNCTION kortix.audit_reject_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_enqueue_webhooks
AFTER INSERT ON kortix.audit_events_next
FOR EACH ROW EXECUTE FUNCTION kortix.audit_enqueue_webhooks();--> statement-breakpoint

-- Same grants as the live table (LIKE copies none). Partitions need no grants: a query
-- through the parent checks the parent's ACL.
DO $$
DECLARE
  grant_row record;
BEGIN
  FOR grant_row IN
    SELECT a.grantee, string_agg(DISTINCT a.privilege_type, ', ') AS privileges
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'kortix.audit_events'::regclass
       AND a.grantee <> 0
       AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER', 'TRUNCATE')
     GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT %s ON kortix.audit_events_next TO %I',
                   grant_row.privileges, (SELECT rolname FROM pg_roles WHERE oid = grant_row.grantee));
  END LOOP;
END;
$$;--> statement-breakpoint

-- Weeks from 85 days back (late relay flushes carry old occurred_at; the ingest route accepts
-- up to 80 days) through 8 weeks ahead.
SELECT kortix.audit_events_ensure_partitions('kortix.audit_events_next', (current_date - 85)::date, 8);
