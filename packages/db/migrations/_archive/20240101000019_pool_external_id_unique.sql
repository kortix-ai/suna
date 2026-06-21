-- Prevent duplicate external_id entries for active pool sandboxes.
-- Only enforced for 'provisioning' and 'ready' statuses (claimed sandboxes are deleted).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_sandboxes_external_id_active
  ON kortix.pool_sandboxes (external_id)
  WHERE status IN ('provisioning', 'ready');
