-- Migration: audit_webhook_deliveries_drop_event_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: drop FK audit_delivery_event_fk (audit_webhook_deliveries.event_id ->
--   audit_events.event_id).
--   Lock: ALTER TABLE ... DROP CONSTRAINT on a foreign key takes ACCESS EXCLUSIVE on BOTH
--   audit_webhook_deliveries (0 rows in prod) and audit_events (verified in pg_locks on
--   PostgreSQL 15). It is a catalog change (two pg_constraint rows and the RI triggers):
--   milliseconds once the lock is granted. lock_timeout 2 s bounds the wait behind
--   in-flight audit INSERTs; on 55P03 re-run the failed job, never raise the timeout.
--
-- WHY: the next migrations replace audit_events with a table partitioned by
--   occurred_at. A partitioned table's primary key must include the partition key
--   (event_id, occurred_at), so nothing can reference event_id alone. The delivery
--   queue joins by event_id (audit-webhooks.ts) and keeps working without the FK.
--   What the FK gave: delivery rows deleted with their event. Nothing deletes an event
--   except retention (partition drop), which now also leaves the delivery row; a
--   delivery older than the 90-day hot window is already delivered or dead-lettered.
--
-- LOCK ORDER (found by a concurrent-writer test, PostgreSQL 15): an audit INSERT holds ROW
--   EXCLUSIVE on audit_events and then needs ROW EXCLUSIVE on audit_webhook_deliveries (the
--   AFTER INSERT trigger runs an INSERT ... SELECT into it, even when no webhook matches). A bare
--   ALTER TABLE on the deliveries table locks deliveries first and audit_events second: it
--   deadlocked with live writers (40P01). The migration therefore takes audit_events first, the
--   order every writer uses, and only then touches the deliveries table.
--
-- mixed-version-safe: no application code names this constraint. Old code inserts into
--   audit_webhook_deliveries only through the audit_events AFTER INSERT trigger, which
--   does not depend on the FK. Removing a check cannot make an old write fail.
--
-- ROLL BACK: no down migration (repo policy). Re-adding it needs a unique index on
--   audit_events(event_id) alone, which a partitioned table cannot have; do not re-add.
LOCK TABLE kortix.audit_events IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE kortix.audit_webhook_deliveries DROP CONSTRAINT IF EXISTS audit_delivery_event_fk;
