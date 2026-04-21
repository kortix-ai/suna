/**
 * Access-matrix tests for the teams/decideAccess policy.
 *
 * Covers every combination of viewer role × requested action against a
 * sandbox owned by account "acct-A", plus the "sandbox_member" grant path
 * for plain members. Each case asserts both the allow/deny boolean and the
 * reason string so a regression flips an obvious, readable assertion.
 */

import { describe, expect, test } from 'bun:test';

import { decideAccess, type UserTeamContext } from '../teams/services/access';
import type { SandboxAction, SandboxRef } from '../teams/domain/types';

const SANDBOX: SandboxRef = {
  sandboxId: 'sbx-1',
  accountId: 'acct-A',
};

// decideAccess only touches the DB for the plain-member sandbox_members lookup.
// We pass a stub that returns the canned `memberRows` value for that user+
// sandbox; the rest of the matrix never reaches this branch.
function stubDb(memberRows: Array<{ sandboxId: string; userId: string }>): any {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => memberRows,
        }),
      }),
    }),
  };
}

function ctx(overrides: Partial<UserTeamContext>): UserTeamContext {
  return {
    userId: 'u-1',
    isPlatformAdmin: false,
    allAccountIds: [],
    managerAccountIds: [],
    ownerAccountIds: [],
    ...overrides,
  };
}

const VIEW_ACTIONS: SandboxAction[] = ['view', 'execute', 'write', 'lifecycle'];
const OWNER_ACTIONS: SandboxAction[] = ['rename', 'delete', 'manage_members'];

describe('decideAccess', () => {
  describe('platform admin', () => {
    const platformAdmin = ctx({ isPlatformAdmin: true });

    test.each([...VIEW_ACTIONS, ...OWNER_ACTIONS])(
      'allows every action (%s)',
      async (action) => {
        const decision = await decideAccess(stubDb([]), platformAdmin, SANDBOX, action);
        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('platform_admin');
      },
    );
  });

  describe('account owner', () => {
    const owner = ctx({
      allAccountIds: ['acct-A'],
      managerAccountIds: ['acct-A'],
      ownerAccountIds: ['acct-A'],
    });

    test.each([...VIEW_ACTIONS, ...OWNER_ACTIONS])(
      'allows every action (%s)',
      async (action) => {
        const decision = await decideAccess(stubDb([]), owner, SANDBOX, action);
        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('account_manager');
      },
    );
  });

  describe('account admin (not owner)', () => {
    const admin = ctx({
      allAccountIds: ['acct-A'],
      managerAccountIds: ['acct-A'],
      ownerAccountIds: [],
    });

    test.each(VIEW_ACTIONS)('allows view-class action (%s)', async (action) => {
      const decision = await decideAccess(stubDb([]), admin, SANDBOX, action);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('account_manager');
    });

    test.each(OWNER_ACTIONS)('denies owner-only action (%s)', async (action) => {
      const decision = await decideAccess(stubDb([]), admin, SANDBOX, action);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('not_member');
    });
  });

  describe('plain member WITH sandbox_members grant', () => {
    const member = ctx({
      allAccountIds: ['acct-A'],
      managerAccountIds: [],
      ownerAccountIds: [],
    });
    const db = stubDb([{ sandboxId: SANDBOX.sandboxId, userId: member.userId }]);

    test.each(VIEW_ACTIONS)('allows view-class action (%s)', async (action) => {
      const decision = await decideAccess(db, member, SANDBOX, action);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('sandbox_member');
    });

    test.each(OWNER_ACTIONS)('denies owner-only action (%s)', async (action) => {
      const decision = await decideAccess(db, member, SANDBOX, action);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('not_member');
    });
  });

  describe('plain member WITHOUT sandbox_members grant', () => {
    const member = ctx({
      allAccountIds: ['acct-A'],
      managerAccountIds: [],
      ownerAccountIds: [],
    });
    const db = stubDb([]);

    test.each([...VIEW_ACTIONS, ...OWNER_ACTIONS])(
      'denies every action (%s)',
      async (action) => {
        const decision = await decideAccess(db, member, SANDBOX, action);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('not_member');
      },
    );
  });

  describe('outsider (not a member of the sandbox account)', () => {
    // User belongs to a totally unrelated account.
    const outsider = ctx({
      allAccountIds: ['acct-other'],
      managerAccountIds: ['acct-other'],
      ownerAccountIds: ['acct-other'],
    });

    test.each([...VIEW_ACTIONS, ...OWNER_ACTIONS])(
      'denies every action (%s)',
      async (action) => {
        // No sandbox_members row — being manager of a *different* account
        // doesn't spill into this one.
        const decision = await decideAccess(stubDb([]), outsider, SANDBOX, action);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('not_member');
      },
    );
  });

  describe('multi-account user', () => {
    // Member of acct-A via sandbox grant; owner of acct-B (irrelevant for
    // a sandbox living in acct-A). Regression guard for the "double-account
    // trap" where the wrong primary account used to break access.
    const user = ctx({
      allAccountIds: ['acct-A', 'acct-B'],
      managerAccountIds: ['acct-B'],
      ownerAccountIds: ['acct-B'],
    });
    const db = stubDb([{ sandboxId: SANDBOX.sandboxId, userId: user.userId }]);

    test('view-class action resolves via sandbox_member grant in the foreign account', async () => {
      const decision = await decideAccess(db, user, SANDBOX, 'view');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('sandbox_member');
    });

    test('owner-only action is denied because ownership of acct-B does not confer owner rights in acct-A', async () => {
      const decision = await decideAccess(db, user, SANDBOX, 'manage_members');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('not_member');
    });
  });
});
