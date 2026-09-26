import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PROJECT_ACTIONS } from '../../../iam/actions';

// Where the Slack identity prompts land. The actor check itself is tested at
// channels/core/identity.test.ts.

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
const realInstallStore = await import('../../install-store');
mock.module('../../install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
mock.module('../../../iam', () => ({
  PROJECT_ACTIONS,
  authorize: async () => ({ allowed: authorizeAllowed }),
  assertAuthorized: async () => {},
  filterAccessibleProjectResources: async (_u: string, _a: string, _p: string, _t: string, ids: readonly string[]) => [...ids],
  unscopedResourceIds: async (_p: string, _t: string, ids: readonly string[]) => [...ids],
}));

const { postIdentityPrompt } = await import('../identity');

beforeEach(() => {
  dbResults = [];
  authorizeAllowed = true;
  ephemerals = [];
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
