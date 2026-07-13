-- The active sandbox provider set is exactly Daytona, Platinum, and E2B.
--
-- `kortix.sandboxes` is the retired /instances audit table and contains old
-- Hetzner/JustAVPS/local rows. Preserve those strings as historical data while
-- moving that column off the active provider enum. Current project/session
-- runtime tables remain enum-constrained.

DROP TABLE IF EXISTS kortix.pool_sandboxes;
DROP TABLE IF EXISTS kortix.pool_resources;

ALTER TABLE kortix.sandboxes ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE kortix.sandboxes
  ALTER COLUMN provider TYPE text USING provider::text;
ALTER TABLE kortix.sandboxes ALTER COLUMN provider SET DEFAULT 'daytona';

-- `managed` was a short-lived alias for Daytona. It was never a distinct
-- runtime and can be normalized without changing provider identity.
UPDATE kortix.project_sessions
SET sandbox_provider = 'daytona'
WHERE sandbox_provider::text = 'managed';

UPDATE kortix.session_sandboxes
SET provider = 'daytona'
WHERE provider::text = 'managed';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM kortix.project_sessions
    WHERE sandbox_provider::text NOT IN ('daytona', 'platinum')
  ) OR EXISTS (
    SELECT 1 FROM kortix.session_sandboxes
    WHERE provider::text NOT IN ('daytona', 'platinum')
  ) THEN
    RAISE EXCEPTION 'active runtime rows contain an unsupported sandbox provider';
  END IF;
END $$;

ALTER TABLE kortix.project_sessions ALTER COLUMN sandbox_provider DROP DEFAULT;
ALTER TABLE kortix.session_sandboxes ALTER COLUMN provider DROP DEFAULT;

-- PostgreSQL will not rewrite a column named in a trigger definition. Remove
-- the identity guard only for the transactional enum rewrite and restore the
-- exact same fail-closed trigger before this migration commits.
DROP TRIGGER IF EXISTS trg_session_sandbox_identity_immutable
  ON kortix.session_sandboxes;

ALTER TABLE kortix.project_sessions
  ALTER COLUMN sandbox_provider TYPE text USING sandbox_provider::text;
ALTER TABLE kortix.session_sandboxes
  ALTER COLUMN provider TYPE text USING provider::text;

DROP TYPE kortix.sandbox_provider;
CREATE TYPE kortix.sandbox_provider AS ENUM ('daytona', 'platinum', 'e2b');

ALTER TABLE kortix.project_sessions
  ALTER COLUMN sandbox_provider TYPE kortix.sandbox_provider
  USING sandbox_provider::kortix.sandbox_provider;
ALTER TABLE kortix.session_sandboxes
  ALTER COLUMN provider TYPE kortix.sandbox_provider
  USING provider::kortix.sandbox_provider;

ALTER TABLE kortix.project_sessions
  ALTER COLUMN sandbox_provider SET DEFAULT 'daytona'::kortix.sandbox_provider;
ALTER TABLE kortix.session_sandboxes
  ALTER COLUMN provider SET DEFAULT 'daytona'::kortix.sandbox_provider;

CREATE TRIGGER trg_session_sandbox_identity_immutable
BEFORE UPDATE OF external_id, provider OR DELETE
ON kortix.session_sandboxes
FOR EACH ROW
EXECUTE FUNCTION kortix.guard_session_sandbox_identity();

ALTER TABLE kortix.sandbox_compute_sessions
  ADD COLUMN provider kortix.sandbox_provider;

-- Preserve historical provider attribution wherever the owning session sandbox
-- still exists; only genuinely orphaned legacy windows fall back to Daytona.
UPDATE kortix.sandbox_compute_sessions AS compute
SET provider = sandbox.provider
FROM kortix.session_sandboxes AS sandbox
WHERE compute.sandbox_id = sandbox.sandbox_id;

UPDATE kortix.sandbox_compute_sessions
SET provider = 'daytona'::kortix.sandbox_provider
WHERE provider IS NULL;

ALTER TABLE kortix.sandbox_compute_sessions
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider SET DEFAULT 'daytona'::kortix.sandbox_provider;

CREATE INDEX idx_sandbox_compute_sessions_provider_time
  ON kortix.sandbox_compute_sessions (provider, started_at DESC);
