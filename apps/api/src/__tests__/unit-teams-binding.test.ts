import { beforeEach, describe, expect, mock, test } from 'bun:test';

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

type DbChain = Promise<unknown[]> & {
  from: () => DbChain;
  innerJoin: () => DbChain;
  where: () => DbChain;
  limit: () => DbChain;
  onConflictDoUpdate: () => DbChain;
  values: (payload: unknown) => DbChain;
};

function makeChain(op: string): DbChain {
  const chain = Promise.resolve(dbResults.shift() ?? []) as DbChain;
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'onConflictDoUpdate'] as const) {
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

const { resolveConversationProject, ensureTeamsConversationBinding, resetTeamsBindingCacheForTest, teamsThreadTitles } =
  await import('../channels/teams/binding');

beforeEach(() => {
  dbResults = [];
  dbWrites = [];
});

describe('Teams conversation binding', () => {
  test('ignores a stale binding to a project that is no longer installed for the tenant', async () => {
    dbResults = [[{ projectId: 'proj-stale' }], [], [{ projectId: 'proj-installed' }]];

    await expect(resolveConversationProject('tenant-1', 'conv-1')).resolves.toBe('proj-installed');
  });

  test('refuses to bind a project that is not installed for the tenant', async () => {
    dbResults = [[]];
    const switched = await ensureTeamsConversationBinding({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      projectId: 'proj-other',
    });

    expect(switched).toBe(false);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
  });

  test('binds the conversation when the project is installed for the tenant', async () => {
    dbResults = [[{ projectId: 'proj-1' }], []];
    const switched = await ensureTeamsConversationBinding({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      projectId: 'proj-1',
    });

    expect(switched).toBe(true);
    expect(dbWrites.find((w) => w.op === 'insert.values')?.payload).toMatchObject({
      platform: 'teams',
      workspaceId: 'tenant-1',
      channelId: 'conv-1',
      projectId: 'proj-1',
    });
  });

  test('a write that sets nothing new is skipped: a nameless write after a named one, every message', async () => {
    resetTeamsBindingCacheForTest();
    const thread = { tenantId: 'tenant-1', conversationId: 'thread-1', projectId: 'proj-1' };
    const writes = () => dbWrites.filter((w) => w.op === 'insert.values').length;

    dbResults = [[{ projectId: 'proj-1' }], []];
    await ensureTeamsConversationBinding({ ...thread, channelType: 'channel' });
    dbResults = [[{ projectId: 'proj-1' }], []];
    await ensureTeamsConversationBinding({ ...thread, channelName: 'Eng › General', channelType: 'channel' });
    expect(writes()).toBe(2);

    // Each later message describes the thread without a name, then labels it.
    for (let message = 0; message < 3; message++) {
      dbResults = [[{ projectId: 'proj-1' }], []];
      await ensureTeamsConversationBinding({ ...thread, channelType: 'channel' });
      dbResults = [[{ projectId: 'proj-1' }], []];
      await ensureTeamsConversationBinding({ ...thread, channelName: 'Eng › General', channelType: 'channel' });
    }
    expect(writes()).toBe(2);

    // A rename or a move to another project still writes.
    dbResults = [[{ projectId: 'proj-1' }], []];
    await ensureTeamsConversationBinding({ ...thread, channelName: 'Eng › Announcements', channelType: 'channel' });
    dbResults = [[{ projectId: 'proj-2' }], []];
    await ensureTeamsConversationBinding({ ...thread, projectId: 'proj-2' });
    expect(writes()).toBe(4);
  });
});

describe('teamsThreadTitles', () => {
  test("names each channel thread after its session: what tells two threads of one channel apart", async () => {
    dbResults = [
      [
        { threadId: '19:c@thread.tacv2;messageid=1', metadata: { name: '<at>Kortix</at> Deploy review' } },
        { threadId: '19:c@thread.tacv2;messageid=2', metadata: { name: 'Generated title', custom_name: 'Renamed by hand' } },
        { threadId: '19:c@thread.tacv2;messageid=3', metadata: { name: '   ' } },
        { threadId: '19:c@thread.tacv2;messageid=4', metadata: null },
      ],
    ];
    const titles = await teamsThreadTitles('proj-1', ['19:c@thread.tacv2;messageid=1', '19:c@thread.tacv2;messageid=2']);
    expect([...titles]).toEqual([
      ['19:c@thread.tacv2;messageid=1', 'Deploy review'],
      ['19:c@thread.tacv2;messageid=2', 'Renamed by hand'],
    ]);
  });

  test('asks the database nothing for no threads', async () => {
    dbResults = [[{ threadId: 'x', metadata: { name: 'never read' } }]];
    expect((await teamsThreadTitles('proj-1', [])).size).toBe(0);
    expect(dbResults).toHaveLength(1);
  });
});
