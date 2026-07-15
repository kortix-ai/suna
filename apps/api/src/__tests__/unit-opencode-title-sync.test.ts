import { afterEach, describe, expect, mock, test } from 'bun:test';

import { projectSessions, sessionSandboxes } from '@kortix/db';

const sandboxRows: Array<{ sessionId: string; externalId: string | null }> = [];
const dbUpdates: Array<Record<string, unknown>> = [];
let listedSessions: any[] = [];
// Externals whose sandbox lookup should THROW (e.g. provider rate limit /
// archived box) — used to prove one bad sandbox never sinks the whole batch.
const throwForExternalIds = new Set<string>();
const hangForExternalIds = new Set<string>();

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
  listSandboxOpencodeSessions: async (externalId: string) => {
    if (hangForExternalIds.has(externalId)) {
      return new Promise(() => {});
    }
    if (throwForExternalIds.has(externalId)) {
      throw new Error(`DaytonaRateLimitError: ThrottlerException: Too Many Requests (${externalId})`);
    }
    return {
      ok: true,
      sessions: listedSessions,
    };
  },
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

const { syncOpenCodeTitlesForSessions, isPlaceholderOpencodeTitle } = await import(
  '../projects/opencode-title-sync'
);

afterEach(() => {
  sandboxRows.length = 0;
  dbUpdates.length = 0;
  listedSessions = [];
  throwForExternalIds.clear();
  hangForExternalIds.clear();
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

describe('isPlaceholderOpencodeTitle', () => {
  test("matches OpenCode's default title in any casing, with or without a date", () => {
    expect(isPlaceholderOpencodeTitle('New session - 2026-06-29T10:00:00Z')).toBe(true);
    expect(isPlaceholderOpencodeTitle('new session')).toBe(true);
    expect(isPlaceholderOpencodeTitle('  New Session - x  ')).toBe(true);
  });

  test('real titles and empty values are not placeholders', () => {
    expect(isPlaceholderOpencodeTitle('Fix login bug')).toBe(false);
    expect(isPlaceholderOpencodeTitle('New sessions dashboard')).toBe(false);
    expect(isPlaceholderOpencodeTitle('')).toBe(false);
    expect(isPlaceholderOpencodeTitle(null)).toBe(false);
    expect(isPlaceholderOpencodeTitle(undefined)).toBe(false);
  });
});

describe('syncOpenCodeTitlesForSessions', () => {
  test("never persists OpenCode's placeholder default as the session name", async () => {
    sandboxRows.push({ sessionId: 'session-1', externalId: 'sandbox-ext-1' });
    listedSessions = [
      { id: 'root-1', title: 'New session - 2026-06-29T10:00:00Z', time: { created: 1, updated: 1 } },
    ];

    const [synced] = await syncOpenCodeTitlesForSessions({
      rows: [row()],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
    });

    const metadata = synced.metadata as Record<string, unknown>;
    expect(metadata.name).toBeUndefined();
  });

  test('a real title replaces a previously frozen placeholder name', async () => {
    sandboxRows.push({ sessionId: 'session-1', externalId: 'sandbox-ext-1' });
    listedSessions = [{ id: 'root-1', title: 'Ship the wizard', time: { created: 1, updated: 9 } }];

    const [synced] = await syncOpenCodeTitlesForSessions({
      rows: [row({ metadata: { name: 'New session - 2026-06-29T10:00:00Z' } })],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
    });

    const metadata = synced.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('Ship the wizard');
  });

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

  test('one throttled/unreachable sandbox does not reject the batch; other rows still sync', async () => {
    // Regression: a single sandbox whose lookup throws (provider rate limit /
    // archived box) used to reject the whole `Promise.all`, 500ing GET /sessions.
    // The batch must now resolve, keeping the bad row unchanged and syncing the rest.
    sandboxRows.push(
      { sessionId: 'ok-session', externalId: 'sandbox-ok' },
      { sessionId: 'bad-session', externalId: 'sandbox-bad' },
    );
    throwForExternalIds.add('sandbox-bad');
    listedSessions = [{ id: 'root-ok', title: 'Synced', time: { created: 1, updated: 10 } }];

    const result = await syncOpenCodeTitlesForSessions({
      rows: [
        row({ sessionId: 'ok-session', metadata: {} }),
        row({ sessionId: 'bad-session', metadata: { name: 'Kept' }, opencodeSessionId: 'pin-bad' }),
      ],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
    });

    // Batch resolved (no throw), order preserved, both rows returned.
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.sessionId)).toEqual(['ok-session', 'bad-session']);
    // The reachable sandbox synced its root/title.
    expect(result[0].opencodeSessionId).toBe('root-ok');
    expect((result[0].metadata as Record<string, unknown>).name).toBe('Synced');
    // The throwing sandbox's row is returned UNCHANGED (best-effort fallback).
    expect(result[1].opencodeSessionId).toBe('pin-bad');
    expect((result[1].metadata as Record<string, unknown>).name).toBe('Kept');
  });

  test('returns cached rows when title sync exceeds the read deadline', async () => {
    sandboxRows.push({ sessionId: 'slow-session', externalId: 'sandbox-slow' });
    hangForExternalIds.add('sandbox-slow');
    const original = row({
      sessionId: 'slow-session',
      metadata: { name: 'Cached title' },
      opencodeSessionId: 'cached-pin',
    });

    const result = await syncOpenCodeTitlesForSessions({
      rows: [original],
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      deadlineMs: 10,
    });

    expect(result).toEqual([original]);
    expect(dbUpdates).toHaveLength(0);
  });
});
