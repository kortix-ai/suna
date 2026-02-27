BEGIN;

ALTER TABLE agents 
ADD COLUMN IF NOT EXISTS icon_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS icon_color VARCHAR(7) DEFAULT '#000000',
ADD COLUMN IF NOT EXISTS icon_background VARCHAR(7) DEFAULT '#F3F4F6';

ALTER TABLE agent_templates
ADD COLUMN IF NOT EXISTS icon_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS icon_color VARCHAR(7) DEFAULT '#000000',
ADD COLUMN IF NOT EXISTS icon_background VARCHAR(7) DEFAULT '#F3F4F6';

CREATE INDEX IF NOT EXISTS idx_agents_icon_name ON agents(icon_name) WHERE icon_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_templates_icon_name ON agent_templates(icon_name) WHERE icon_name IS NOT NULL;

COMMENT ON COLUMN agents.icon_name IS 'Optional: Lucide React icon name for agent profile (used when profile_image_url is not set)';
COMMENT ON COLUMN agents.icon_color IS 'Optional: Hex color for the icon (e.g., #000000)';
COMMENT ON COLUMN agents.icon_background IS 'Optional: Hex background color for the icon container';

COMMENT ON COLUMN agent_templates.icon_name IS 'Optional: Lucide React icon name for template profile (used when profile_image_url is not set)';
COMMENT ON COLUMN agent_templates.icon_color IS 'Optional: Hex color for the icon (e.g., #000000)';
COMMENT ON COLUMN agent_templates.icon_background IS 'Optional: Hex background color for the icon container';

COMMIT;