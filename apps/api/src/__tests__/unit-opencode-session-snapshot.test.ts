import { describe, expect, it, mock } from 'bun:test';

import type { ProjectSessionRow } from '../projects/lib/serializers';
import { projectSessionMetadataMerge } from '../projects/lib/session-metadata-merge';

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

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for snapshot sync');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('syncOpencodeSessionSnapshot', () => {
  it('MERGES opencode_sessions in-SQL and never rewrites the rest of metadata', async () => {
    dbUpdates.length = 0;
    listResult = {
      ok: true,
      sessions: [{ id: 'ses_root', title: 'A Real Title', parentID: null }],
    };
    // A title the CAS commits between this pass's read and its write must
    // survive: a read-modify-write of the whole object would drop it, and for a
    // one-shot automation session nothing ever re-titles.
    await syncOpencodeSessionSnapshot({
      row: row({ metadata: { name: 'Set Up MS Graph' } } as Partial<ProjectSessionRow>),
      externalId: 'ext',
    });
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].metadata).toEqual(
      projectSessionMetadataMerge({
        opencode_sessions: [
          {
            id: 'ses_root',
            title: 'A Real Title',
            parent_id: null,
            project_id: null,
            created_at: null,
            updated_at: null,
            archived_at: null,
          },
        ],
      }),
    );
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
    scheduleOpencodeSnapshotSync(
      { sessionId: 's', projectId: 'p', externalId: 'ext', userId: 'u1' },
      opts,
    );
    // A second schedule while the first is in flight is deduped.
    scheduleOpencodeSnapshotSync(
      { sessionId: 's', projectId: 'p', externalId: 'ext', userId: 'u1' },
      opts,
    );
    expect(pendingSnapshotSyncs()).toBe(1);
    await waitFor(() => calls.length === 2 && pendingSnapshotSyncs() === 0);
    expect(calls).toEqual(['s', 's']);
    expect(pendingSnapshotSyncs()).toBe(0);
  });

  it('is best-effort — a sync failure never throws', async () => {
    await expect(
      (async () => {
        scheduleOpencodeSnapshotSync(
          { sessionId: 's2', projectId: 'p', externalId: 'ext', userId: 'u1' },
          {
            firstMs: 0,
            retryMs: 0,
            loadRow: async () => row({ sessionId: 's2' }),
            sync: async () => {
              throw new Error('sandbox unreachable');
            },
          },
        );
        await waitFor(() => pendingSnapshotSyncs() === 0);
      })(),
    ).resolves.toBeUndefined();
  });

  // REGRESSION (staging release gate, SESS-10). The scheduler used to drop the
  // caller's `userId` on the floor. `sandboxOpencodeEndpoint` mints the
  // X-Kortix-User-Context header only when a userId is present, and the daemon's
  // auth gate 401s every non-`/kortix/*` path — `GET /session` included —
  // without it (apps/kortix-sandbox-agent-server/src/proxy.ts). So the list
  // degraded to `unreachable`, `syncOpencodeSessionSnapshot` returned the row
  // untouched, and `metadata.opencode_sessions` was NEVER written: 0 of 2804
  // staging sessions created in 2026-08 had a populated snapshot. Pin that the
  // identity survives the whole hop from schedule to sync.
  it('carries the caller userId through to the sync that talks to the daemon', async () => {
    const seen: Array<string | undefined> = [];
    scheduleOpencodeSnapshotSync(
      { sessionId: 's3', projectId: 'p', externalId: 'ext', userId: 'user-42' },
      {
        firstMs: 0,
        retryMs: 0,
        loadRow: async () => row({ sessionId: 's3' }),
        sync: async ({ row: r, userId }: { row: ProjectSessionRow; userId?: string }) => {
          seen.push(userId);
          return r;
        },
      },
    );
    await waitFor(() => seen.length === 2 && pendingSnapshotSyncs() === 0);
    expect(seen).toEqual(['user-42', 'user-42']);
  });
});
