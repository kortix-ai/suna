import { describe, expect, it, mock } from 'bun:test';

import type { ProjectSessionRow } from '../projects/lib/serializers';

// Every write the sync makes. The rows below that write nothing assert it here.
// The merge the real write performs is proven on PostgreSQL in
// `integration-session-title-claim.test.ts`.
const dbUpdates: Array<Record<string, unknown>> = [];
const realDb = await import('../shared/db');
mock.module('../shared/db', () => ({
  ...realDb,
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

  // Bun does not fail a test on an unhandled rejection, so the listener is the
  // proof that the scheduler catches a failed sync. The second schedule proves
  // the failure released the per-session slot.
  it('is best-effort — a failed sync is caught and frees the session for the next prompt', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
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
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unhandled).toEqual([]);

      const calls: string[] = [];
      scheduleOpencodeSnapshotSync(
        { sessionId: 's2', projectId: 'p', externalId: 'ext', userId: 'u1' },
        {
          firstMs: 0,
          retryMs: 0,
          loadRow: async () => row({ sessionId: 's2' }),
          sync: async ({ row: r }: { row: ProjectSessionRow }) => {
            calls.push(r.sessionId);
            return r;
          },
        },
      );
      await waitFor(() => calls.length === 2 && pendingSnapshotSyncs() === 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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
