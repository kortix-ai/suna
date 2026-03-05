BEGIN;

-- Remove the template_share_links table as we now use direct template ID URLs for sharing
-- This simplifies the sharing system and removes unnecessary complexity

DROP TABLE IF EXISTS template_share_links CASCADE;

COMMIT;
