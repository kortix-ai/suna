import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';

const state = {
  actor: null as null | {
    isSuperAdmin: boolean;
    accountRole: 'owner' | 'admin' | 'member' | null;
    mfaRequired: boolean;
  },
  groupIds: [] as string[],
  directRole: null as null | 'viewer' | 'editor' | 'manager',
  groupRoles: [] as Array<'viewer' | 'editor' | 'manager'>,
  roleSelects: 0,
  tokenProjectId: undefined as undefined | string | null,
};

function rowsForSelect(shape: Record<string, unknown>) {
  if ('isSuperAdmin' in shape) return state.actor ? [state.actor] : [];
  if ('groupId' in shape) return state.groupIds.map((groupId) => ({ groupId }));
  if ('projectId' in shape && !('role' in shape)) {
    return state.tokenProjectId === undefined ? [] : [{ projectId: state.tokenProjectId }];
  }
  if ('role' in shape && !('projectId' in shape)) {
    state.roleSelects += 1;
    return state.roleSelects === 1
      ? state.directRole ? [{ role: state.directRole }] : []
      : state.groupRoles.map((role) => ({ role }));
  }
  return [];
}

function queryFor(rows: unknown[]) {
  return {
    limit: async (count: number) => rows.slice(0, count),
    then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

const fakeDb = {
  select: (shape: Record<string, unknown>) => ({
    from: () => ({
      innerJoin: () => ({
        where: () => queryFor(rowsForSelect(shape)),
      }),
      where: () => queryFor(rowsForSelect(shape)),
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb }));

const { authorizeV2 } = await import('../iam/engine-v2');

beforeEach(() => {
  state.actor = actor('member');
  state.groupIds = [];
  state.directRole = null;
  state.groupRoles = [];
  state.roleSelects = 0;
  state.tokenProjectId = undefined;
});

describe('authorizeV2 action scope detection', () => {
  test('account, billing, audit, member, group, and token actions are account-scoped', async () => {
    state.actor = actor('admin');

    await expectAllowed(ACCOUNT_ACTIONS.ACCOUNT_READ, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.ACCOUNT_WRITE, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.BILLING_READ, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.AUDIT_READ, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.MEMBER_INVITE, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.GROUP_CREATE, { reason: 'account_role' });
    await expectAllowed(ACCOUNT_ACTIONS.TOKEN_CREATE, { reason: 'account_role' });
  });

  test('project.create is account-scoped because no project exists yet', async () => {
    state.actor = actor('admin');

    await expectAllowed(ACCOUNT_ACTIONS.PROJECT_CREATE, { reason: 'account_role' });
  });

  test('non-create project actions require a project target', async () => {
    state.actor = actor('admin');

    await expectDenied(PROJECT_ACTIONS.PROJECT_READ, { reason: 'project_target_required' });
    await expectDenied(PROJECT_ACTIONS.PROJECT_WRITE, { reason: 'project_target_required' });
    await expectDenied(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_target_required' });
    await expectDenied(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE, { reason: 'project_target_required' });
    await expectDenied(PROJECT_ACTIONS.PROJECT_SESSION_START, { reason: 'project_target_required' });
  });

  test('sandbox, trigger, and channel actions collapse to project scope', async () => {
    state.actor = actor('admin');

    await expectDenied('sandbox.start', { reason: 'project_target_required' });
    await expectDenied('trigger.fire', { reason: 'project_target_required' });
    await expectDenied('channel.send', { reason: 'project_target_required' });
  });
});

describe('authorizeV2 effective project role derivation', () => {
  test('owner gets implicit Manager even with no other path', async () => {
    state.actor = actor('owner');

    await expectAllowed(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_role', project: true });
  });

  test('admin gets implicit Manager even with no other path', async () => {
    state.actor = actor('admin');

    await expectAllowed(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_role', project: true });
  });

  test('member with no direct row and no groups has no project role', async () => {
    state.actor = actor('member');

    await expectDenied(PROJECT_ACTIONS.PROJECT_READ, { reason: 'no_project_membership', project: true });
  });

  test('member with a direct Viewer row gets viewer permissions only', async () => {
    state.actor = actor('member');
    state.directRole = 'viewer';

    await expectAllowed(PROJECT_ACTIONS.PROJECT_READ, { reason: 'project_role', project: true });
    state.directRole = 'viewer';
    await expectDenied(PROJECT_ACTIONS.PROJECT_WRITE, { reason: 'project_role_insufficient', project: true });
  });

  test('member with only a group Editor gets editor permissions', async () => {
    state.actor = actor('member');
    state.groupIds = ['group-1'];
    state.groupRoles = ['editor'];

    await expectAllowed(PROJECT_ACTIONS.PROJECT_WRITE, { reason: 'project_role', project: true });
  });

  test('direct Viewer plus group Editor uses the strongest role', async () => {
    state.actor = actor('member');
    state.groupIds = ['group-1'];
    state.directRole = 'viewer';
    state.groupRoles = ['editor'];

    await expectAllowed(PROJECT_ACTIONS.PROJECT_WRITE, { reason: 'project_role', project: true });
  });

  test('multiple group grants use the strongest role', async () => {
    state.actor = actor('member');
    state.groupIds = ['group-1', 'group-2', 'group-3'];
    state.groupRoles = ['viewer', 'manager', 'editor'];

    await expectAllowed(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_role', project: true });
  });

  test('owner stays Manager even when direct/group rows are weaker', async () => {
    state.actor = actor('owner');
    state.groupIds = ['group-1'];
    state.directRole = 'viewer';
    state.groupRoles = ['viewer'];

    await expectAllowed(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_role', project: true });
  });

  test('member with direct Manager gets manager permissions', async () => {
    state.actor = actor('member');
    state.directRole = 'manager';

    await expectAllowed(PROJECT_ACTIONS.PROJECT_DELETE, { reason: 'project_role', project: true });
  });
});

function actor(accountRole: 'owner' | 'admin' | 'member') {
  return {
    isSuperAdmin: false,
    accountRole,
    mfaRequired: false,
  };
}

async function authorize(action: string, target = false) {
  state.roleSelects = 0;
  return authorizeV2(
    'user-1',
    'acct-1',
    action,
    target ? { type: 'project', id: 'project-1' } : undefined,
  );
}

async function expectAllowed(
  action: string,
  opts: { reason: string; project?: boolean },
) {
  expect(await authorize(action, opts.project)).toMatchObject({
    allowed: true,
    reason: opts.reason,
  });
}

async function expectDenied(
  action: string,
  opts: { reason: string; project?: boolean },
) {
  expect(await authorize(action, opts.project)).toMatchObject({
    allowed: false,
    reason: opts.reason,
  });
}
