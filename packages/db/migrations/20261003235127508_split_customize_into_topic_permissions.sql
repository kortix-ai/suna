-- Migration: split_customize_into_topic_permissions
--
-- EXPAND half of retiring `project.customize.read` / `project.customize.write`.
--
-- WHY. `project.customize.write` was one leaf for five unrelated topics: project
-- settings (name, sandbox provider, feature flags, repository), the sandbox
-- environment (templates, snapshot rebuilds), models and gateway routing (its
-- GET routes too), the default agent and agent config (beside
-- `project.agent.write`, which the agent scope route already used), and a
-- redundant second check on project delete. `project.customize.read` only hid
-- the raw manifest on /detail, which `project.file.read` now governs. One leaf
-- per topic:
--
--   project.settings.write  project.sandbox.write
--   project.model.read      project.model.write
--   (agent config, default agent -> project.agent.write, already in the catalog)
--
-- This migration ADDS the four rows, grants them to every role that holds the
-- old leaves (system and custom, so nobody loses or gains a capability), and
-- rewrites `implies` arrays that name the old leaves (the role editor ticks
-- implied leaves; a retired one there would be saved into a role).
--
-- It does NOT delete the old rows or their grants. `project.customize.*` stays
-- in `permissions` and `role_permissions` until a later CONTRACT migration:
-- replicas still running the previous release assert it during the rollout.
-- The new API filters catalog rows it does not know, so the old leaves are no
-- longer offered or reported.
--
-- mixed-version-safe: purely ADDITIVE (INSERTs, and `implies` UPDATEs that only
-- add leaves and drop the two retired names). Old replicas assert
-- project.customize.* and still find every grant they had. New replicas assert
-- the new leaves and find them granted to exactly the roles that held the old.

-- backfill-safe: kortix.permissions (75 rows in prod) and kortix.role_permissions
-- (123 rows in prod; 2 hold a customize leaf). Catalog tables written only by
-- migrations and the role editor; INSERT ... SELECT and UPDATE touch at most a
-- few dozen rows, under a 2 s lock_timeout.

set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, area, level, description, implies)
VALUES
  ('project.settings.write', 'project', 'project', true, 'project', 'edit',
   'Change project settings: name, description, icon, sandbox provider, feature flags, and the connected repository.',
   ARRAY['project.read']::text[]),
  ('project.sandbox.write', 'project', 'project', true, 'project', 'edit',
   'Manage the project''s sandbox environment: templates and snapshot rebuilds.',
   ARRAY['project.read']::text[]),
  ('project.model.read', 'project', 'project', true, 'customize', 'view',
   'See which models the project may use, its default models, and its gateway routing.',
   ARRAY[]::text[]),
  ('project.model.write', 'project', 'project', true, 'customize', 'edit',
   'Choose which models the project may use, set its default models, and change its gateway routing.',
   ARRAY['project.model.read']::text[])
ON CONFLICT (action) DO NOTHING;

-- Every role that held customize.write gets the five leaves it covered.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT rp.role_id, leaf
  FROM kortix.role_permissions rp
 CROSS JOIN unnest(ARRAY[
   'project.settings.write',
   'project.sandbox.write',
   'project.model.read',
   'project.model.write',
   'project.agent.write'
 ]::text[]) AS leaf
 WHERE rp.action = 'project.customize.write'
ON CONFLICT (role_id, action) DO NOTHING;

-- customize.read was a view of configuration: model.read is its read half.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT rp.role_id, 'project.model.read'
  FROM kortix.role_permissions rp
 WHERE rp.action = 'project.customize.read'
ON CONFLICT (role_id, action) DO NOTHING;

-- Rewrite `implies`: drop the retired names, add what they covered. Sorted and
-- de-duplicated so a re-run is a no-op.
UPDATE kortix.permissions p
   SET implies = (
         SELECT coalesce(array_agg(DISTINCT leaf ORDER BY leaf), ARRAY[]::text[])
           FROM unnest(
                  array_remove(array_remove(p.implies, 'project.customize.write'), 'project.customize.read')
                  || CASE WHEN 'project.customize.write' = ANY (p.implies)
                          THEN ARRAY['project.settings.write', 'project.sandbox.write',
                                     'project.model.read', 'project.model.write',
                                     'project.agent.write']::text[]
                          ELSE ARRAY[]::text[] END
                  || CASE WHEN 'project.customize.read' = ANY (p.implies)
                          THEN ARRAY['project.model.read']::text[]
                          ELSE ARRAY[]::text[] END
                ) AS leaf
          WHERE leaf <> p.action
       ),
       updated_at = now()
 WHERE p.implies && ARRAY['project.customize.write', 'project.customize.read']::text[];
