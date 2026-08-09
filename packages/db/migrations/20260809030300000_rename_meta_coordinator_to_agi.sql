-- Migration: rename the reserved coordinator identity and feature key to AGI.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: Preserve an explicit AGI override if one already exists.
-- Old API builds ignore the new key. New API builds use only the AGI key.
WITH migrated_projects AS (
  SELECT
    project_id,
    metadata #- '{experimental,meta_agent}' AS metadata,
    COALESCE(
    metadata #> '{experimental,agi}',
    metadata #> '{experimental,meta_agent}',
    'false'::jsonb
    ) AS agi_enabled
  FROM kortix.projects
  WHERE metadata #> '{experimental,meta_agent}' IS NOT NULL
)
UPDATE kortix.projects
SET metadata = (
  SELECT jsonb_set(metadata, '{experimental,agi}', agi_enabled, true)
  FROM migrated_projects
  WHERE migrated_projects.project_id = projects.project_id
)
WHERE project_id IN (SELECT project_id FROM migrated_projects);

-- mixed-version-safe: Existing stopped sessions keep their provider artifact.
-- Only the reserved application identity and user-facing sandbox slug change.
UPDATE kortix.project_sessions
SET agent_name = 'agi',
    metadata = CASE
      WHEN metadata->>'sandbox_slug' = 'meta'
        THEN jsonb_set(metadata, '{sandbox_slug}', '"agi"'::jsonb)
      ELSE metadata
    END
WHERE agent_name = 'meta';

-- A stopped session can retain a queued prompt. Rename that executable agent
-- selector so a later resume does not request the removed identity.
UPDATE kortix.project_sessions
SET metadata = jsonb_set(metadata, '{pending_prompt,agent}', '"agi"'::jsonb)
WHERE metadata #>> '{pending_prompt,agent}' = 'meta';

-- Keep provider artifact references unchanged because those immutable images
-- still exist under their original names. Rename only the logical artifact slug.
UPDATE kortix.session_sandboxes
SET metadata = jsonb_set(metadata, '{runtimeArtifact,sandboxSlug}', '"agi"'::jsonb)
WHERE metadata #>> '{runtimeArtifact,sandboxSlug}' = 'meta';

UPDATE kortix.project_tasks
SET assignee_agent = 'agi'
WHERE assignee_agent = 'meta';

UPDATE kortix.project_tasks
SET origin = 'agi'
WHERE origin = 'meta';

-- Pending lifecycle commands are executable state, not audit history. Rewrite
-- the selected agent and the internal trust marker before a worker retries them.
UPDATE kortix.session_lifecycle_commands
SET payload = jsonb_set(payload, '{body,agent_name}', '"agi"'::jsonb)
WHERE payload #>> '{body,agent_name}' = 'meta';

UPDATE kortix.session_lifecycle_commands
SET payload = jsonb_set(
  payload - 'platformMetaGoalPush',
  '{platformAgiGoalPush}',
  COALESCE(
    payload->'platformAgiGoalPush',
    payload->'platformMetaGoalPush',
    'false'::jsonb
  ),
  true
)
WHERE payload ? 'platformMetaGoalPush';

-- Session-bound tokens must retain the reserved-principal deny policy after
-- the identity rename. This update changes no capabilities.
UPDATE kortix.account_tokens
SET agent_grant = jsonb_set(agent_grant, '{agent}', '"agi"'::jsonb)
WHERE agent_grant->>'agent' = 'meta';
