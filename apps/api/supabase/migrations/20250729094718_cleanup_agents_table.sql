BEGIN;

CREATE TABLE IF NOT EXISTS agents_backup_cleanup_20250729 AS 
SELECT * FROM agents;

ALTER TABLE agents DROP COLUMN IF EXISTS marketplace_published_at;
ALTER TABLE agents DROP COLUMN IF EXISTS download_count;

ALTER TABLE agents DROP COLUMN IF EXISTS config;

DROP INDEX IF EXISTS idx_agents_marketplace_published_at;
DROP INDEX IF EXISTS idx_agents_download_count;
DROP INDEX IF EXISTS idx_agents_config;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_config_structure_check;

COMMIT; 