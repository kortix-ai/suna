import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from '../../__tests__/helpers/chat-identity-stub';

// `/kortix sessions` lists recent chat-started sessions. Only sessions the
// caller's linked Kortix account may open on the web are listed.

let threadRows: Array<Record<string, unknown>> = [];
function chain(): any {
  const c: any = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) c[m] = () => c;
  c.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(threadRows));
  return c;
}
mock.module('../../shared/db', () => ({ db: { select: () => chain() }, hasDatabase: () => true }));

let linked: { userId: string } | null = { userId: 'user-1' };
const memberOf = new Set(['acct-a']);
mock.module('./identity', () =>
  chatIdentityStub({
    lookupChatIdentity: async () => linked,
    isAccountMember: async (_u: string, accountId: string) => memberOf.has(accountId),
  }),
);
const readable = new Set(['proj-a']);
mock.module('../../iam', () => ({
  authorize: async (_actor: unknown, _action: string, resource: { id: string }) => ({ allowed: readable.has(resource.id) }),
}));
const visibleSessions = new Set(['s-a1', 's-a3', 's-b1']);
mock.module('../../shared/preview-ownership', () => ({
  canAccessSandboxSession: async (input: { sessionId: string; callerSessionId: string | null }) =>
    input.callerSessionId === null && visibleSessions.has(input.sessionId),
}));

const { listVisibleChatSessions } = await import('./sessions');
const user = { platform: 'slack' as const, workspaceId: 'T1', platformUserId: 'U1' };
const row = (sessionId: string, projectId: string, accountId: string) => ({
  sessionId,
  projectId,
  accountId,
  projectName: projectId,
  repoUrl: `https://github.com/o/${projectId}`,
  lastMessageAt: new Date(),
});

beforeEach(() => {
  linked = { userId: 'user-1' };
  threadRows = [
    row('s-a1', 'proj-a', 'acct-a'), // visible
    row('s-a2', 'proj-a', 'acct-a'), // a private session of someone else
    row('s-b1', 'proj-b', 'acct-b'), // a project in an account the caller is not in
    row('s-a3', 'proj-a', 'acct-a'), // visible
  ];
});

describe('listVisibleChatSessions', () => {
  test('an unlinked caller gets no list at all', async () => {
    linked = null;
    expect(await listVisibleChatSessions(user, { limit: 5 })).toBeNull();
  });

  test('lists only sessions the linked user may open, in order', async () => {
    const rows = await listVisibleChatSessions(user, { limit: 5 });
    expect(rows?.map((r) => r.sessionId)).toEqual(['s-a1', 's-a3']);
  });

  test('the limit applies after filtering', async () => {
    const rows = await listVisibleChatSessions(user, { limit: 1 });
    expect(rows?.map((r) => r.sessionId)).toEqual(['s-a1']);
  });
});
