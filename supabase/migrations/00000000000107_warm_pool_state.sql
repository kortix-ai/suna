-- Warm sandbox pool: per-project pre-booted sandboxes ready to claim.
-- See docs/specs/warm-pool.md. pool_state is NULL for normal session
-- sandboxes; 'booting' | 'parked' | 'claimed' for pool sandboxes.
ALTER TABLE kortix.session_sandboxes
  ADD COLUMN IF NOT EXISTS pool_state text;

-- Hot path for the atomic claim: WHERE project_id = $1 AND pool_state = 'parked'.
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_pool
  ON kortix.session_sandboxes (project_id, pool_state);
