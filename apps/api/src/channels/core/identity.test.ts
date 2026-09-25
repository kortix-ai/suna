import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PROJECT_ACTIONS } from '../../iam/actions';

// resolveChatActor is the authoritative gate for every chat webhook: it
// returns a userId ONLY when the chat user is linked, is in the project's
// account, and IAM allows the asked action on the project.

let dbResults: unknown[][] = [];
let authorizeAllowed = true;
const authorizeCalls: Array<{ action: string; projectId: string }> = [];
const where: unknown[] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'limit', 'set', 'values', 'returning', 'onConflictDoUpdate']) chain[m] = () => chain;
  chain.where = (w: unknown) => {
    where.push(w);
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS,
  authorize: async (_actor: unknown, action: string, resource: { id: string }) => {
    authorizeCalls.push({ action, projectId: resource.id });
    return { allowed: authorizeAllowed };
  },
}));

const { chatUser, resolveChatActor, resolveProjectChatActor } = await import('./identity');

const project = { projectId: 'proj1', accountId: 'acct1' };

beforeEach(() => {
  dbResults = [];
  authorizeAllowed = true;
  authorizeCalls.length = 0;
  where.length = 0;
});

describe('resolveChatActor', () => {
  test('no chat user → unlinked, without touching the db', async () => {
    expect(await resolveChatActor(chatUser('slack', 'T1', ''), project)).toEqual({ reason: 'unlinked' });
    expect(await resolveChatActor(chatUser('teams', '', 'aad-1'), project)).toEqual({ reason: 'unlinked' });
    expect(where).toHaveLength(0);
  });

  test('no live link → unlinked', async () => {
    dbResults = [[]];
    expect(await resolveChatActor(chatUser('slack', 'T1', 'U1'), project)).toEqual({ reason: 'unlinked' });
  });

  test('linked but NOT a member of the account → not_member', async () => {
    dbResults = [[{ userId: 'u1' }], []];
    expect(await resolveChatActor(chatUser('teams', 'tenant-1', 'aad-1'), project)).toEqual({ reason: 'not_member' });
    expect(authorizeCalls).toHaveLength(0);
  });

  test('linked member without the action → not_member', async () => {
    authorizeAllowed = false;
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]];
    expect(await resolveChatActor(chatUser('slack', 'T1', 'U1'), project)).toEqual({ reason: 'not_member' });
  });

  test('linked member with the action → the Kortix userId; the default action is project.write', async () => {
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]];
    expect(await resolveChatActor(chatUser('slack', 'T1', 'U1'), project)).toEqual({ userId: 'u1' });
    expect(authorizeCalls).toEqual([{ action: PROJECT_ACTIONS.PROJECT_WRITE, projectId: 'proj1' }]);
  });

  test('a caller-named action is the one authorized', async () => {
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]];
    await resolveChatActor(chatUser('teams', 'tenant-1', 'aad-1'), project, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
    expect(authorizeCalls).toEqual([{ action: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, projectId: 'proj1' }]);
  });
});

describe('resolveProjectChatActor', () => {
  test('a missing project → not_member, without reading the link', async () => {
    dbResults = [[]];
    expect(await resolveProjectChatActor(chatUser('slack', 'T1', 'U1'), 'gone')).toEqual({ reason: 'not_member' });
    expect(where).toHaveLength(1);
  });

  test('reads the account, then runs the same check', async () => {
    dbResults = [[{ accountId: 'acct1' }], [{ userId: 'u1' }], [{ userId: 'u1' }]];
    expect(await resolveProjectChatActor(chatUser('slack', 'T1', 'U1'), 'proj1')).toEqual({ userId: 'u1' });
  });
});
