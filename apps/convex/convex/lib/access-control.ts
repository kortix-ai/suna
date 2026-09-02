import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/organization/access';

/**
 * Kortix resource/action statements for the Better Auth organization plugin.
 *
 * An organization is a Kortix account. Roles map 1:1 onto the current
 * `account_role` enum (`owner | admin | member`). Project-level roles
 * (`manager | member`) become dynamic-access-control roles created per
 * organization in Phase 2 (ADR-007 §2).
 */
export const statement = {
  ...defaultStatements,
  project: ['create', 'read', 'update', 'delete', 'share', 'archive'],
  session: ['create', 'read', 'update', 'delete', 'share'],
  secret: ['create', 'read', 'update', 'delete'],
  connector: ['create', 'read', 'update', 'delete', 'call'],
  trigger: ['create', 'read', 'update', 'delete', 'run'],
  billing: ['read', 'manage'],
  apiKey: ['create', 'read', 'revoke'],
  audit: ['read'],
  sso: ['manage'],
  scim: ['manage'],
} as const;

export const ac = createAccessControl(statement);

const all = <T extends readonly string[]>(actions: T) => [...actions] as unknown as T[number][];

export const member = ac.newRole({
  project: ['create', 'read', 'update', 'share'],
  session: ['create', 'read', 'update', 'share'],
  secret: ['read'],
  connector: ['read', 'call'],
  trigger: ['read', 'run'],
  billing: ['read'],
  apiKey: ['create', 'read', 'revoke'],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  project: all(statement.project),
  session: all(statement.session),
  secret: all(statement.secret),
  connector: all(statement.connector),
  trigger: all(statement.trigger),
  billing: ['read'],
  apiKey: all(statement.apiKey),
  audit: ['read'],
});

export const owner = ac.newRole({
  ...adminAc.statements,
  organization: ['update', 'delete'],
  project: all(statement.project),
  session: all(statement.session),
  secret: all(statement.secret),
  connector: all(statement.connector),
  trigger: all(statement.trigger),
  billing: all(statement.billing),
  apiKey: all(statement.apiKey),
  audit: ['read'],
  sso: ['manage'],
  scim: ['manage'],
});

export const roles = { owner, admin, member };
