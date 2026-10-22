-- Migration: audit_activity_rls
--
-- 20261022170931196_audit_activity_daily created kortix.audit_activity_daily and
-- kortix.audit_activity_rollup without row level security. PostgREST exposes the
-- kortix schema, so every table has RLS on and no client role holds a privilege
-- on it (pentest M-3, integration-kortix-rls.test.ts). Only the API's privileged
-- connection reads and writes the rollup. Additive: no column or data change.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.audit_activity_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.audit_activity_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.audit_activity_daily FROM anon, authenticated;
REVOKE ALL ON kortix.audit_activity_rollup FROM anon, authenticated;
