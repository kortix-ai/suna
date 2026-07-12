import { beforeEach, describe, expect, mock, test } from 'bun:test';

// resolveSlackActor is the authoritative security gate: it must return a userId
// ONLY when the Slack user is linked, in the project's account, and allowed to
// start work in that project.

let dbResults: unknown[][] = [];
let authorizeAllowed = true;
let ephemerals: Array<{ channel: string; user: string; text: string; threadTs?: string }> = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'set', 'values', 'returning', 'onConflictDoUpdate']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));
mock.module('../../slack-api', () => ({
  openDmChannel: async () => 'D1',
  postBlocks: async () => 'ts',
  postEphemeral: async (_token: string, channel: string, user: string, text: string, _blocks?: unknown[], threadTs?: string) => {
    ephemerals.push({ channel, user, text, threadTs });
    return true;
  },
}));
mock.module('../../install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
mock.module('../../../iam', () => ({
  authorize: async () => ({ allowed: authorizeAllowed }),
  assertAuthorized: async () => {},
  filterAccessibleProjectResources: async (_u: string, _a: string, _p: string, _t: string, ids: readonly string[]) => [...ids],
  unscopedResourceIds: async (_p: string, _t: string, ids: readonly string[]) => [...ids],
}));

const { postIdentityPrompt, resolveSlackActor } = await import('../identity');

beforeEach(() => {
  dbResults = [];
  authorizeAllowed = true;
  ephemerals = [];
});

describe('resolveSlackActor', () => {
  test('no Slack user → unlinked, without touching the db', async () => {
    const r = await resolveSlackActor('T1', '', 'acct1', 'proj1');
    expect(r).toEqual({ reason: 'unlinked' });
  });

  test('no mapping row → unlinked', async () => {
    dbResults = [[]]; // identity lookup misses
    const r = await resolveSlackActor('T1', 'U1', 'acct1', 'proj1');
    expect(r).toEqual({ reason: 'unlinked' });
  });

  test('linked but NOT a member of the account → not_member', async () => {
    dbResults = [[{ userId: 'u1' }], []]; // identity hit, membership miss
    const r = await resolveSlackActor('T1', 'U1', 'acct1', 'proj1');
    expect(r).toEqual({ reason: 'not_member' });
  });

  test('linked and org member but missing project write → not_member', async () => {
    authorizeAllowed = false;
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]]; // identity hit, membership hit
    const r = await resolveSlackActor('T1', 'U1', 'acct1', 'proj1');
    expect(r).toEqual({ reason: 'not_member' });
  });

  test('linked and project-write-capable → returns the Kortix userId', async () => {
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]]; // identity hit, membership hit
    const r = await resolveSlackActor('T1', 'U1', 'acct1', 'proj1');
    expect(r).toEqual({ userId: 'u1' });
  });
});

describe('postIdentityPrompt', () => {
  test('top-level auth prompt is not hidden inside a new thread', async () => {
    await postIdentityPrompt({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      slackUserId: 'U1',
      reason: 'unlinked',
    });

    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]).toMatchObject({
      channel: 'C1',
      user: 'U1',
      text: 'Kortix needs a linked Kortix account to continue.',
    });
    expect(ephemerals[0].threadTs).toBeUndefined();
  });

  test('thread auth prompt stays in the existing thread', async () => {
    await postIdentityPrompt({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadTs: '90.0',
      slackUserId: 'U1',
      reason: 'unlinked',
    });

    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0].threadTs).toBe('90.0');
  });
});
