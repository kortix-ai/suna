import { describe, expect, it, mock } from 'bun:test';

import type { ProjectSessionRow } from '../projects/lib/serializers';

// Mock the DB write and the sandbox session listing before importing the module.
const dbUpdates: Array<Record<string, unknown>> = [];
mock.module('../shared/db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            dbUpdates.push(values);
            return [values];
          },
        }),
      }),
    }),
  },
}));

let listResult: { ok: boolean; sessions: unknown[]; reason?: string } = { ok: true, sessions: [] };
mock.module('../projects/opencode-mapping', () => ({
  listSandboxOpencodeSessions: async () => listResult,
  resolveRootSessionId: ({ sessions }: { sessions: Array<{ id: string }> }) =>
    sessions[0]?.id ?? null,
}));

const { syncOpencodeSessionSnapshot, scheduleOpencodeSnapshotSync, pendingSnapshotSyncs } =
  await import('../projects/opencode-session-snapshot');

function row(over: Partial<ProjectSessionRow> = {}): ProjectSessionRow {
  return {
    sessionId: 's',
    projectId: 'p',
    accountId: 'a',
    opencodeSessionId: 'ses_root',
    metadata: {},
    ...over,
  } as unknown as ProjectSessionRow;
}

describe('syncOpencodeSessionSnapshot', () => {
  it('writes opencode_sessions and NEVER touches the title (metadata.name)', async () => {
    dbUpdates.length = 0;
    listResult = {
      ok: true,
      sessions: [{ id: 'ses_root', title: 'A Real Title', parentID: null }],
    };
    await syncOpencodeSessionSnapshot({ row: row(), externalId: 'ext' });
    expect(dbUpdates).toHaveLength(1);
    const metadata = dbUpdates[0].metadata as Record<string, unknown>;
    const sessions = metadata.opencode_sessions as Array<{ id: string; title: string | null }>;
    expect(sessions[0]).toMatchObject({ id: 'ses_root', title: 'A Real Title' });
    // The snapshot carries each conversation's own title, but must not set the
    // session's name — that is session-title-generate's sole responsibility.
    expect('name' in metadata).toBe(false);
  });

  it('no-ops when the snapshot is unchanged and on unreachable sandboxes', async () => {
    dbUpdates.length = 0;
    const existing = [
      {
        id: 'ses_root',
        title: null,
        parent_id: null,
        project_id: null,
        created_at: null,
        updated_at: null,
        archived_at: null,
      },
    ];
    listResult = { ok: true, sessions: [{ id: 'ses_root', parentID: null }] };
    await syncOpencodeSessionSnapshot({
      row: row({ metadata: { opencode_sessions: existing } } as Partial<ProjectSessionRow>),
      externalId: 'ext',
    });
    expect(dbUpdates).toHaveLength(0);

    listResult = { ok: false, sessions: [], reason: 'unreachable' };
    await syncOpencodeSessionSnapshot({ row: row(), externalId: 'ext' });
    expect(dbUpdates).toHaveLength(0);
  });
});

describe('scheduleOpencodeSnapshotSync', () => {
  it('fires the sync twice (first + retry), deduped per session', async () => {
    const calls: string[] = [];
    const opts = {
      firstMs: 0,
      retryMs: 0,
      loadRow: async () => row(),
      sync: async ({ row: r }: { row: ProjectSessionRow }) => {
        calls.push(r.sessionId);
        return r;
      },
    };
    scheduleOpencodeSnapshotSync({ sessionId: 's', projectId: 'p', externalId: 'ext' }, opts);
    // A second schedule while the first is in flight is deduped.
    scheduleOpencodeSnapshotSync({ sessionId: 's', projectId: 'p', externalId: 'ext' }, opts);
    expect(pendingSnapshotSyncs()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(calls).toEqual(['s', 's']);
    expect(pendingSnapshotSyncs()).toBe(0);
  });

  it('is best-effort — a sync failure never throws', async () => {
    await expect(
      (async () => {
        scheduleOpencodeSnapshotSync(
          { sessionId: 's2', projectId: 'p', externalId: 'ext' },
          {
            firstMs: 0,
            retryMs: 0,
            loadRow: async () => row({ sessionId: 's2' }),
            sync: async () => {
              throw new Error('sandbox unreachable');
            },
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 15));
      })(),
    ).resolves.toBeUndefined();
  });
});
