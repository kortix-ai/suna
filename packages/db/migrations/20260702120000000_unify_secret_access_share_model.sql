-- Up Migration
--
-- Consolidate secret access onto ONE model. For a brief window a project secret
-- could be gated by BOTH the share model (project_secret_grants + share_scope,
-- driven by the Secret "Who can access this" dialog) AND iam_resource_grants
-- (resource_type='secret', driven by the Members "Resource access" card). The
-- two never synced, so a grant made in one place was invisible in the other and
-- the effective audience was their intersection.
--
-- The share model is now the single source of truth for secrets; both surfaces
-- read/write it. Migrate any existing iam_resource_grants secret rows into
-- project_secret_grants so their restrictions are preserved, then drop them.
-- iam_resource_grants keeps only agent/skill rows going forward.

-- 1. Copy each member/department secret grant into the share model, matched to
--    the SHARED secret row by (project, name).
INSERT INTO kortix.project_secret_grants (secret_id, principal_type, principal_id)
SELECT ps.secret_id,
       g.principal_type::kortix.secret_grant_principal,
       g.principal_id
FROM kortix.iam_resource_grants g
JOIN kortix.project_secrets ps
  ON ps.project_id = g.project_id
 AND ps.name = g.resource_id
 AND ps.owner_user_id IS NULL
WHERE g.resource_type = 'secret'
  AND g.principal_type IN ('member', 'group')
ON CONFLICT (secret_id, principal_type, principal_id) DO NOTHING;

-- 2. A previously project-wide secret that just received a grant is now
--    restricted to its allow-list.
UPDATE kortix.project_secrets ps
SET share_scope = 'restricted', updated_at = now()
WHERE ps.owner_user_id IS NULL
  AND ps.share_scope = 'project'
  AND EXISTS (
    SELECT 1 FROM kortix.iam_resource_grants g
    WHERE g.resource_type = 'secret'
      AND g.project_id = ps.project_id
      AND g.resource_id = ps.name
  );

-- 3. Drop the now-redundant iam secret grants.
DELETE FROM kortix.iam_resource_grants WHERE resource_type = 'secret';

-- Down Migration
--
-- Forward-only: secret access is unified on the share model. The two-system
-- split is intentionally not restored.
