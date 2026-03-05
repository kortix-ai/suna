BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar VARCHAR(10);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(7);

UPDATE agents 
SET 
    avatar = config->'metadata'->>'avatar',
    avatar_color = config->'metadata'->>'avatar_color'
WHERE 
    config ? 'metadata' AND 
    (config->'metadata' ? 'avatar' OR config->'metadata' ? 'avatar_color');

CREATE INDEX IF NOT EXISTS idx_agents_avatar ON agents(avatar);
CREATE INDEX IF NOT EXISTS idx_agents_avatar_color ON agents(avatar_color);

COMMENT ON COLUMN agents.avatar IS 'Agent avatar emoji';
COMMENT ON COLUMN agents.avatar_color IS 'Agent avatar background color (hex)';

COMMIT; 