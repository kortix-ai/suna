import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { appRuntimes, projectSessions, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import * as realProviders from '../platform/providers';
import * as realComputeMetering from '../billing/services/compute-metering';

// ── mock state ──────────────────────────────────────────────────────────────
let candidates: any[] = [];
let appRuntimeKeepRows: any[] = [];
let statusByExternal: Record<string, 'running' | 'stopped' | 'removed' | 'unknown'> = {};
let stopErrorByExternal: Record<string, Error> = {};
let stops: string[] = [];
let stopsByProvider: Array<{ provider: string; externalId: string }> = [];
let managedBoxes: Array<{ externalId: string; createdAt: Date | null }> = [];
let e2bManagedBoxes: Array<{ externalId: string; createdAt: Date | null }> = [];
let cacheInvalidations: string[] = [];
let pausedCompute: string[] = [];
let endedCompute: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let stuckSessions: Array<{ sessionId: string }> = [];
let computeRows: any[] = [];
let pausedComputeWindows: Array<{ sandboxId: string; windowEnd: Date | undefined }> = [];

let orderByExpressions: string[] = [];
let statusCalls: string[] = [];
let livenessStamps: Array<{ sandboxId: string; at: Date }> = [];

/**
 * What the DB returns for the LAST-MOMENT deadline re-read, when it differs from
 * the value in the pass's snapshot. This is the TOCTOU: the sweep snapshots
 * candidates, then burns a multi-second provider round-trip per row, and a prompt
 * arriving inside that window extends `deadline_at` after the snapshot was taken.
 * `null` models the row being unreadable/gone.
 */
let freshDeadlineBySandbox: Record<string, Date | null> = {};

/** Mirrors the ORDER BY the reaper asks Postgres for, so a pass over more rows
 *  than the batch actually rotates instead of re-selecting the same head:
 *  EXPIRED first, then least-recently-visited. The visit stamp is an ISO-8601
 *  UTC string, where lexicographic order IS chronological order, and a missing
 *  key sorts first (SQL `nulls first`). */
function applyOrder(rows: any[], now: Date = NOW): any[] {
  const visited = (r: any) =>
    'startedAt' in r ? String(r.startedAt ?? '') : String(r.metadata?.reaperVisitedAt ?? '');
  const expired = (r: any) =>
    r?.deadlineAt instanceof Date && r.deadlineAt.getTime() <= now.getTime() ? 0 : 1;
  return [...rows].sort(
    (a, b) => expired(a) - expired(b) || visited(a).localeCompare(visited(b)),
  );
}

/** Flatten a drizzle SQL expression to its literal text so a test can assert
 *  what the sweep actually asks Postgres to order by. */
function describeSql(expression: any): string {
  const chunks: unknown[] = expression?.queryChunks ?? [];
  return chunks
    .map((chunk: any) => {
      if (typeof chunk === 'string') return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join('');
      return chunk?.name ?? '';
    })
    .join(' ');
}

/** Pull the BOUND VALUES out of a drizzle predicate, so the mock can answer a
 *  single-row lookup with the row that was actually asked for instead of
 *  whichever row happens to be first. Without this the reaper's last-moment
 *  deadline re-read (reloadDeadlineAt) is answered from `candidates[0]` and a
 *  multi-row pass silently tests nothing. */
function sqlValues(expression: unknown): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node.queryChunks)) {
      for (const chunk of node.queryChunks) walk(chunk);
      return;
    }
    const value = node.value;
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  };
  walk(expression);
  return out;
}

/** A thenable that also exposes the chainable clause methods, so `await where()`
 *  and `where().orderBy().limit()` resolve to the same rows. */
function hybrid(rows: any[], throwOnGroupBy = false): any {
  const p: any = Promise.resolve(rows);
  p.limit = (n?: number) =>
    hybrid(typeof n === 'number' ? rows.slice(0, n) : rows, throwOnGroupBy);
  p.orderBy = (...expressions: unknown[]) => {
    for (const expression of expressions) orderByExpressions.push(describeSql(expression));
    return hybrid(applyOrder(rows), throwOnGroupBy);
  };
  p.groupBy = async () => {
    if (throwOnGroupBy) throw new Error('db down');
    return rows;
  };
  return p;
}

/** The reaper stamps `reaperVisitedAt` on every row it examined in ONE batched
 *  update. It is bookkeeping, not a decision, so assertions about what the pass
 *  DID to a row filter it out — it is the only update that sets metadata alone. */
function isVisitStamp(call: { updates: Record<string, unknown> }): boolean {
  const keys = Object.keys(call.updates);
  return keys.length === 1 && keys[0] === 'metadata';
}
const rowUpdates = () => updateCalls.filter((c) => !isVisitStamp(c));
const visitStamps = () => updateCalls.filter(isVisitStamp);

// Mock config (the only field used is KORTIX_SANDBOX_AUTOSTOP_MINUTES) so the
// test doesn't import the real config, which calls process.exit on incomplete
// local env. Run this file in its own `bun test <file>` invocation (as CI does)
// so the mock never leaks into a sibling file that uses the real config.
mock.module('../config', () => ({ config: {
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: 5,
  ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'e2b'],
} }));

mock.module('../shared/db', () => ({
  db: {
    transaction: async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const isCount = !!projection && 'total' in projection;
        // The last-moment deadline re-read is the only projection that asks for
        // deadline_at ALONE, and it is keyed by sandbox_id — so answer it with
        // that row's CURRENT deadline, which is what the TOCTOU tests move under
        // the reaper's feet.
        const isDeadlineReread =
          !!projection && 'deadlineAt' in projection && Object.keys(projection).length === 1;
        const builder: any = {
          innerJoin: () => builder,
          leftJoin: () => builder,
          where: (predicate?: unknown) => {
            if (isCount) return hybrid([{ total: candidates.length }]);
            if (isDeadlineReread) {
              const asked = new Set(sqlValues(predicate));
              const id = [...asked].find((v) => v in freshDeadlineBySandbox);
              if (id) {
                const fresh = freshDeadlineBySandbox[id];
                return hybrid(fresh === null ? [] : [{ deadlineAt: fresh }]);
              }
              const row = candidates.find((c) => asked.has(c.sandboxId));
              return hybrid(row ? [{ deadlineAt: row.deadlineAt }] : []);
            }
            return hybrid(
              table === sessionSandboxes
                ? candidates
                : table === appRuntimes
                  ? appRuntimeKeepRows
                : table === sandboxComputeSessions
                  ? computeRows
                  : table === projectSessions
                    ? stuckSessions
                    : [],
            );
          },
        };
        return builder;
      },
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        // Awaitable (reconcileRowToStopped), chainable to `.returning()`
        // (reconcileStuckActiveSessions), and `.catch()`-able (the batched
        // visit stamp). Records exactly one update call whichever is used.
        where: () => {
          let recorded = false;
          const record = () => {
            if (recorded) return;
            recorded = true;
            updateCalls.push({ table, updates });
          };
          record();
          const p: any = Promise.resolve(undefined);
          p.returning = async () => [{ sessionId: 'updated' }];
          return p;
        },
      }),
    }),
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../platform/providers', () => ({
  ...realProviders,
  // 60 minutes — the provider's own idle auto-stop, and therefore the ceiling
  // on how long a window may bill past its last liveness observation.
  providerAutoStopBackstopMinutes: () => 60,
  getProvider: (name: string) => ({
    getStatus: async (externalId: string) => {
      statusCalls.push(externalId);
      return statusByExternal[externalId] ?? 'unknown';
    },
    stop: async (externalId: string) => {
      stops.push(externalId);
      stopsByProvider.push({ provider: name, externalId });
      const err = stopErrorByExternal[externalId];
      if (err) throw err;
    },
    listManagedRunningSandboxes: async () => name === 'e2b' ? e2bManagedBoxes : managedBoxes,
  }),
}));

mock.module('../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  reopenComputeForSandbox: async () => undefined,
  markComputeSessionAlive: async (sandboxId: string, at: Date) => {
    livenessStamps.push({ sandboxId, at });
  },
  pauseComputeSession: async (sandboxId: string, windowEnd?: Date) => {
    pausedCompute.push(sandboxId);
    pausedComputeWindows.push({ sandboxId, windowEnd });
  },
  endComputeSession: async (sandboxId: string) => {
    endedCompute.push(sandboxId);
  },
}));

const {
  decideReconcile,
  decideComputeClose,
  computeCloseWindowEnd,
  hasFailedRuntimeStart,
  reapAndReconcileSandboxes,
  reconcileOrphanComputeSessions,
  reapOrphanProviderBoxes,
  reconcileStuckActiveSessions,
  REAP_BATCH_SIZE,
} = await import('./sandbox-reaper');

const HOUR = 3_600_000;

beforeEach(() => {
  candidates = [];
  appRuntimeKeepRows = [];
  statusByExternal = {};
  stopErrorByExternal = {};
  stops = [];
  stopsByProvider = [];
  managedBoxes = [];
  e2bManagedBoxes = [];
  cacheInvalidations = [];
  pausedCompute = [];
  endedCompute = [];
  updateCalls = [];
  stuckSessions = [];
  computeRows = [];
  pausedComputeWindows = [];
  orderByExpressions = [];
  statusCalls = [];
  livenessStamps = [];
  freshDeadlineBySandbox = {};
});

// ── pure decision functions (the money + UX correctness lives here) ──────────
describe('decideReconcile', () => {
  test('never acts on unknown provider state', () => {
    expect(decideReconcile('unknown')).toBe('none');
  });
  test('removed → reconcile-removed', () => {
    expect(decideReconcile('removed')).toBe('reconcile-removed');
  });
  test('provider already stopped → reconcile-stopped', () => {
    expect(decideReconcile('stopped')).toBe('reconcile-stopped');
  });
  test('running is not a reconcile concern', () => {
    expect(decideReconcile('running')).toBe('none');
  });
  // Daytona `error` / Platinum `failed` used to arrive here as 'unknown' and so
  // returned 'none' forever, leaving the row `active` and its compute window
  // billing wall-clock against a box that had been dead for weeks (12 of the
  // longest-billed open prod rows were ALL in Daytona state `error`).
  test('REGRESSION: a terminal (dead) box reconciles and closes billing', () => {
    expect(decideReconcile('terminal')).toBe('reconcile-stopped');
  });
});

// ── orchestration ────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-21T12:00:00Z');
function candidate(over: Partial<any> = {}) {
  return {
    sandboxId: 'sb-1',
    sessionId: 'sess-1',
    accountId: 'acct-1',
    provider: 'daytona',
    externalId: 'ext-1',
    metadata: null,
    // Healthy by default: a live deadline. Tests that want a kill set it.
    deadlineAt: new Date(NOW.getTime() + HOUR),
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    ...over,
  };
}

describe('reapAndReconcileSandboxes — the one rule: deadline_at <= now', () => {
  // ═══ THE REGRESSION THIS EXISTS TO KILL ═══
  // Prod 2026-07-29: 187 running boxes, 156 with zero LLM usage_events, oldest
  // 264 HOURS. Three mechanisms — an execution lease the box renewed itself, a
  // busy probe answered by that same wedged daemon, and an activity clock the
  // lease renewal stamped — each vetoed the stop, and all three were written by
  // the subject of the judgement. The box forged the evidence used to judge it.
  test('REGRESSION: a WEDGED box with no observed turn dies at the ceiling', async () => {
    candidates = [
      candidate({
        // 264h old, exactly the observed worst case, and still claiming to be
        // busy via the metadata the old code trusted.
        createdAt: new Date(NOW.getTime() - 264 * HOUR),
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
          lastTurnAt: NOW.toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual(['ext-1']);
    // Billing is settled against the still-active row before the flip.
    expect(pausedCompute).toEqual(['sb-1']);
    expect(cacheInvalidations).toEqual(['ext-1']);
    expect(updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped')).toBe(true);
    expect(updateCalls.some((c) => c.table === projectSessions && c.updates.status === 'stopped')).toBe(true);
  });

  test('a box with an observed turn SURVIVES — its deadline is still ahead', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() + 4 * HOUR) })];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
    // The liveness stamp the merged billing clamp depends on is still written.
    expect(livenessStamps).toEqual([{ sandboxId: 'sb-1', at: NOW }]);
  });

  test('the deadline is the WHOLE decision — the box is never consulted', async () => {
    // Identical rows; only the deadline differs. Metadata that used to veto a
    // stop (a live lease, a fresh lastTurnAt) is present on the doomed one and
    // changes nothing.
    candidates = [
      candidate({
        sandboxId: 'sb-live',
        sessionId: 'sess-live',
        externalId: 'ext-live',
        deadlineAt: new Date(NOW.getTime() + 1),
      }),
      candidate({
        sandboxId: 'sb-dead',
        sessionId: 'sess-dead',
        externalId: 'ext-dead',
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          executionLeaseUntil: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
          lastTurnAt: NOW.toISOString(),
          idleObservedAt: null,
        },
      }),
    ];
    statusByExternal['ext-live'] = 'running';
    statusByExternal['ext-dead'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-dead']);
    expect(r.stopped).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('exactly at the deadline is expired (<=, not <)', async () => {
    candidates = [candidate({ deadlineAt: NOW })];
    statusByExternal['ext-1'] = 'running';

    expect((await reapAndReconcileSandboxes(NOW)).stopped).toBe(1);
  });

  // An unclaimed warm box used to be exempt from the idle TTL entirely, so it
  // burned until the 240-min ceiling. It now dies at its 20-minute boot floor
  // like anything else nobody prompted.
  test('an expired WARM box is stopped like any other', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - 60_000) })];
    statusByExternal['ext-1'] = 'running';

    expect((await reapAndReconcileSandboxes(NOW)).stopped).toBe(1);
    expect(stops).toEqual(['ext-1']);
  });

  // ═══ TOCTOU: the snapshot is stale by a whole provider round-trip ═══
  // The pass selects candidates, then spends seconds per row in getStatus, and
  // only then decides — from `row.deadlineAt`, read BEFORE that round-trip. A
  // prompt (or a human clicking the preview, or a gateway LLM call) landing in
  // that window extends the box; stopping it anyway kills live work the control
  // plane had already agreed to keep, and the just-woken box dies on the spot.
  test('REGRESSION: a prompt arriving DURING the pass saves the box', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    // The extend the prompt performed, invisible to the pass's snapshot.
    freshDeadlineBySandbox['sb-1'] = new Date(Date.now() + 4 * HOUR);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]);
    expect(r.stopped).toBe(0);
    expect(r.skipped).toBe(1);
    // Nothing was written: no billing close, no status flip.
    expect(pausedCompute).toEqual([]);
    expect(rowUpdates()).toEqual([]);
  });

  test('a deadline still expired at the last moment is stopped as before', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    freshDeadlineBySandbox['sb-1'] = new Date(Date.now() - 60_000);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-1']);
    expect(r.stopped).toBe(1);
    expect(r.billingClosed).toBe(1);
  });

  test('an unreadable row is never stopped on a guess', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    freshDeadlineBySandbox['sb-1'] = null; // read failed / row gone

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  test('the re-read costs nothing on the healthy path — only rows about to die pay', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() + HOUR) })];
    statusByExternal['ext-1'] = 'running';
    // A value that would REVERSE the decision if it were consulted.
    freshDeadlineBySandbox['sb-1'] = new Date(NOW.getTime() - HOUR);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
  });

  test('the sweep asks the provider FIRST — a stopped box is reconciled, never poked', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('never acts on transient unknown provider state, expired or not', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  test('provider-removed preserves the established external identity', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'removed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(endedCompute).toEqual(['sb-1']);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.status).toBe('stopped');
    expect(sbUpdate?.updates.metadata).toMatchObject({
      runtimeIdentityState: 'unavailable',
      preservedExternalId: 'ext-1',
    });
    expect(stops).toEqual([]);
  });

  test('a failed provider.stop closes NOTHING — no status flip, no billing close', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('provider unavailable');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.errors).toBe(1);
    expect(r.stopped).toBe(0);
    expect(r.billingClosed).toBe(0);
    expect(pausedCompute).toEqual([]);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(false);
  });

  test('already stopped provider-side is success, not an error', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('Sandbox is already stopped');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(r.errors).toBe(0);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('a lifecycle transition in progress defers rather than fighting the wake', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('state change in progress');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(pausedCompute).toEqual([]);
  });
});

// ── orphan-box reaper: stops provider boxes the DB sweep can't see ────────────
describe('reapOrphanProviderBoxes', () => {
  const NOW2 = new Date('2026-06-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW2.getTime() - h * 3_600_000);

  test('stops boxes with no live DB row; keeps live, too-young, and unknown-age boxes', async () => {
    // keepSet (the DB's view of live boxes) comes from the sessionSandboxes query.
    candidates = [{ provider: 'daytona', externalId: 'keep-1' }];
    managedBoxes = [
      { externalId: 'keep-1', createdAt: hoursAgo(48) }, // in keepSet → live
      { externalId: 'orphan-1', createdAt: hoursAgo(48) }, // orphan + old → STOP
      { externalId: 'orphan-2', createdAt: hoursAgo(3) }, // orphan + old → STOP
      { externalId: 'young-1', createdAt: hoursAgo(0.2) }, // orphan but <1h → keep (provision race)
      { externalId: 'nodate', createdAt: null }, // unknown age → keep (fail-safe)
    ];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect([...stops].sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(r.listed).toBe(5);
    expect(r.orphans).toBe(2);
    expect(r.stopped).toBe(2);
    expect(r.errors).toBe(0);
  });

  test('continues past a stop failure (bad box never sinks the sweep)', async () => {
    candidates = [];
    managedBoxes = [
      { externalId: 'orphan-a', createdAt: hoursAgo(10) },
      { externalId: 'orphan-b', createdAt: hoursAgo(10) },
    ];
    stopErrorByExternal['orphan-a'] = new Error('429 too many requests');

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stops).toContain('orphan-a'); // attempted
    expect(stops).toContain('orphan-b'); // and the next one still ran
    expect(r.stopped).toBe(1);
    expect(r.errors).toBe(1);
  });

  test('keeps a provider box referenced by a live App runtime', async () => {
    candidates = [];
    appRuntimeKeepRows = [{ provider: 'daytona', externalId: 'app-live' }];
    managedBoxes = [
      { externalId: 'app-live', createdAt: hoursAgo(48) },
      { externalId: 'real-orphan', createdAt: hoursAgo(48) },
    ];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stops).toEqual(['real-orphan']);
    expect(r).toEqual({ listed: 2, orphans: 1, stopped: 1, errors: 0 });
  });

  test('lists and stops orphan boxes through every configured provider adapter', async () => {
    managedBoxes = [{ externalId: 'daytona-orphan', createdAt: hoursAgo(10) }];
    e2bManagedBoxes = [{ externalId: 'e2b-orphan', createdAt: hoursAgo(10) }];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stopsByProvider).toEqual([
      { provider: 'daytona', externalId: 'daytona-orphan' },
      { provider: 'e2b', externalId: 'e2b-orphan' },
    ]);
    expect(r).toEqual({ listed: 2, orphans: 2, stopped: 2, errors: 0 });
  });

  test('env flag off → no-op (never lists or stops)', async () => {
    const prev = process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED;
    process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED = 'false';
    try {
      managedBoxes = [{ externalId: 'orphan-x', createdAt: hoursAgo(48) }];
      const r = await reapOrphanProviderBoxes(NOW2);
      expect(stops).toEqual([]);
      expect(r).toEqual({ listed: 0, orphans: 0, stopped: 0, errors: 0 });
    } finally {
      if (prev === undefined) delete process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED;
      else process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED = prev;
    }
  });
});

describe('reconcileStuckActiveSessions', () => {
  test('no candidates → no-op', async () => {
    stuckSessions = [];
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(updateCalls.length).toBe(0);
    expect(pausedCompute.length).toBe(0);
  });

  test('stuck session with a dead box → close billing + flip session to stopped', async () => {
    stuckSessions = [{ sessionId: 's1' }];
    // per-session sandbox lookup resolves to the sessionSandboxes mock (candidates)
    candidates = [{ sandboxId: 'sb1' }];
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.billingClosed).toBe(1);
    expect(pausedCompute).toContain('sb1');
    // exactly one project_sessions row flipped to 'stopped'
    const sessionUpdates = updateCalls.filter((u) => u.table === projectSessions);
    expect(sessionUpdates.length).toBe(1);
    expect(sessionUpdates[0].updates.status).toBe('stopped');
  });

  test('stuck session with no sandbox row → still flips to stopped, nothing billed', async () => {
    stuckSessions = [{ sessionId: 's2' }];
    candidates = []; // no sandbox rows for this session
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.billingClosed).toBe(0);
    expect(pausedCompute.length).toBe(0);
    expect(updateCalls.filter((u) => u.table === projectSessions).length).toBe(1);
  });
});

describe('the batch cap rotates and cannot starve a row', () => {
  test('the candidate query orders by the visit stamp, oldest first', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';

    await reapAndReconcileSandboxes(NOW);

    expect(orderByExpressions.some((e) => e.includes('reaperVisitedAt'))).toBe(true);
    expect(orderByExpressions.some((e) => e.includes('nulls first'))).toBe(true);
    // Expired rows must win the batch, or a backlog of healthy rows could defer
    // the one row that is actually over its deadline, forever.
    expect(orderByExpressions.some((e) => e.includes('deadline_at') && e.includes('desc'))).toBe(true);
  });

  test('every examined row is stamped, including ones the pass deliberately left alone', async () => {
    candidates = [
      candidate({ sandboxId: 'sb-a', sessionId: 'sess-a', externalId: 'ext-a' }),
      candidate({ sandboxId: 'sb-b', sessionId: 'sess-b', externalId: 'ext-b' }),
    ];
    statusByExternal['ext-a'] = 'running';
    statusByExternal['ext-b'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(2);
    // A row the pass leaves alone wrote nothing at all pre-fix, so it re-won
    // the batch every pass. Exactly one batched stamp now covers everything
    // examined.
    expect(visitStamps().length).toBe(1);
  });

  test('a backlog larger than the batch is reported, not silently dropped', async () => {
    const prev = process.env.KORTIX_REAP_BATCH_SIZE;
    process.env.KORTIX_REAP_BATCH_SIZE = '2';
    try {
      candidates = [
        candidate({ sandboxId: 'sb-a', sessionId: 'sess-a', externalId: 'ext-a' }),
        candidate({ sandboxId: 'sb-b', sessionId: 'sess-b', externalId: 'ext-b' }),
        candidate({ sandboxId: 'sb-c', sessionId: 'sess-c', externalId: 'ext-c' }),
      ];

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.candidates).toBe(2);
      expect(r.matching).toBe(3);
      expect(r.deferred).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_REAP_BATCH_SIZE;
      else process.env.KORTIX_REAP_BATCH_SIZE = prev;
    }
  });

  // The starvation regression itself: three rows, a batch of two, and rows the
  // pass leaves alone. Pre-fix (no ORDER BY, no visit stamp) the same two rows
  // win every pass and the third is unreachable FOREVER while the billing tick
  // keeps charging it. Two passes must now cover all three.
  test('REGRESSION: two passes over a batch of two cover all three rows', async () => {
    const prev = process.env.KORTIX_REAP_BATCH_SIZE;
    process.env.KORTIX_REAP_BATCH_SIZE = '2';
    try {
      const held = (id: string) => ({
        sandboxId: `sb-${id}`,
        sessionId: `sess-${id}`,
        externalId: `ext-${id}`,
      });
      candidates = [candidate(held('a')), candidate(held('b')), candidate(held('c'))];
      for (const id of ['a', 'b', 'c']) statusByExternal[`ext-${id}`] = 'running';

      const examined: string[][] = [];
      for (let pass = 0; pass < 2; pass++) {
        const seen: string[] = [];
        // Capture which rows this pass selected, then apply the stamp the reaper
        // writes so the next pass's ORDER BY sees the rotation.
        const before = candidates.map((c) => c.metadata?.reaperVisitedAt ?? null);
        void before;
        const beforeStamps = visitStamps().length;
        await reapAndReconcileSandboxes(new Date(NOW.getTime() + pass * 60_000));
        expect(visitStamps().length).toBe(beforeStamps + 1);
        const ordered = applyOrder(candidates).slice(0, 2);
        for (const row of ordered) {
          seen.push(row.sandboxId);
          row.metadata = {
            ...row.metadata,
            reaperVisitedAt: new Date(NOW.getTime() + pass * 60_000).toISOString(),
          };
        }
        examined.push(seen);
      }

      expect(new Set([...examined[0], ...examined[1]]).size).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_REAP_BATCH_SIZE;
      else process.env.KORTIX_REAP_BATCH_SIZE = prev;
    }
  });
});

// ── the billing invariant: no open row without a provably-alive sandbox ──────

describe('hasFailedRuntimeStart', () => {
  test('a failure stamped at or after the wake it belongs to', () => {
    expect(
      hasFailedRuntimeStart({
        runtimeWakeStartedAt: '2026-07-29T01:09:29.142Z',
        runtimeWakeFailedAt: '2026-07-29T01:09:29.276Z',
      }),
    ).toBe(true);
  });
  test('a stale failure from a wake that has since been retried', () => {
    expect(
      hasFailedRuntimeStart({
        runtimeWakeStartedAt: '2026-07-29T02:00:00.000Z',
        runtimeWakeFailedAt: '2026-07-29T01:09:29.276Z',
      }),
    ).toBe(false);
  });
  test('no failure stamp / no metadata / garbage', () => {
    expect(hasFailedRuntimeStart(null)).toBe(false);
    expect(hasFailedRuntimeStart({})).toBe(false);
    expect(hasFailedRuntimeStart({ runtimeWakeFailedAt: 'nope' })).toBe(false);
  });
});

describe('decideComputeClose', () => {
  const base = {
    sandboxStatus: 'active' as string | null,
    hasProviderTarget: true,
    runtimeStartFailed: false,
    beyondLivenessCeiling: false,
    providerStatus: 'running' as any,
    unresolvedForMs: null as number | null,
    openForMs: HOUR,
    unresolvedCeilingMs: HOUR,
    maxWindowMs: 24 * HOUR,
  };

  test('a provably alive box keeps billing', () => {
    expect(decideComputeClose(base).reason).toBeNull();
  });

  // The 17 leaking prod rows. DB-only, so it must not need a provider call.
  test('REGRESSION: sandbox row already stopped → close, with zero provider calls', () => {
    const d = decideComputeClose({ ...base, sandboxStatus: 'stopped' });
    expect(d.reason).toBe('sandbox-not-active');
    expect(d.needsProviderStatus).toBe(false);
  });
  test('sandbox row in error → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'error' }).reason).toBe('sandbox-not-active');
  });
  test('sandbox row archived → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'archived' }).reason).toBe('sandbox-not-active');
  });
  test('a provisioning box is NOT closed — the meter legitimately opens first', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'provisioning' }).reason).toBeNull();
  });
  test('no sandbox row at all → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: null }).reason).toBe('sandbox-row-missing');
  });
  test('no provider target → close', () => {
    expect(decideComputeClose({ ...base, hasProviderTarget: false }).reason).toBe('sandbox-row-missing');
  });
  test('a wake that failed → close, without a provider call', () => {
    const d = decideComputeClose({ ...base, runtimeStartFailed: true });
    expect(d.reason).toBe('runtime-start-failed');
    expect(d.needsProviderStatus).toBe(false);
  });

  test('a row past its liveness ceiling can never bill again → close', () => {
    const d = decideComputeClose({ ...base, beyondLivenessCeiling: true });
    expect(d.reason).toBe('beyond-liveness-ceiling');
    expect(d.needsProviderStatus).toBe(false);
  });

  test('provider says stopped / removed / terminal → close', () => {
    expect(decideComputeClose({ ...base, providerStatus: 'stopped' }).reason).toBe('provider-not-running');
    expect(decideComputeClose({ ...base, providerStatus: 'removed' }).reason).toBe('provider-not-running');
    expect(decideComputeClose({ ...base, providerStatus: 'terminal' }).reason).toBe('provider-not-running');
  });

  // 44 of 66 open prod rows answered `unknown`: it is the steady state for a
  // box deleted out from under us, not a transient.
  test('REGRESSION: unknown is transient on first sight — do not close yet', () => {
    expect(
      decideComputeClose({ ...base, providerStatus: 'unknown', unresolvedForMs: null }).reason,
    ).toBeNull();
  });
  test('REGRESSION: unknown past the ceiling stops billing — uncertainty never justifies charging', () => {
    expect(
      decideComputeClose({ ...base, providerStatus: 'unknown', unresolvedForMs: HOUR }).reason,
    ).toBe('unresolvable-past-ceiling');
  });
  test('unknown but only briefly → keep billing', () => {
    expect(
      decideComputeClose({ ...base, providerStatus: 'unknown', unresolvedForMs: HOUR - 1 }).reason,
    ).toBeNull();
  });
  test('an unresolvable lookup (provider threw, status null) is treated like unknown', () => {
    expect(
      decideComputeClose({ ...base, providerStatus: null, unresolvedForMs: HOUR }).reason,
    ).toBe('unresolvable-past-ceiling');
  });

  // The rule that makes an 829-hour row impossible.
  test('REGRESSION: no window may exceed the max, even while the provider says running', () => {
    const d = decideComputeClose({ ...base, openForMs: 24 * HOUR, providerStatus: 'running' });
    expect(d.reason).toBe('window-past-max');
    expect(d.needsProviderStatus).toBe(false);
  });
  test('just under the max window keeps billing', () => {
    expect(decideComputeClose({ ...base, openForMs: 24 * HOUR - 1 }).reason).toBeNull();
  });
});

describe('computeCloseWindowEnd', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const startedAt = new Date(now.getTime() - 100 * HOUR);
  const base = {
    now,
    startedAt,
    sandboxUpdatedAt: null as Date | null,
    unresolvedSince: null as Date | null,
    runtimeWakeFailedAt: null as Date | null,
    // A liveness ceiling far in the future isolates the per-reason behaviour;
    // the clamp itself is asserted separately below.
    lastAliveAt: now,
    livenessGraceMs: 1000 * HOUR,
    maxWindowMs: 24 * HOUR,
  };

  test('a stopped sandbox bills through the moment we recorded the stop', () => {
    const stoppedAt = new Date(now.getTime() - 90 * HOUR);
    expect(
      computeCloseWindowEnd({ ...base, reason: 'sandbox-not-active', sandboxUpdatedAt: stoppedAt }).getTime(),
    ).toBe(stoppedAt.getTime());
  });
  test('a failed wake bills through the failure, not through today', () => {
    const failedAt = new Date(now.getTime() - 95 * HOUR);
    expect(
      computeCloseWindowEnd({ ...base, reason: 'runtime-start-failed', runtimeWakeFailedAt: failedAt }).getTime(),
    ).toBe(failedAt.getTime());
  });
  test('an unresolvable box bills through the last moment it was resolvable', () => {
    const lastSeen = new Date(now.getTime() - 50 * HOUR);
    expect(
      computeCloseWindowEnd({ ...base, reason: 'unresolvable-past-ceiling', unresolvedSince: lastSeen }).getTime(),
    ).toBe(lastSeen.getTime());
  });
  test('a max-length window bills exactly the max, never the 100h it actually ran', () => {
    expect(computeCloseWindowEnd({ ...base, reason: 'window-past-max' }).getTime()).toBe(
      startedAt.getTime() + 24 * HOUR,
    );
  });
  test('never bills before the window opened', () => {
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
        sandboxUpdatedAt: new Date(startedAt.getTime() - HOUR),
      }).getTime(),
    ).toBe(startedAt.getTime());
  });
  test('never bills into the future', () => {
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
        sandboxUpdatedAt: new Date(now.getTime() + HOUR),
      }).getTime(),
    ).toBe(now.getTime());
  });
  test('a missing evidence timestamp degrades to now rather than throwing', () => {
    expect(computeCloseWindowEnd({ ...base, reason: 'sandbox-not-active' }).getTime()).toBe(now.getTime());
  });

  // Get the reason wrong and the bill is still capped — that is what makes the
  // reason an optimisation rather than a correctness requirement.
  test('REGRESSION: the liveness ceiling overrides whatever the reason argues for', () => {
    const lastAliveAt = new Date(now.getTime() - 90 * HOUR);
    const end = computeCloseWindowEnd({
      ...base,
      reason: 'sandbox-row-missing', // this reason alone would bill through `now`
      lastAliveAt,
      livenessGraceMs: HOUR,
    });
    expect(end.getTime()).toBe(lastAliveAt.getTime() + HOUR);
  });
});

describe('reconcileOrphanComputeSessions', () => {
  const NOW3 = new Date('2026-07-29T12:00:00Z');
  // `lastAliveAt` defaults to "just observed" so each test isolates the rule it
  // is about; the liveness ceiling itself is asserted in its own tests below and
  // in billing/services/compute-liveness.test.ts.
  const openRow = (over: Partial<any> = {}) => ({
    computeId: 'cs-1',
    sandboxId: 'sb-1',
    startedAt: new Date(NOW3.getTime() - 2 * HOUR).toISOString(),
    computeMetadata: { lastAliveAt: NOW3.toISOString() },
    sbStatus: 'active',
    sbUpdatedAt: new Date(NOW3.getTime() - HOUR).toISOString(),
    sbMetadata: {},
    provider: 'daytona',
    externalId: 'ext-1',
    ...over,
  });

  test('a healthy running box keeps billing', async () => {
    computeRows = [openRow()];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(pausedCompute).toEqual([]);
  });

  // The 17 prod rows: 5,587 sandbox-hours billed on boxes our own DB said were
  // stopped. Pre-fix this row is untouched because the provider answers
  // 'unknown' and only 'stopped'/'removed' closed anything.
  test('REGRESSION: an open row whose sandbox is already stopped is closed', async () => {
    const stoppedAt = new Date(NOW3.getTime() - 34 * 24 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 35 * 24 * HOUR).toISOString(),
        computeMetadata: { lastAliveAt: stoppedAt.toISOString() },
        sbStatus: 'stopped',
        sbUpdatedAt: stoppedAt.toISOString(),
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-not-active']).toBe(1);
    // Billed through the stop we recorded 34 days ago, not through today.
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(stoppedAt.getTime());
  });

  // The liveness rule alone closes a dead row even when every other signal is
  // ambiguous — the sandbox row still says `active` and the provider says
  // `unknown`, which is exactly the 44-of-66 prod shape.
  test('REGRESSION: a row nobody has observed alive past the grace stops billing', async () => {
    const lastSeen = new Date(NOW3.getTime() - 800 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 829 * HOUR).toISOString(),
        computeMetadata: { lastAliveAt: lastSeen.toISOString() },
        sbStatus: 'active',
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['beyond-liveness-ceiling']).toBe(1);
    // One hour of grace past the last sighting. Not 800.
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(lastSeen.getTime() + HOUR);
    expect(statusCalls).toEqual([]);
  });

  // 44 of 66 open prod rows answered `unknown`, so the leak has to be closable
  // without ever asking the provider — otherwise a provider outage re-opens it.
  test('REGRESSION: closing a stopped-sandbox row costs ZERO provider round-trips', async () => {
    computeRows = [openRow({ sbStatus: 'stopped' })];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.byReason['sandbox-not-active']).toBe(1);
    expect(statusCalls).toEqual([]);
  });

  test('an open row with no sandbox row behind it is closed', async () => {
    computeRows = [openRow({ sbStatus: null, provider: null, externalId: null })];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-row-missing']).toBe(1);
  });

  // The box that failed to start but kept its meter open.
  test('REGRESSION: a box whose wake failed stops billing at the failure', async () => {
    const failedAt = new Date(NOW3.getTime() - 90 * 60_000);
    computeRows = [
      openRow({
        sbMetadata: {
          runtimeWakeStartedAt: new Date(failedAt.getTime() - 200).toISOString(),
          runtimeWakeFailedAt: failedAt.toISOString(),
          runtimeWakeError: 'start_failed',
        },
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['runtime-start-failed']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(failedAt.getTime());
  });

  test('REGRESSION: an unresolvable box is armed on first sight, not closed', async () => {
    computeRows = [openRow()];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    // The unresolvedSince stamp is what makes the NEXT pass able to act.
    const stamp = updateCalls.find((c) => c.table === sandboxComputeSessions);
    expect((stamp?.updates.metadata as any)?.unresolvedSince).toBe(NOW3.toISOString());
  });

  test('REGRESSION: an unresolvable box past the ceiling stops billing', async () => {
    const lastSeen = new Date(NOW3.getTime() - 3 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 20 * HOUR).toISOString(),
        computeMetadata: { lastAliveAt: NOW3.toISOString(), unresolvedSince: lastSeen.toISOString() },
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['unresolvable-past-ceiling']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(lastSeen.getTime());
  });

  test('a box that becomes resolvable again clears the unresolved clock', async () => {
    computeRows = [
      openRow({ computeMetadata: { lastAliveAt: NOW3.toISOString(), unresolvedSince: new Date(NOW3.getTime() - 3 * HOUR).toISOString() } }),
    ];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    const stamp = updateCalls.find((c) => c.table === sandboxComputeSessions);
    expect((stamp?.updates.metadata as any)?.unresolvedSince).toBeNull();
  });

  // 829 hours, $111.67, one row, still ticking. Never again.
  test('REGRESSION: an 829-hour window is closed at the max even if the provider says running', async () => {
    const startedAt = new Date(NOW3.getTime() - 829 * HOUR);
    computeRows = [openRow({ startedAt: startedAt.toISOString() })];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['window-past-max']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(startedAt.getTime() + 24 * HOUR);
  });

  test('oldest-open rows are drained first so a saturated batch cannot starve them', async () => {
    computeRows = [
      openRow({ computeId: 'cs-new', sandboxId: 'sb-new', startedAt: new Date(NOW3.getTime() - HOUR).toISOString(), sbStatus: 'stopped' }),
      openRow({ computeId: 'cs-old', sandboxId: 'sb-old', startedAt: new Date(NOW3.getTime() - 800 * HOUR).toISOString(), sbStatus: 'stopped' }),
    ];

    await reconcileOrphanComputeSessions(NOW3);

    expect(pausedCompute[0]).toBe('sb-old');
    expect(orderByExpressions.some((e) => e.includes('started_at') || e.includes('startedAt'))).toBe(true);
  });

  test('one bad row never sinks the sweep', async () => {
    computeRows = [
      openRow({ computeId: 'cs-a', sandboxId: 'sb-a', startedAt: 'not-a-date', sbStatus: 'stopped' }),
      openRow({ computeId: 'cs-b', sandboxId: 'sb-b', sbStatus: 'stopped' }),
    ];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(2);
    expect(r.errors).toBe(0);
  });
});
