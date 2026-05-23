// System roles seeded at startup. Each entry is idempotently upserted into
// kortix.iam_roles (account_id NULL = global system role) along with its
// permissions in kortix.iam_role_permissions.
//
// To add a new role: append to SYSTEM_ROLES, restart the API. To change the
// permission set of an existing role: edit `actions` and restart — the seeder
// reconciles by deleting any actions no longer listed and inserting any new
// ones.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { iamRolePermissions, iamRoles } from '@kortix/db';
import { db } from '../shared/db';
import {
  ACCOUNT_ACTIONS,
  CHANNEL_ACTIONS,
  PROJECT_ACTIONS,
  TRIGGER_ACTIONS,
  type ResourceType,
} from './actions';

type SystemRoleSpec = {
  key: string;
  name: string;
  description: string;
  resourceType: ResourceType;
  actions: readonly string[];
};

// Convenience: flatten an action group into a list of strings.
const all = <T extends Record<string, string>>(group: T): readonly string[] =>
  Object.values(group);

// ─── Account-scoped roles ──────────────────────────────────────────────────

const SUPER_ADMINISTRATOR: SystemRoleSpec = {
  key: 'super_administrator',
  name: 'Super Administrator',
  description: 'Unrestricted access to the entire account. Bypasses policy evaluation.',
  resourceType: 'account',
  // Note: the engine also short-circuits when account_members.is_super_admin
  // is true. This role is the "everything" allowlist for non-super-admin
  // users who still need full reach (e.g. a delegated administrator group).
  actions: [
    ...all(ACCOUNT_ACTIONS),
    ...all(PROJECT_ACTIONS),
    ...all(TRIGGER_ACTIONS),
    ...all(CHANNEL_ACTIONS),
  ],
};

const ADMINISTRATOR: SystemRoleSpec = {
  key: 'administrator',
  name: 'Administrator',
  description: 'Full access except billing and account deletion.',
  resourceType: 'account',
  actions: [
    ...all(ACCOUNT_ACTIONS).filter(
      (a) =>
        a !== ACCOUNT_ACTIONS.ACCOUNT_DELETE &&
        a !== ACCOUNT_ACTIONS.BILLING_WRITE &&
        a !== ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
    ),
    ...all(PROJECT_ACTIONS),
    ...all(TRIGGER_ACTIONS),
    ...all(CHANNEL_ACTIONS),
  ],
};

const ADMINISTRATOR_READ_ONLY: SystemRoleSpec = {
  key: 'administrator_read_only',
  name: 'Administrator Read-Only',
  description: 'Read everything in the account, modify nothing.',
  resourceType: 'account',
  actions: [
    ACCOUNT_ACTIONS.ACCOUNT_READ,
    ACCOUNT_ACTIONS.BILLING_READ,
    ACCOUNT_ACTIONS.AUDIT_READ,
    ACCOUNT_ACTIONS.MEMBER_READ,
    ACCOUNT_ACTIONS.GROUP_READ,
    ACCOUNT_ACTIONS.POLICY_READ,
    ACCOUNT_ACTIONS.ROLE_READ,
    ACCOUNT_ACTIONS.TOKEN_READ,
    PROJECT_ACTIONS.PROJECT_READ,
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
    PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
    PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    TRIGGER_ACTIONS.TRIGGER_READ,
    CHANNEL_ACTIONS.CHANNEL_READ,
  ],
};

const BILLING_MANAGER: SystemRoleSpec = {
  key: 'billing_manager',
  name: 'Billing Manager',
  description: 'Manage billing and subscription. Read-only on everything else.',
  resourceType: 'account',
  actions: [
    ACCOUNT_ACTIONS.ACCOUNT_READ,
    ACCOUNT_ACTIONS.BILLING_READ,
    ACCOUNT_ACTIONS.BILLING_WRITE,
    ACCOUNT_ACTIONS.AUDIT_READ,
  ],
};

// Baseline read access every account member has just by being a member. This
// replaces the old account_role='member' bridge: instead of synthesising these
// reads in the engine, every member gets an explicit policy with this role
// (backfilled for existing members, created on member-add going forward).
const MEMBER: SystemRoleSpec = {
  key: 'member',
  name: 'Member',
  description: 'Baseline read access to the account that every member has.',
  resourceType: 'account',
  actions: [
    ACCOUNT_ACTIONS.ACCOUNT_READ,
    ACCOUNT_ACTIONS.MEMBER_READ,
    ACCOUNT_ACTIONS.GROUP_READ,
    ACCOUNT_ACTIONS.POLICY_READ,
    ACCOUNT_ACTIONS.ROLE_READ,
    ACCOUNT_ACTIONS.AUDIT_READ,
    ACCOUNT_ACTIONS.TOKEN_READ,
    ACCOUNT_ACTIONS.BILLING_READ,
  ],
};

const AUDITOR: SystemRoleSpec = {
  key: 'auditor',
  name: 'Auditor',
  description: 'Read-only access to audit logs and configuration. No data access.',
  resourceType: 'account',
  actions: [
    ACCOUNT_ACTIONS.ACCOUNT_READ,
    ACCOUNT_ACTIONS.AUDIT_READ,
    ACCOUNT_ACTIONS.MEMBER_READ,
    ACCOUNT_ACTIONS.GROUP_READ,
    ACCOUNT_ACTIONS.POLICY_READ,
    ACCOUNT_ACTIONS.ROLE_READ,
  ],
};

// ─── Project-scoped roles ──────────────────────────────────────────────────

const PROJECT_ADMIN: SystemRoleSpec = {
  key: 'project_admin',
  name: 'Project Admin',
  description: 'Full control over the project, including members and triggers.',
  resourceType: 'project',
  actions: [
    ...all(PROJECT_ACTIONS),
  ],
};

const PROJECT_EDITOR: SystemRoleSpec = {
  key: 'project_editor',
  name: 'Project Editor',
  description: 'Read and write within the project, including triggers and webhooks. Cannot manage members or delete the project.',
  resourceType: 'project',
  actions: [
    PROJECT_ACTIONS.PROJECT_READ,
    PROJECT_ACTIONS.PROJECT_WRITE,
    PROJECT_ACTIONS.PROJECT_DEPLOY,
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
    PROJECT_ACTIONS.PROJECT_SESSION_START,
    PROJECT_ACTIONS.PROJECT_SESSION_EXEC,
    PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
    PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    // Triggers/webhooks are project content — an editor managing the
    // project's automation surface needs to create, update, and delete
    // them. Members management + project deletion stay admin-only.
    PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
    PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
    PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
    PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
  ],
};

const PROJECT_VIEWER: SystemRoleSpec = {
  key: 'project_viewer',
  name: 'Project Viewer',
  description: 'Read-only access to the project and its sessions.',
  resourceType: 'project',
  actions: [
    PROJECT_ACTIONS.PROJECT_READ,
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
    PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
    PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  ],
};

const PROJECT_DEPLOYER: SystemRoleSpec = {
  key: 'project_deployer',
  name: 'Project Deployer',
  description: 'Trigger deploys without write access to the code or settings.',
  resourceType: 'project',
  actions: [
    PROJECT_ACTIONS.PROJECT_READ,
    PROJECT_ACTIONS.PROJECT_DEPLOY,
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
  ],
};

// ─── Resource-specific operator roles ──────────────────────────────────────

const TRIGGER_MANAGER: SystemRoleSpec = {
  key: 'trigger_manager',
  name: 'Trigger Manager',
  description: 'Manage and fire an individual trigger.',
  resourceType: 'trigger',
  actions: [
    TRIGGER_ACTIONS.TRIGGER_READ,
    TRIGGER_ACTIONS.TRIGGER_UPDATE,
    TRIGGER_ACTIONS.TRIGGER_DELETE,
    TRIGGER_ACTIONS.TRIGGER_FIRE,
  ],
};

const TRIGGER_VIEWER: SystemRoleSpec = {
  key: 'trigger_viewer',
  name: 'Trigger Viewer',
  description: 'Read-only view of a trigger.',
  resourceType: 'trigger',
  actions: [TRIGGER_ACTIONS.TRIGGER_READ],
};

const CHANNEL_ADMIN: SystemRoleSpec = {
  key: 'channel_admin',
  name: 'Channel Admin',
  description: 'Connect, disconnect, and send through a channel.',
  resourceType: 'channel',
  actions: all(CHANNEL_ACTIONS),
};

const CHANNEL_READER: SystemRoleSpec = {
  key: 'channel_reader',
  name: 'Channel Read',
  description: 'Read-only view of a channel.',
  resourceType: 'channel',
  actions: [CHANNEL_ACTIONS.CHANNEL_READ],
};

export const SYSTEM_ROLES: readonly SystemRoleSpec[] = [
  SUPER_ADMINISTRATOR,
  ADMINISTRATOR,
  ADMINISTRATOR_READ_ONLY,
  MEMBER,
  BILLING_MANAGER,
  AUDITOR,
  PROJECT_ADMIN,
  PROJECT_EDITOR,
  PROJECT_VIEWER,
  PROJECT_DEPLOYER,
  TRIGGER_MANAGER,
  TRIGGER_VIEWER,
  CHANNEL_ADMIN,
  CHANNEL_READER,
];

// Reverse lookup used by the legacy-role bridge in engine.ts.
export const SYSTEM_ROLE_KEY = {
  SUPER_ADMINISTRATOR: SUPER_ADMINISTRATOR.key,
  ADMINISTRATOR: ADMINISTRATOR.key,
  ADMINISTRATOR_READ_ONLY: ADMINISTRATOR_READ_ONLY.key,
  MEMBER: MEMBER.key,
  PROJECT_ADMIN: PROJECT_ADMIN.key,
  PROJECT_EDITOR: PROJECT_EDITOR.key,
  PROJECT_VIEWER: PROJECT_VIEWER.key,
} as const;

/**
 * Upsert every system role and reconcile its permission set.
 *
 * Safe to run on every API boot. Cost is one SELECT + a small number of
 * INSERT/DELETE statements for the rows that changed.
 */
export async function seedSystemRoles(): Promise<void> {
  for (const spec of SYSTEM_ROLES) {
    const [existing] = await db
      .select({ roleId: iamRoles.roleId })
      .from(iamRoles)
      .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, spec.key)))
      .limit(1);

    let roleId: string;
    if (existing) {
      roleId = existing.roleId;
      await db
        .update(iamRoles)
        .set({
          name: spec.name,
          description: spec.description,
          resourceType: spec.resourceType,
          isSystem: true,
          updatedAt: new Date(),
        })
        .where(eq(iamRoles.roleId, roleId));
    } else {
      const [created] = await db
        .insert(iamRoles)
        .values({
          accountId: null,
          key: spec.key,
          name: spec.name,
          description: spec.description,
          resourceType: spec.resourceType,
          isSystem: true,
        })
        .returning({ roleId: iamRoles.roleId });
      roleId = created.roleId;
    }

    // Reconcile permissions: insert any new, delete any stale.
    const desired = new Set(spec.actions);
    const current = await db
      .select({ action: iamRolePermissions.action })
      .from(iamRolePermissions)
      .where(eq(iamRolePermissions.roleId, roleId));
    const have = new Set(current.map((r) => r.action));

    const toAdd = [...desired].filter((a) => !have.has(a));
    const toRemove = [...have].filter((a) => !desired.has(a));

    if (toAdd.length > 0) {
      await db
        .insert(iamRolePermissions)
        .values(toAdd.map((action) => ({ roleId, action })))
        .onConflictDoNothing();
    }
    if (toRemove.length > 0) {
      await db.execute(sql`
        DELETE FROM kortix.iam_role_permissions
        WHERE role_id = ${roleId}
          AND action IN (${sql.join(toRemove.map((a) => sql`${a}`), sql`, `)})
      `);
    }
  }
}
