import { describe, expect, it, mock } from 'bun:test';

import type { ProjectSessionRow } from '../projects/lib/serializers';

// Every write the sync makes. The rows below that write nothing assert it here.
// The merge the real write performs is proven on PostgreSQL in
// `integration-session-title-claim.test.ts`.
const dbUpdates: Array<Record<string, unknown>> = [];
const realDb = await import('../lib/db');
mock.module('../lib/db', () => ({
  ...realDb,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            dbUpdates.push(values);
            // No row back: the sync then returns the row with the metadata it merged.
            return [];
          },
        }),
      }),
    }),
  },
}));

const { syncOpencodeSessionSnapshot, scheduleOpencodeSnapshotSync, pendingSnapshotSyncs } =
  await import('../projects/opencode-session-snapshot');
type RuntimeLeg = Awaited<ReturnType<typeof import('../projects/lib/session-runtime-projection').readRuntimeLeg>>;

function row(over: Partial<ProjectSessionRow> = {}): ProjectSessionRow {
  return {
    sessionId: 's',
    projectId: 'p',
    accountId: 'a',
    runtimeSessionId: 'ses_root',
    metadata: {},
    ...over,
  } as unknown as ProjectSessionRow;
}

/** A stored runtime projection whose `sessions` lists these conversations. */
function knownLeg(sessions: unknown[], root: string | null = 'ses_root'): RuntimeLeg {
  return {
    known: true,
    identity: { runtime_session_id: root, opencode_session_id: root },
    state: { sessions: { known: true, value: sessions } },
  } as unknown as RuntimeLeg;
}

const conv = (id: string, parent: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  parent_id: parent,
  directory: '/workspace',
  time: { created: 1, updated: 2, compacting: null, archived: null },
  revert: null,
  ...extra,
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for snapshot sync');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('syncOpencodeSessionSnapshot', () => {
  it('writes the root and its children from the runtime projection, scoped to the pinned root', async () => {
    dbUpdates.length = 0;
    const synced = await syncOpencodeSessionSnapshot(
      { row: row() },
      {
        // The box reports another root; the pin decides.
        readLeg: async () =>
          knownLeg([
            conv('ses_root', null),
            conv('ses_child', 'ses_root', { time: { created: 3, updated: 9, compacting: null, archived: 7 } }),
            conv('ses_other_root', null),
          ], 'ses_other_root'),
      },
    );
    expect(dbUpdates).toHaveLength(1);
    expect((synced.metadata as { opencode_sessions: unknown }).opencode_sessions).toEqual([
      { id: 'ses_child', title: 'ses_child', parent_id: 'ses_root', project_id: null, created_at: 3, updated_at: 9, archived_at: 7 },
      { id: 'ses_root', title: 'ses_root', parent_id: null, project_id: null, created_at: 1, updated_at: 2, archived_at: null },
    ]);
  });

  it('pulls the projection from the box as the caller, then reads what was stored (a 304 included)', async () => {
    dbUpdates.length = 0;
    const pulls: unknown[] = [];
    await syncOpencodeSessionSnapshot(
      { row: row(), userId: 'u1' },
      {
        refresh: (async (target: unknown, options: unknown) => {
          pulls.push({ target, options });
          return { refreshed: false, reason: 'not_modified' };
        }) as never,
        readLeg: async () => knownLeg([conv('ses_root', null), conv('ses_child', 'ses_root')]),
      },
    );
    expect(pulls).toEqual([
      { target: { sessionId: 's', projectId: 'p', accountId: 'a', userId: 'u1' }, options: { force: true } },
    ]);
    expect(dbUpdates).toHaveLength(1);
  });

  it('no-ops when the snapshot is unchanged, the projection is unknown, or its list is unknown', async () => {
    dbUpdates.length = 0;
    const existing = [
      { id: 'ses_root', title: null, parent_id: null, project_id: null, created_at: null, updated_at: null, archived_at: null },
    ];
    await syncOpencodeSessionSnapshot(
      { row: row({ metadata: { opencode_sessions: existing } } as Partial<ProjectSessionRow>) },
      { readLeg: async () => knownLeg([{ id: 'ses_root', parent_id: null }]) },
    );
    expect(dbUpdates).toHaveLength(0);

    await syncOpencodeSessionSnapshot(
      { row: row() },
      { readLeg: async () => ({ known: false, reason: 'identity_mismatch' }) as RuntimeLeg },
    );
    await syncOpencodeSessionSnapshot(
      { row: row() },
      {
        readLeg: async () =>
          ({ known: true, identity: {}, state: { sessions: { known: false, value: [] } } }) as unknown as RuntimeLeg,
      },
    );
    expect(dbUpdates).toHaveLength(0);
  });

  it('with no pin, scopes to the root the box reports', async () => {
    const synced = await syncOpencodeSessionSnapshot(
      { row: row({ runtimeSessionId: null } as Partial<ProjectSessionRow>) },
      { readLeg: async () => knownLeg([conv('ses_box_root', null), conv('ses_kid', 'ses_box_root')], 'ses_box_root') },
    );
    const ids = (synced.metadata as { opencode_sessions: Array<{ id: string }> }).opencode_sessions.map((c) => c.id);
    expect(ids.sort()).toEqual(['ses_box_root', 'ses_kid']);
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
      { sessionId: 's', projectId: 'p', accountId: 'a', userId: 'u1' },
      opts,
    );
    // A second schedule while the first is in flight is deduped.
    scheduleOpencodeSnapshotSync(
      { sessionId: 's', projectId: 'p', accountId: 'a', userId: 'u1' },
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
        { sessionId: 's2', projectId: 'p', accountId: 'a', userId: 'u1' },
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
        { sessionId: 's2', projectId: 'p', accountId: 'a', userId: 'u1' },
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
  // without it (apps/kortix-sandbox-agent-server/src/app/server.ts). So the list
  // degraded to `unreachable`, `syncOpencodeSessionSnapshot` returned the row
  // untouched, and `metadata.opencode_sessions` was NEVER written: 0 of 2804
  // staging sessions created in 2026-08 had a populated snapshot. Pin that the
  // identity survives the whole hop from schedule to sync.
  it('carries the caller userId through to the sync that talks to the daemon', async () => {
    const seen: Array<string | undefined> = [];
    scheduleOpencodeSnapshotSync(
      { sessionId: 's3', projectId: 'p', accountId: 'a', userId: 'user-42' },
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
