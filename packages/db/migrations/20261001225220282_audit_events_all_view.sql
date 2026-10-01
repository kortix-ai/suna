-- Migration: audit_events_all_view
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: one new view, kortix.audit_events_all, `SELECT * FROM kortix.audit_events`,
--   with the same grants as the table. CREATE VIEW takes no lock on audit_events
--   (it records a dependency in the catalog only). No data is read.
--
-- WHY: expand step of the partitioning cutover (the next PR). Every audit READ
--   goes through this relation. Today it is an identity view the planner flattens
--   away (same plans as the table). The cutover redefines it as
--   audit_events (partitioned, new rows) UNION ALL audit_events_legacy (old rows),
--   so reads never see the swap. Writes keep the table name.
--
-- Mixed-version deploy: the migration only adds an object. Old code keeps reading
--   audit_events directly, which still holds every row until the cutover.
--
-- ROLL BACK: no down migration (repo policy). Roll the app back; the view stays unused.
--   To remove it: a forward migration that removes the view (nothing else depends on it).
--
-- `SELECT *` is expanded once, here. A later ADD COLUMN on audit_events must also
-- recreate this view, or the new column is missing from every read; the audit DB
-- suite (audit-events-read-view.integration.test.ts) fails when the columns differ.
CREATE VIEW kortix.audit_events_all AS SELECT * FROM kortix.audit_events;--> statement-breakpoint

-- Copy the table's grants. A view has its own ACL; roles that may read the table
-- must be able to read the view.
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
    EXECUTE format('GRANT %s ON kortix.audit_events_all TO %I',
                   grant_row.privileges, (SELECT rolname FROM pg_roles WHERE oid = grant_row.grantee));
  END LOOP;
END;
$$;
