import { beforeEach, describe, expect, mock, test } from 'bun:test';

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

type DbChain = Promise<unknown[]> & {
  from: () => DbChain;
  where: () => DbChain;
  limit: () => DbChain;
  onConflictDoUpdate: () => DbChain;
  values: (payload: unknown) => DbChain;
};

function makeChain(op: string): DbChain {
  const chain = Promise.resolve(dbResults.shift() ?? []) as DbChain;
  for (const method of ['from', 'where', 'limit', 'onConflictDoUpdate'] as const) {
    chain[method] = () => chain;
  }
  chain.values = (payload: unknown) => {
    dbWrites.push({ op: `${op}.values`, payload });
    return chain;
  };
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
  },
  hasDatabase: () => true,
}));

const { resolveConversationWorkspace, setConversationWorkspace } = await import(
  '../channels/teams/binding'
);

beforeEach(() => {
  dbResults = [];
  dbWrites = [];
});

describe('Teams conversation binding', () => {
  test('ignores a stale binding to a project that is no longer installed for the tenant', async () => {
    dbResults = [[{ workspaceId: 'proj-stale' }], [], [{ workspaceId: 'proj-installed' }]];

    await expect(resolveConversationWorkspace('tenant-1', 'conv-1')).resolves.toBe('proj-installed');
  });

  test('refuses to bind a project that is not installed for the tenant', async () => {
    dbResults = [[]];
    const switched = await setConversationWorkspace({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      workspaceId: 'proj-other',
    });

    expect(switched).toBe(false);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
  });

  test('binds the conversation when the project is installed for the tenant', async () => {
    dbResults = [[{ workspaceId: 'proj-1' }], []];
    const switched = await setConversationWorkspace({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      workspaceId: 'proj-1',
    });

    expect(switched).toBe(true);
    expect(dbWrites.find((w) => w.op === 'insert.values')?.payload).toMatchObject({
      platform: 'teams',
      platformWorkspaceId: 'tenant-1',
      channelId: 'conv-1',
      workspaceId: 'proj-1',
    });
  });
});
