import { ALL_SCOPES, type Scope } from './catalog';

export type SandboxRole = 'owner' | 'admin' | 'member';

const OWNER_SCOPES: readonly Scope[] = ALL_SCOPES;

const ADMIN_REVOKED: readonly Scope[] = [
  'members:invite',
  'members:remove',
  'members:change_role',
  'members:set_cap',
  'billing:manage',
];

const MEMBER_SCOPES: readonly Scope[] = [
  'sandbox:use',
  'projects:create',
  'projects:rename',
  'projects:delete',
];

export const ROLE_SCOPES: Readonly<Record<SandboxRole, ReadonlySet<Scope>>> = Object.freeze({
  owner: new Set(OWNER_SCOPES),
  admin: new Set(OWNER_SCOPES.filter((s) => !ADMIN_REVOKED.includes(s))),
  member: new Set(MEMBER_SCOPES),
});

export function scopesForRole(role: SandboxRole): Scope[] {
  return Array.from(ROLE_SCOPES[role]);
}
