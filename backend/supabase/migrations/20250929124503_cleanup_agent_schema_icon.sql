BEGIN;

-- ============================================================================
-- AGENT SCHEMA CLEANUP MIGRATION
-- Remove outdated fields and consolidate icon system
-- ============================================================================

-- 1. Remove outdated fields from AGENTS table
ALTER TABLE agents 
    DROP COLUMN IF EXISTS avatar,
    DROP COLUMN IF EXISTS avatar_color,
    DROP COLUMN IF EXISTS profile_image_url;

-- 2. Remove outdated fields from AGENT_TEMPLATES table  
ALTER TABLE agent_templates
    DROP COLUMN IF EXISTS avatar,
    DROP COLUMN IF EXISTS avatar_color,
    DROP COLUMN IF EXISTS profile_image_url;

-- 3. Remove tags from AGENT_TEMPLATES (redundant with description)
-- Note: Keeping tags in agent_templates for now as they're used for marketplace filtering
-- Consider removing in future if description becomes primary categorization method

-- 4. Add constraints to ensure icon system integrity
ALTER TABLE agents 
    ADD CONSTRAINT agents_icon_color_format 
        CHECK (icon_color IS NULL OR icon_color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT agents_icon_background_format 
        CHECK (icon_background IS NULL OR icon_background ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE agent_templates
    ADD CONSTRAINT agent_templates_icon_color_format 
        CHECK (icon_color IS NULL OR icon_color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT agent_templates_icon_background_format 
        CHECK (icon_background IS NULL OR icon_background ~ '^#[0-9A-Fa-f]{6}$');

-- 5. Update any NULL icon values to sensible defaults
UPDATE agents 
SET 
    icon_name = COALESCE(icon_name, 'brain'),
    icon_color = COALESCE(icon_color, '#000000'),
    icon_background = COALESCE(icon_background, '#F3F4F6')
WHERE icon_name IS NULL OR icon_color IS NULL OR icon_background IS NULL;

UPDATE agent_templates
SET 
    icon_name = COALESCE(icon_name, 'brain'),
    icon_color = COALESCE(icon_color, '#000000'), 
    icon_background = COALESCE(icon_background, '#F3F4F6')
WHERE icon_name IS NULL OR icon_color IS NULL OR icon_background IS NULL;

-- 6. Add NOT NULL constraints after setting defaults
ALTER TABLE agents 
    ALTER COLUMN icon_name SET NOT NULL,
    ALTER COLUMN icon_color SET NOT NULL,
    ALTER COLUMN icon_background SET NOT NULL;

ALTER TABLE agent_templates
    ALTER COLUMN icon_name SET NOT NULL,
    ALTER COLUMN icon_color SET NOT NULL, 
    ALTER COLUMN icon_background SET NOT NULL;

-- 7. Drop indexes on removed columns (if they exist)
DROP INDEX IF EXISTS idx_agents_avatar;
DROP INDEX IF EXISTS idx_agents_profile_image_url;
DROP INDEX IF EXISTS idx_agent_templates_profile_image_url;

-- 8. Update comments to reflect current state
COMMENT ON COLUMN agents.icon_name IS 'Lucide React icon name for agent visual representation';
COMMENT ON COLUMN agents.icon_color IS 'Hex color code for icon (format: #RRGGBB)';
COMMENT ON COLUMN agents.icon_background IS 'Hex color code for icon background (format: #RRGGBB)';

COMMENT ON COLUMN agent_templates.icon_name IS 'Lucide React icon name for template visual representation';
COMMENT ON COLUMN agent_templates.icon_color IS 'Hex color code for icon (format: #RRGGBB)';
COMMENT ON COLUMN agent_templates.icon_background IS 'Hex color code for icon background (format: #RRGGBB)';

COMMIT;
