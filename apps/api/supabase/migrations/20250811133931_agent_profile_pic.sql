BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

UPDATE agents
SET profile_image_url = COALESCE(profile_image_url, (metadata->>'profile_image_url'))
WHERE profile_image_url IS NULL AND metadata ? 'profile_image_url';

UPDATE agent_templates
SET profile_image_url = COALESCE(profile_image_url, (metadata->>'profile_image_url'))
WHERE profile_image_url IS NULL AND metadata ? 'profile_image_url';

COMMIT;
