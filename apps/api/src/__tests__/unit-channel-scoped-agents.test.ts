import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// A picker that offers an agent the presser has no access to is a dead end:
// the pick is stored, and the next session start fails on it. Slack has run
// its list through IAM since the picker existed; Teams offered the raw
// declaration until 2026-09-21.

const PROJECT_ID = 'proj-1';
const DECLARED = [
  { name: 'reviewer', description: null, mode: null },
  { name: 'deployer', description: null, mode: null },
];

let projectRow: { accountId: string } | undefined = { accountId: 'acct-1' };
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (projectRow ? [projectRow] : []) }) }),
    }),
  },
}));

let listed: typeof DECLARED | Error = DECLARED;
mock.module('../channels/slack/selection', () => ({
  listProjectAgents: async () => {
    if (listed instanceof Error) throw listed;
    return listed;
  },
}));

const scopedCalls: Array<Record<string, unknown>> = [];
let scopedAllows: string[] | Error = ['reviewer'];
let unscopedAllows: string[] | Error = [];
mock.module('../iam', () => ({
  filterAccessibleObjects: async (actor: unknown, projectId: string, kind: string, names: string[]) => {
    scopedCalls.push({ actor, projectId, kind, names });
    if (scopedAllows instanceof Error) throw scopedAllows;
    return scopedAllows;
  },
  unscopedResourceIds: async () => {
    if (unscopedAllows instanceof Error) throw unscopedAllows;
    return unscopedAllows;
  },
}));

mock.module('../iam/actor', () => ({
  actorForUser: (userId: string, accountId: string) => ({ userId, accountId }),
}));

const load = async () => await import('../channels/scoped-agents');

beforeEach(() => {
  projectRow = { accountId: 'acct-1' };
  listed = DECLARED;
  scopedAllows = ['reviewer'];
  unscopedAllows = [];
  scopedCalls.length = 0;
});

afterEach(() => {
  mock.restore();
});

describe('scopedProjectAgents', () => {
  test('a linked user sees only what IAM allows them, as that account`s actor', async () => {
    const { scopedProjectAgents } = await load();

    expect((await scopedProjectAgents(PROJECT_ID, 'user-1')).map((a) => a.name)).toEqual(['reviewer']);
    expect(scopedCalls).toEqual([
      {
        actor: { userId: 'user-1', accountId: 'acct-1' },
        projectId: PROJECT_ID,
        kind: 'agent',
        names: ['reviewer', 'deployer'],
      },
    ]);
  });

  test('an unlinked user gets the unscoped set, never the full declaration', async () => {
    unscopedAllows = ['deployer'];
    const { scopedProjectAgents } = await load();

    expect((await scopedProjectAgents(PROJECT_ID, null)).map((a) => a.name)).toEqual(['deployer']);
    // No per-user filter runs without a user to filter for.
    expect(scopedCalls).toEqual([]);
  });

  test('a project that cannot be read falls back to the unscoped set', async () => {
    projectRow = undefined;
    unscopedAllows = ['reviewer', 'deployer'];
    const { scopedProjectAgents } = await load();

    expect((await scopedProjectAgents(PROJECT_ID, 'user-1')).map((a) => a.name)).toEqual([
      'reviewer',
      'deployer',
    ]);
    expect(scopedCalls).toEqual([]);
  });

  test('an IAM failure leaves the list unfiltered rather than empty', async () => {
    // An empty picker tells the user their project declares no agents, which
    // is a lie that costs more than a too-wide list the create path rejects.
    scopedAllows = new Error('iam unavailable');
    const { scopedProjectAgents } = await load();

    expect((await scopedProjectAgents(PROJECT_ID, 'user-1')).map((a) => a.name)).toEqual([
      'reviewer',
      'deployer',
    ]);
  });

  test('a project that declares nothing skips IAM entirely', async () => {
    listed = [];
    const { scopedProjectAgents } = await load();

    expect(await scopedProjectAgents(PROJECT_ID, 'user-1')).toEqual([]);
    expect(scopedCalls).toEqual([]);
  });

  test('an unreadable repo yields no agents instead of throwing at the picker', async () => {
    listed = new Error('repo unreachable');
    const { scopedProjectAgents } = await load();

    expect(await scopedProjectAgents(PROJECT_ID, 'user-1')).toEqual([]);
  });
});
