/**
 * `validateActions` — the write-time ceiling on a custom role — against the real
 * catalog.
 *
 * It was a pure unit test while the ceiling was a hand-maintained Set
 * (`NON_DELEGABLE_ACTIONS`) and the scope classifier was
 * `resourceTypeForAction`. Both are columns on `kortix.permissions` now
 * (`delegable`, `scope_type`), so the function reads the DB and the test has to
 * as well — which is the point: there is no second copy of the ceiling left to
 * drift.
 */
import { describe, expect, test } from 'bun:test';

import { validateActions } from '../accounts/iam/role-presets';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';

describe('validateActions', () => {
  test('accepts known actions and dedupes', async () => {
    const r = await validateActions([
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    ]);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.actions).toEqual([
        PROJECT_ACTIONS.PROJECT_READ,
        PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
      ]);
  });

  test('rejects an unknown / injected action string', async () => {
    const r = await validateActions([PROJECT_ACTIONS.PROJECT_READ, 'project.everything.hax']);
    expect(r.ok).toBe(false);
  });

  test('rejects a non-array', async () => {
    expect((await validateActions('project.read')).ok).toBe(false);
    expect((await validateActions(null)).ok).toBe(false);
  });

  test('accepts an empty set (a role that grants nothing yet)', async () => {
    const r = await validateActions([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([]);
  });

  test('the two retired action families are no longer in the catalog', async () => {
    // spec §2.4: project.cr.* collapsed into the gitops leaves, trigger.* was
    // dead. A role that still names one must be rejected, not silently accepted.
    for (const a of ['project.cr.open', 'project.cr.merge', 'trigger.fire', 'trigger.read']) {
      expect((await validateActions([a])).ok).toBe(false);
    }
  });
});

describe('validateActions — privilege-escalation ceiling', () => {
  // Owner-only + IAM-management powers can never be packed into a custom role,
  // regardless of the role's scope. Otherwise an admin (who holds role.create +
  // policy.create) could mint such a role, bind themselves, and become owner.
  const FORBIDDEN = [
    ACCOUNT_ACTIONS.ACCOUNT_DELETE,
    ACCOUNT_ACTIONS.BILLING_WRITE,
    ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
    ACCOUNT_ACTIONS.MEMBER_INVITE,
    ACCOUNT_ACTIONS.MEMBER_UPDATE,
    ACCOUNT_ACTIONS.MEMBER_REMOVE,
    ACCOUNT_ACTIONS.GROUP_CREATE,
    ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE,
    ACCOUNT_ACTIONS.ROLE_CREATE,
    ACCOUNT_ACTIONS.ROLE_UPDATE,
    ACCOUNT_ACTIONS.ROLE_DELETE,
    ACCOUNT_ACTIONS.POLICY_CREATE,
    ACCOUNT_ACTIONS.POLICY_DELETE,
    ACCOUNT_ACTIONS.TOKEN_CREATE,
    ACCOUNT_ACTIONS.TOKEN_REVOKE,
  ];

  test('every non-delegable action is rejected even in an account role', async () => {
    for (const a of FORBIDDEN) {
      expect((await validateActions([a], 'account')).ok).toBe(false);
    }
  });

  test('benign account-read actions ARE delegable into an account role', async () => {
    const r = await validateActions(
      [ACCOUNT_ACTIONS.AUDIT_READ, ACCOUNT_ACTIONS.ROLE_READ, ACCOUNT_ACTIONS.POLICY_READ],
      'account',
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateActions — namespace integrity', () => {
  test('a project role rejects account-scoped actions', async () => {
    const r = await validateActions(
      [PROJECT_ACTIONS.PROJECT_READ, ACCOUNT_ACTIONS.AUDIT_READ],
      'project',
    );
    expect(r.ok).toBe(false);
  });

  test('an account role rejects project-scoped actions', async () => {
    const r = await validateActions(
      [ACCOUNT_ACTIONS.AUDIT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE],
      'account',
    );
    expect(r.ok).toBe(false);
  });

  test('project.members.manage + gateway.keys.manage stay delegable in a project role (department lead)', async () => {
    const r = await validateActions(
      [PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE],
      'project',
    );
    expect(r.ok).toBe(true);
  });

  test('project.create is account-scoped — rejected in a project role', async () => {
    const r = await validateActions([ACCOUNT_ACTIONS.PROJECT_CREATE], 'project');
    expect(r.ok).toBe(false);
  });

  test('no resourceType arg → namespace check skipped (back-compat)', async () => {
    const r = await validateActions([PROJECT_ACTIONS.PROJECT_READ, ACCOUNT_ACTIONS.AUDIT_READ]);
    expect(r.ok).toBe(true);
  });
});
