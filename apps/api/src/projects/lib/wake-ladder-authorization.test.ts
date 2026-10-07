import { beforeEach, describe, expect, mock, test } from 'bun:test';

let tokenValid = true;
let projectRow: Record<string, unknown> | null = { projectId: 'p1', accountId: 'a1' };
let access: Record<string, unknown> | null = { row: { projectId: 'p1', accountId: 'a1' }, userId: 'u1' };
let visible: Record<string, unknown> | null = { row: { agentName: null, metadata: {} }, canManageLifecycle: true };
let agentAllowed = true;
const tokenChecks: string[] = [];

mock.module('../../repositories/account-tokens', () => ({
  validateAccountTokenById: async (tokenId: string) => {
    tokenChecks.push(tokenId);
    return { isValid: tokenValid };
  },
}));
mock.module('./project-access', () => ({
  loadProjectRow: async () => projectRow,
  authorizeProjectAccess: async () => access,
}));
mock.module('./session-visibility', () => ({
  loadVisibleSession: async () => visible,
  sessionIsTombstoned: (row: { metadata?: { deleted?: boolean } }) => row.metadata?.deleted === true,
}));
mock.module('./agent-access', () => ({
  resolveAndAuthorizeAgentAs: async () => {
    if (!agentAllowed) throw new Error('agent_not_accessible');
    return {};
  },
}));

const { reauthorizeWakeLadderActor } = await import('./wake-ladder-authorization');

const input = (kind: 'jwt' | 'pat' = 'pat') => ({
  actor: { userId: 'u1', accountId: 'a1', credential: kind === 'pat' ? { kind, tokenId: 't1', projectId: null } : { kind }, ctx: {} } as never,
  onBehalfOf: undefined,
  isServiceAccount: false,
  userId: 'u1',
  projectId: 'p1',
  sessionId: 's1',
});

beforeEach(() => {
  tokenValid = true;
  projectRow = { projectId: 'p1', accountId: 'a1' };
  access = { row: { projectId: 'p1', accountId: 'a1' }, userId: 'u1' };
  visible = { row: { agentName: null, metadata: {} }, canManageLifecycle: true };
  agentAllowed = true;
  tokenChecks.length = 0;
});

describe('reauthorizeWakeLadderActor (asked before every ladder step)', () => {
  test('a watcher who still passes every gate gets fresh loaded/visible', async () => {
    const result = await reauthorizeWakeLadderActor(input());
    expect(result).toEqual({ loaded: access as never, visible: { row: visible!.row as never } });
    expect(tokenChecks).toEqual(['t1']);
  });

  test('a revoked token denies', async () => {
    tokenValid = false;
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
  });

  test('a browser login skips the token row but not the other gates', async () => {
    access = null;
    expect(await reauthorizeWakeLadderActor(input('jwt'))).toBeNull();
    expect(tokenChecks).toEqual([]);
  });

  test('lost project access, lost lifecycle right, a deleted session or a withdrawn agent grant each deny', async () => {
    projectRow = null;
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
    projectRow = { projectId: 'p1', accountId: 'a1' };
    access = null;
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
    access = { row: { projectId: 'p1', accountId: 'a1' }, userId: 'u1' };
    visible = { row: { agentName: null, metadata: {} }, canManageLifecycle: false };
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
    visible = { row: { agentName: null, metadata: { deleted: true } }, canManageLifecycle: true };
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
    visible = { row: { agentName: null, metadata: {} }, canManageLifecycle: true };
    agentAllowed = false;
    expect(await reauthorizeWakeLadderActor(input())).toBeNull();
  });
});
