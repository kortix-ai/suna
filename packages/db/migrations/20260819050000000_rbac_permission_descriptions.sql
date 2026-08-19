-- Migration: rbac_permission_descriptions
--
-- `kortix.permissions.description` is what the role-capability matrix renders
-- next to each checkbox. The seed in 20260819015724479 omitted the column, so
-- all 69 rows carry '' and the web falls back to a humanized dotted string
-- ("Project · Gitops · Push") — which tells an admin nothing about what the
-- permission actually lets someone do. That fallback is the reason the matrix
-- has always been hard to reason about; the catalog is data now, so the
-- explanation belongs in the row.
--
-- One sentence per permission, present tense, naming the capability rather than
-- restating the action string. Written here rather than in `iam/actions.ts`
-- because the catalog IS the table: the API serves these strings straight to
-- `GET /accounts/:id/iam/permissions`.
--
-- backfill-safe: the only DML is an UPDATE of a 69-row catalog table nothing
-- writes at runtime. No user data, no scan of a large table, no lock held past
-- the statement.
--
-- mixed-version-safe: a text column changes value. An older replica reads the
-- new descriptions and renders them; nothing branches on the string.

set lock_timeout = '2s';
set statement_timeout = '30s';

UPDATE kortix.permissions p
   SET description = v.description
  FROM (VALUES
  -- Account scope
  ('account.read',              'View the account: its name, members and settings.'),
  ('account.write',             'Rename the account and change its settings, including the MFA requirement.'),
  ('account.delete',            'Permanently delete the account and everything in it.'),
  ('audit.read',                'Read the audit log of who changed what, and when.'),
  ('billing.read',              'View the plan, credit balance, invoices and usage.'),
  ('billing.write',             'Change the plan, payment method and spending limits.'),
  ('group.read',                'View groups and who belongs to them.'),
  ('group.create',              'Create a group.'),
  ('group.update',              'Rename a group or change its description.'),
  ('group.delete',              'Delete a group, removing every grant it carried.'),
  ('group.members.manage',      'Add people to a group and remove them from it.'),
  ('member.read',               'View the member directory.'),
  ('member.invite',             'Invite people to the account.'),
  ('member.update',             'Change a member''s account role.'),
  ('member.remove',             'Remove a member from the account and revoke their tokens.'),
  ('member.super_admin.grant',  'Grant or revoke super-admin, the hard bypass over every permission check.'),
  ('policy.read',               'View which principals hold which roles.'),
  ('policy.create',             'Assign a role to a person, group or agent identity.'),
  ('policy.delete',             'Revoke a role assignment.'),
  ('project.create',            'Create a project in this account.'),
  ('role.read',                 'View roles and the permissions they carry.'),
  ('role.create',               'Create a custom role.'),
  ('role.update',               'Rename a custom role or change the permissions it carries.'),
  ('role.delete',               'Delete a custom role, revoking every assignment of it.'),
  ('token.read',                'View the account''s personal access tokens.'),
  ('token.create',              'Mint a personal access token for this account.'),
  ('token.revoke',              'Revoke a personal access token.'),

  -- Project scope
  ('project.read',              'Open the project and see its workspace.'),
  ('project.write',             'Change the project: its settings, configuration and contents.'),
  ('project.delete',            'Archive or permanently delete the project.'),
  ('project.file.read',         'Read files in the project workspace.'),
  ('project.file.write',        'Create, edit and delete files in the project workspace.'),
  ('project.session.read',      'View sessions and their transcripts.'),
  ('project.session.start',     'Start a session and send prompts to an agent.'),
  ('project.session.stop',      'Stop a running session.'),
  ('project.session.bindings.write', 'Bind a session to a channel, such as a Slack conversation.'),
  ('project.customize.read',    'View the project''s configuration.'),
  ('project.customize.write',   'Change the project''s configuration, including feature flags and the sandbox provider.'),
  ('project.agent.read',        'View the agents declared by this project.'),
  ('project.agent.write',       'Add, edit and remove agents.'),
  ('project.skill.read',        'View the skills declared by this project.'),
  ('project.skill.write',       'Add, edit and remove skills.'),
  ('project.command.read',      'View the project''s slash commands.'),
  ('project.command.write',     'Add, edit and remove slash commands.'),
  ('project.connector.read',    'View the project''s connectors.'),
  ('project.connector.write',   'Add, edit and remove connectors.'),
  ('project.connector.connections.manage', 'Manage everyone''s connector connections, not only your own.'),
  ('project.secret.read',       'See which secrets exist and where they are used. Never their values.'),
  ('project.secret.write',      'Set and remove secret values.'),
  ('project.credentials.issue', 'Mint or revoke a project credential — a CLI token or a Git token that outlives the request.'),
  ('project.trigger.read',      'View triggers and when they last fired.'),
  ('project.trigger.create',    'Create a trigger.'),
  ('project.trigger.update',    'Change a trigger''s schedule, prompt or agent.'),
  ('project.trigger.delete',    'Delete a trigger.'),
  ('project.trigger.fire',      'Fire a trigger by hand.'),
  ('project.gitops.read',       'View the repository, its branches and its history.'),
  ('project.gitops.push',       'Push commits to the project repository.'),
  ('project.gitops.merge',      'Merge a change request into the default branch.'),
  ('project.review.read',       'View change requests and their diffs.'),
  ('project.review.submit',     'Open a change request for review.'),
  ('project.review.act',        'Approve, request changes on, or close a change request.'),
  ('project.members.read',      'View who has access to this project.'),
  ('project.members.manage',    'Grant and revoke access to this project, including per-agent grants.'),
  ('project.app.read',          'View the project''s Apps.'),
  ('project.app.write',         'Create, edit and remove Apps.'),
  ('project.app.deploy',        'Deploy an App and manage its live version.'),
  ('project.gateway.spend.read', 'View model spend for this project.'),
  ('project.gateway.logs.read', 'Read the gateway request log, including prompts and responses.'),
  ('project.gateway.budget.set', 'Set the project''s model-spend budget.'),
  ('project.gateway.keys.manage', 'Manage the project''s own model provider keys.')
) AS v(action, description)
 WHERE p.action = v.action;

COMMENT ON COLUMN kortix.permissions.description IS
  'One sentence, rendered next to the permission in the role-capability matrix. Never empty — see the seed test.';
