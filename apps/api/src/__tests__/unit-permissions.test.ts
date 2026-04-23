import { describe, expect, test } from 'bun:test';

import {
  ALL_SCOPES,
  ROLE_SCOPES,
  SCOPE_CATALOG,
  applyOverridesToRole,
  isScope,
  resolveRoleSync,
  scopesByGroup,
  scopesForEffectiveRole,
  type Scope,
} from '../permissions';
import type { UserTeamContext } from '../teams/services/access';
import type { SandboxRef } from '../teams/domain/types';

const SANDBOX: SandboxRef = {
  sandboxId: '11111111-1111-1111-1111-111111111111',
  accountId: '22222222-2222-2222-2222-222222222222',
};

function ctx(partial: Partial<UserTeamContext>): UserTeamContext {
  return {
    userId: 'user-0',
    isPlatformAdmin: false,
    allAccountIds: [],
    managerAccountIds: [],
    ownerAccountIds: [],
    ...partial,
  };
}

describe('SCOPE_CATALOG', () => {
  test('every catalog entry has label, description, and group', () => {
    for (const scope of ALL_SCOPES) {
      const meta = SCOPE_CATALOG[scope];
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(0);
      expect(typeof meta.group).toBe('string');
    }
  });

  test('isScope accepts every registered key and rejects unknown strings', () => {
    for (const scope of ALL_SCOPES) {
      expect(isScope(scope)).toBe(true);
    }
    expect(isScope('sandbox:nuke')).toBe(false);
    expect(isScope('')).toBe(false);
  });

  test('scopesByGroup returns every scope exactly once', () => {
    const byGroup = scopesByGroup();
    const flat = Object.values(byGroup).flat();
    expect(new Set(flat).size).toBe(ALL_SCOPES.length);
    expect(flat.length).toBe(ALL_SCOPES.length);
  });
});

describe('ROLE_SCOPES', () => {
  test('owner has every scope in the catalog', () => {
    expect(ROLE_SCOPES.owner.size).toBe(ALL_SCOPES.length);
    for (const scope of ALL_SCOPES) {
      expect(ROLE_SCOPES.owner.has(scope)).toBe(true);
    }
  });

  test('admin is owner minus the expected owner-only revocations', () => {
    const expectedMissing: Scope[] = [
      'members:invite',
      'members:remove',
      'members:change_role',
      'members:set_cap',
      'billing:manage',
    ];
    for (const s of expectedMissing) {
      expect(ROLE_SCOPES.admin.has(s)).toBe(false);
    }
    expect(ROLE_SCOPES.admin.has('sandbox:use')).toBe(true);
    expect(ROLE_SCOPES.admin.has('sandbox:upgrade')).toBe(true);
    expect(ROLE_SCOPES.admin.has('projects:access.manage')).toBe(true);
  });

  test('member can use the workspace and manage their own projects', () => {
    expect(ROLE_SCOPES.member.has('sandbox:use')).toBe(true);
    expect(ROLE_SCOPES.member.has('projects:create')).toBe(true);
    expect(ROLE_SCOPES.member.has('projects:rename')).toBe(true);
    expect(ROLE_SCOPES.member.has('projects:delete')).toBe(true);

    expect(ROLE_SCOPES.member.has('members:invite')).toBe(false);
    expect(ROLE_SCOPES.member.has('members:remove')).toBe(false);
    expect(ROLE_SCOPES.member.has('sandbox:upgrade')).toBe(false);
    expect(ROLE_SCOPES.member.has('billing:manage')).toBe(false);
    expect(ROLE_SCOPES.member.has('projects:access.manage')).toBe(false);
  });
});

describe('resolveRoleSync', () => {
  test('platform admin always wins', () => {
    const user = ctx({ isPlatformAdmin: true });
    expect(resolveRoleSync(user, SANDBOX, false)).toBe('platform_admin');
  });

  test('owner of the sandbox account maps to owner', () => {
    const user = ctx({
      ownerAccountIds: [SANDBOX.accountId],
      allAccountIds: [SANDBOX.accountId],
    });
    expect(resolveRoleSync(user, SANDBOX, false)).toBe('owner');
  });

  test('admin of the sandbox account maps to admin', () => {
    const user = ctx({
      managerAccountIds: [SANDBOX.accountId],
      allAccountIds: [SANDBOX.accountId],
    });
    expect(resolveRoleSync(user, SANDBOX, false)).toBe('admin');
  });

  test('sandbox_members grant without account membership maps to member', () => {
    const user = ctx({});
    expect(resolveRoleSync(user, SANDBOX, true)).toBe('member');
  });

  test('no membership and no account role returns null', () => {
    const user = ctx({});
    expect(resolveRoleSync(user, SANDBOX, false)).toBe(null);
  });
});

describe('applyOverridesToRole', () => {
  test('grant adds a scope the role does not have', () => {
    const out = applyOverridesToRole('member', {
      grants: new Set<Scope>(['members:invite']),
      revokes: new Set<Scope>(),
    });
    expect(out.has('members:invite')).toBe(true);
    expect(out.has('sandbox:use')).toBe(true);
  });

  test('revoke removes a scope the role has by default', () => {
    const out = applyOverridesToRole('member', {
      grants: new Set<Scope>(),
      revokes: new Set<Scope>(['sandbox:use']),
    });
    expect(out.has('sandbox:use')).toBe(false);
    expect(out.has('projects:create')).toBe(true);
  });

  test('null role yields empty scope set regardless of overrides', () => {
    const out = applyOverridesToRole(null, {
      grants: new Set<Scope>(['sandbox:use']),
      revokes: new Set<Scope>(),
    });
    expect(out.size).toBe(0);
  });

  test('platform_admin starts from owner defaults and respects overrides', () => {
    const out = applyOverridesToRole('platform_admin', {
      grants: new Set<Scope>(),
      revokes: new Set<Scope>(['sandbox:upgrade']),
    });
    expect(out.has('sandbox:upgrade')).toBe(false);
    expect(out.has('sandbox:use')).toBe(true);
  });
});

describe('scopesForEffectiveRole', () => {
  test('returns owner scopes for platform_admin', () => {
    expect(scopesForEffectiveRole('platform_admin')).toBe(ROLE_SCOPES.owner);
  });

  test('returns an empty set for null role', () => {
    expect(scopesForEffectiveRole(null).size).toBe(0);
  });
});
