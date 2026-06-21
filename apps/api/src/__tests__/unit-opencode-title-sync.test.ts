import { afterEach, describe, expect, mock, test } from 'bun:test';

import { projectSessions, sessionSandboxes } from '@kortix/db';

const sandboxRows: Array<{ sessionId: string; externalId: string | null }> = [];
const dbUpdates: Array<Record<string, unknown>> = [];
let listedSessions: any[] = [];

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === sessionSandboxes) return sandboxRows;
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table === projectSessions) dbUpdates.push(updates);
            return [];
          },
        }),
      }),
    }),
  },
}));

mock.module('../projects/opencode-mapping', () => ({
  listSandboxOpencodeSessions: async () => ({
    ok: true,
    sessions: listedSessions,
  }),
  resolveRootSessionId: ({
    pinnedRootId,
    sessions,
  }: {
    pinnedRootId: string | null;
    sessions: Array<{ id: string; parentID?: string | null }>;
  }) =>
    pinnedRootId && sessions.some((session) => session.id === pinnedRootId)
      ? pinnedRootId
      : sessions.find((session) => !session.parentID)?.id ?? null,
}));

const { syncOpenCodeTitlesForSessions } = await import('../projects/opencode-title-sync');

afterEach(() => {
  sandboxRows.length = 0;
  dbUpdates.length = 0;
  listedSessions = [];
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'account-1',
    opencodeSessionId: null,
    metadata: {},
    ...overrides,
  } as any;
}

describe('syncOpenCodeTitlesForSessions', () => {
  test('fetches OpenCode sessions server-side and mirrors the root title/tree', async () => {
    sandboxRows.push({ sessionId: 'session-1', externalId: 'sandbox-ext-1' });
    listedSessions = [
      { id: 'root-1', title: 'Generated title', time: { created: 1, updated: 10 } },
      {
        id: 'child-1',
        title: 'Follow-up',
        parentID: 'root-1',
        time: { created: 2, updated: 20 },
      },
    ];

    const [synced] = await syncOpenCodeTitlesForSessions({
      rows: [row()],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
    });

    expect(synced.opencodeSessionId).toBe('root-1');
    const metadata = synced.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('Generated title');
    expect(metadata.opencode_sessions).toEqual([
      {
        id: 'child-1',
        title: 'Follow-up',
        parent_id: 'root-1',
        project_id: null,
        created_at: 2,
        updated_at: 20,
        archived_at: null,
      },
      {
        id: 'root-1',
        title: 'Generated title',
        parent_id: null,
        project_id: null,
        created_at: 1,
        updated_at: 10,
        archived_at: null,
      },
    ]);
    expect(dbUpdates.at(-1)).toMatchObject({
      opencodeSessionId: 'root-1',
      metadata,
    });
  });

  test('does not erase an existing mirrored name when OpenCode has no title yet', async () => {
    sandboxRows.push({ sessionId: 'session-1', externalId: 'sandbox-ext-1' });
    listedSessions = [{ id: 'root-1', title: null, time: { created: 1, updated: 1 } }];

    const [synced] = await syncOpenCodeTitlesForSessions({
      rows: [row({ metadata: { name: 'Previous title' } })],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
    });

    const metadata = synced.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('Previous title');
    expect(dbUpdates.at(-1)?.metadata).toMatchObject({ name: 'Previous title' });
  });
});
