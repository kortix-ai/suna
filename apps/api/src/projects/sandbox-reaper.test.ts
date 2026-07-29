import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accounts,
  projectSessions,
  sandboxComputeSessions,
  sessionSandboxes,
  usageEvents,
} from '@kortix/db';

// ── mock state ──────────────────────────────────────────────────────────────
let candidates: any[] = [];
let usageRows: Array<{ sessionId: string; last: string }> = [];
let accountRows: Array<{ accountId: string }> = [];
let throwOnAccountLookup = false;
let throwOnUsageLookup = false;
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

/** Mirrors the ORDER BY the reaper asks Postgres for, so a pass over more rows
 *  than the batch actually rotates instead of re-selecting the same head. Both
 *  keys are ISO-8601 UTC strings, where lexicographic order IS chronological
 *  order, and a missing key sorts first (SQL `nulls first`). */
function applyOrder(rows: any[]): any[] {
  const key = (r: any) =>
    'startedAt' in r ? String(r.startedAt ?? '') : String(r.metadata?.reaperVisitedAt ?? '');
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
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

/** A thenable that also exposes the chainable clause methods, so `await where()`
 *  and `where().orderBy().limit()` resolve to the same rows. */
function hybrid(rows: any[], throwOnGroupBy = false): any {
  const p: any = Promise.resolve(rows);
  p.limit = (n?: number) =>
    hybrid(typeof n === 'number' ? rows.slice(0, n) : rows, throwOnGroupBy);
  p.orderBy = (expression?: unknown) => {
    orderByExpressions.push(describeSql(expression));
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

let busyByExternal: Record<string, 'busy' | 'idle' | 'unknown'> = {};
mock.module('./sandbox-busy-probe', () => ({
  probeSandboxBusy: async ({ externalId }: { externalId: string }) => busyByExternal[externalId] ?? 'unknown',
}));

mock.module('../shared/db', () => ({
  db: {
    transaction: async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const isCount = !!projection && 'total' in projection;
        const builder: any = {
          innerJoin: () => builder,
          leftJoin: () => builder,
          where: () => {
            if (table === accounts && throwOnAccountLookup) return Promise.reject(new Error('db down'));
            if (isCount) return hybrid([{ total: candidates.length }]);
            return hybrid(
              table === sessionSandboxes
                ? candidates
                : table === sandboxComputeSessions
                  ? computeRows
                  : table === usageEvents
                    ? usageRows
                    : table === projectSessions
                      ? stuckSessions
                      : table === accounts
                        ? accountRows
                        : [],
              table === usageEvents && throwOnUsageLookup,
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

mock.module('../platform/providers', () => ({
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

mock.module('../billing/services/compute-metering', () => ({
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
  decideIdleConfirm,
  decideHardStop,
  decideComputeClose,
  computeCloseWindowEnd,
  hasFailedRuntimeStart,
  provenActivityAt,
  idleObservedAtOf,
  lastMeaningfulAt,
  reapAndReconcileSandboxes,
  reconcileOrphanComputeSessions,
  buildIdleStopMetadata,
  reapOrphanProviderBoxes,
  reconcileStuckActiveSessions,
  isTriggerSession,
  triggerAutoStopTtlMs,
  hardStopCeilingMs,
  REAP_BATCH_SIZE,
} = await import('./sandbox-reaper');

const TTL = 15 * 60_000;

beforeEach(() => {
  candidates = [];
  usageRows = [];
  // Default candidate() below is accountId 'acct-1' — keep it a LIVE account by
  // default so every pre-existing test (lease veto, busy veto, etc.) keeps its
  // original behavior; orphan-account tests override this explicitly.
  accountRows = [{ accountId: 'acct-1' }];
  throwOnAccountLookup = false;
  throwOnUsageLookup = false;
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
  busyByExternal = {};
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

describe('decideIdleConfirm', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  test('no prior observation → arm the countdown', () => {
    expect(decideIdleConfirm({ idleObservedAt: null, now, ttlMs: TTL })).toBe('arm');
  });
  test('observed idle but countdown not elapsed → wait', () => {
    expect(decideIdleConfirm({ idleObservedAt: new Date(now.getTime() - TTL + 1), now, ttlMs: TTL })).toBe('wait');
  });
  test('observed idle for the full TTL → stop', () => {
    expect(decideIdleConfirm({ idleObservedAt: new Date(now.getTime() - TTL), now, ttlMs: TTL })).toBe('stop');
  });
  test('future stamp (clock skew) → re-arm', () => {
    expect(decideIdleConfirm({ idleObservedAt: new Date(now.getTime() + 60_000), now, ttlMs: TTL })).toBe('arm');
  });
});

describe('idleObservedAtOf', () => {
  test('reads a valid stamp', () => {
    expect(idleObservedAtOf({ idleObservedAt: '2026-07-07T11:00:00.000Z' })?.toISOString()).toBe('2026-07-07T11:00:00.000Z');
  });
  test('null / missing / cleared / garbage → null', () => {
    expect(idleObservedAtOf(null)).toBeNull();
    expect(idleObservedAtOf({})).toBeNull();
    expect(idleObservedAtOf({ idleObservedAt: null })).toBeNull();
    expect(idleObservedAtOf({ idleObservedAt: 'not-a-date' })).toBeNull();
  });
});

describe('lastMeaningfulAt', () => {
  test('uses stamped lastTurnAt when present and newer than creation', () => {
    const created = new Date('2026-06-01T00:00:00Z');
    const turn = new Date('2026-06-01T05:00:00Z');
    expect(lastMeaningfulAt({ metadata: { lastTurnAt: turn.toISOString() }, createdAt: created }).getTime()).toBe(turn.getTime());
  });
  test('falls back to creation when no stamp', () => {
    const created = new Date('2026-06-01T00:00:00Z');
    expect(lastMeaningfulAt({ metadata: null, createdAt: created }).getTime()).toBe(created.getTime());
  });
  test('ignores a stamp older than creation (clock skew / stale)', () => {
    const created = new Date('2026-06-01T10:00:00Z');
    expect(lastMeaningfulAt({ metadata: { lastTurnAt: '2026-06-01T00:00:00Z' }, createdAt: created }).getTime()).toBe(created.getTime());
  });
});

describe('isTriggerSession', () => {
  test('trigger:* sources are unattended', () => {
    expect(isTriggerSession({ source: 'trigger:webhook' })).toBe(true);
    expect(isTriggerSession({ source: 'trigger:cron' })).toBe(true);
    expect(isTriggerSession({ source: 'trigger:manual' })).toBe(true);
  });
  test('interactive and unknown sources are not', () => {
    expect(isTriggerSession({ source: 'ui' })).toBe(false);
    expect(isTriggerSession({ source: 'slack' })).toBe(false);
    expect(isTriggerSession({})).toBe(false);
    expect(isTriggerSession(null)).toBe(false);
    expect(isTriggerSession({ source: 42 })).toBe(false);
  });
});

describe('triggerAutoStopTtlMs', () => {
  test('reads the trigger-specific knob', () => {
    expect(triggerAutoStopTtlMs()).toBe(5 * 60_000);
  });
});

describe('buildIdleStopMetadata', () => {
  const nowIso = '2026-06-21T12:00:00.000Z';
  test('idle stop quiesces so passive traffic cannot resurrect', () => {
    const m = buildIdleStopMetadata({ quiesce: true, nowIso });
    expect(m.idleQuiesced).toBe(true);
    expect(m.idleQuiescedAt).toBe(nowIso);
    expect(m.needsReprovision).toBeUndefined();
  });
  test('no flags → empty patch (nothing merged)', () => {
    expect(buildIdleStopMetadata({ quiesce: false, nowIso })).toEqual({});
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
    warmState: null,
    createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2h ago → idle
    ...over,
  };
}

describe('reapAndReconcileSandboxes', () => {
  test('keeps an available warm session running before its first prompt', async () => {
    candidates = [candidate({ warmState: 'available' })];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    expect(rowUpdates()).toEqual([]);
  });

  test('stops an idle, running Daytona box and closes billing + quiesces', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual(['ext-1']);
    expect(pausedCompute).toEqual(['sb-1']);
    expect(cacheInvalidations).toEqual(['ext-1']);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.status).toBe('stopped');
    expect(sbUpdate?.updates.metadata).toBeDefined(); // quiesce flag merged
    expect(updateCalls.some((c) => c.table === projectSessions && c.updates.status === 'stopped')).toBe(true);
  });

  test('trigger box idles out on the short TTL while an interactive twin survives', async () => {
    const sixMinAgo = new Date(NOW.getTime() - 6 * 60_000);
    candidates = [
      candidate({ sandboxId: 'sb-t', sessionId: 'sess-t', externalId: 'ext-t', metadata: { source: 'trigger:webhook' }, createdAt: sixMinAgo }),
      candidate({ sandboxId: 'sb-u', sessionId: 'sess-u', externalId: 'ext-u', metadata: { source: 'ui' }, createdAt: sixMinAgo }),
    ];
    statusByExternal['ext-t'] = 'running';
    statusByExternal['ext-u'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-t']);
    expect(r.stopped).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('busy probe vetoes the stop and resets the idle clock', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'busy';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.busyVetoed).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.metadata).toBeDefined();
    expect(sbUpdate?.updates.status).toBeUndefined();
  });

  test('active execution lease vetoes stop before the busy probe', async () => {
    candidates = [candidate({ metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString(), idleObservedAt: new Date(NOW.getTime() - TTL).toISOString() } })];
    statusByExternal['ext-1'] = 'running'; busyByExternal['ext-1'] = 'idle';
    const r = await reapAndReconcileSandboxes(NOW);
    expect(r.busyVetoed).toBe(1); expect(r.stopped).toBe(0); expect(stops).toEqual([]); expect(rowUpdates()).toEqual([]);
  });

  test('first idle observation arms the countdown instead of stopping', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.idleArmed).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.metadata).toBeDefined();
    expect(sbUpdate?.updates.status).toBeUndefined();
  });

  test('observed idle for less than the TTL → wait, no writes', async () => {
    candidates = [candidate({ metadata: { idleObservedAt: new Date(NOW.getTime() - TTL + 60_000).toISOString() } })];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(rowUpdates()).toEqual([]);
  });

  test('observed idle for the full TTL → shut down', async () => {
    candidates = [candidate({ metadata: { idleObservedAt: new Date(NOW.getTime() - TTL).toISOString() } })];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(stops).toEqual(['ext-1']);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('trigger boxes confirm idle on the shorter TTL', async () => {
    const sixMinAgo = new Date(NOW.getTime() - 6 * 60_000).toISOString();
    candidates = [
      candidate({ sandboxId: 'sb-t', sessionId: 'sess-t', externalId: 'ext-t', metadata: { source: 'trigger:webhook', idleObservedAt: sixMinAgo } }),
      candidate({ sandboxId: 'sb-u', sessionId: 'sess-u', externalId: 'ext-u', metadata: { source: 'ui', idleObservedAt: sixMinAgo } }),
    ];
    statusByExternal['ext-t'] = 'running';
    statusByExternal['ext-u'] = 'running';
    busyByExternal['ext-t'] = 'idle';
    busyByExternal['ext-u'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-t']);
    expect(r.stopped).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('Platinum idle stop preserves the same runtime for in-place resume', async () => {
    candidates = [candidate({ provider: 'platinum', externalId: 'ext-p', sandboxId: 'sb-p' })];
    statusByExternal['ext-p'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(stops).toEqual(['ext-p']);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.metadata).toBeDefined();
  });

  test('reconciles a box the provider already stopped — no stop call', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual([]); // never poke a stopped box
    expect(pausedCompute).toEqual(['sb-1']);
    expect(updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped')).toBe(true);
  });

  test('leaves a recently-active box running', async () => {
    candidates = [candidate({ metadata: { lastTurnAt: new Date(NOW.getTime() - 60_000).toISOString() } })];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  test('a recent LLM call keeps an otherwise old box alive', async () => {
    candidates = [candidate()]; // created 2h ago
    statusByExternal['ext-1'] = 'running';
    usageRows = [{ sessionId: 'sess-1', last: new Date(NOW.getTime() - 60_000).toISOString() }];

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
  });

  test('does not act on transient unknown provider state', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  test('does not mark stopped or close billing when provider stop fails', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('provider unavailable');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.errors).toBe(1);
    expect(r.stopped).toBe(0);
    expect(r.billingClosed).toBe(0);
    expect(stops).toEqual(['ext-1']);
    expect(pausedCompute).toEqual([]);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(false);
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
    expect(stops).toEqual([]); // never poke a removed box
  });

  test('FAIL-SAFE: unreachable box + failed usage lookup → never stop', async () => {
    candidates = [candidate()]; // idle by timestamp (created 2h ago), probe defaults to unknown
    statusByExternal['ext-1'] = 'running';
    throwOnUsageLookup = true; // simulate a DB/transient failure

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]); // uncertain → do not stop
    expect(pausedCompute).toEqual([]);
    expect(r.stopped).toBe(0);
  });

  test('probe-confirmed idle still counts down even when the usage lookup fails', async () => {
    candidates = [candidate({ metadata: { idleObservedAt: new Date(NOW.getTime() - TTL).toISOString() } })];
    statusByExternal['ext-1'] = 'running';
    busyByExternal['ext-1'] = 'idle';
    throwOnUsageLookup = true;

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(stops).toEqual(['ext-1']);
  });

  // ── orphan-account bypass: deleted account → both protections lifted ───────
  describe('orphan-account bypass', () => {
    test('orphan account + live execution lease IS reaped', async () => {
      accountRows = []; // acct-1 no longer exists
      candidates = [candidate({ metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() } })];
      statusByExternal['ext-1'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.stopped).toBe(1);
      expect(r.busyVetoed).toBe(0);
      expect(stops).toEqual(['ext-1']);
      expect(pausedCompute).toEqual(['sb-1']);
    });

    test('orphan account reporting busy IS reaped', async () => {
      accountRows = []; // acct-1 no longer exists
      candidates = [candidate()];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'busy';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.stopped).toBe(1);
      expect(r.busyVetoed).toBe(0);
      expect(stops).toEqual(['ext-1']);
    });

    test('REGRESSION GUARD: non-orphan account with a live execution lease is NOT reaped', async () => {
      // accountRows keeps the default 'acct-1' — a live account.
      candidates = [candidate({ metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() } })];
      statusByExternal['ext-1'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.busyVetoed).toBe(1);
      expect(r.stopped).toBe(0);
      expect(stops).toEqual([]);
    });

    test('REGRESSION GUARD: non-orphan account reporting busy is NOT reaped', async () => {
      candidates = [candidate()];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'busy';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.busyVetoed).toBe(1);
      expect(r.stopped).toBe(0);
      expect(stops).toEqual([]);
    });

    test('account lookup failure fails safe — no bypass, normal protections apply', async () => {
      throwOnAccountLookup = true;
      candidates = [candidate({ metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() } })];
      statusByExternal['ext-1'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.busyVetoed).toBe(1);
      expect(r.stopped).toBe(0);
      expect(stops).toEqual([]);
    });

    test('env flag off → orphan account still protected by lease/busy checks', async () => {
      const prev = process.env.KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED;
      process.env.KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED = 'false';
      try {
        accountRows = []; // acct-1 no longer exists
        candidates = [candidate()];
        statusByExternal['ext-1'] = 'running';
        busyByExternal['ext-1'] = 'busy';

        const r = await reapAndReconcileSandboxes(NOW);

        expect(r.busyVetoed).toBe(1);
        expect(r.stopped).toBe(0);
        expect(stops).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED;
        else process.env.KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED = prev;
      }
    });
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

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION LOCKS — "a box must NEVER run 24/7 when it is not in use"
//
// Incident 2026-07-29 (prod). Measured on live data:
//   - 188 of 279 active boxes held an execution lease their OWN daemon renews
//     every 60s, so the reaper's lease veto returned before the busy probe and
//     `metadata.idleObservedAt` was a JSON null on 100% of rows platform-wide:
//     the idle-TTL stop path had never once fired in production.
//   - the candidate query had no ORDER BY under a LIMIT 100, so ~179 of those
//     279 rows were structurally unreachable by the reaper forever while the
//     billing tick kept settling their full wall-clock delta.
//   - 17 open, still-accruing compute rows belonged to sandboxes our own DB
//     already marked stopped/error — worst two at 829h (34.5 days) each.
// ═══════════════════════════════════════════════════════════════════════════

const HOUR = 3_600_000;
const CEILING = 4 * HOUR;

describe('provenActivityAt', () => {
  const created = new Date('2026-06-21T00:00:00Z');
  test('a real LLM call newer than creation wins', () => {
    const usage = new Date('2026-06-21T05:00:00Z');
    expect(provenActivityAt({ createdAt: created }, usage).getTime()).toBe(usage.getTime());
  });
  test('falls back to creation with no usage', () => {
    expect(provenActivityAt({ createdAt: created }, null).getTime()).toBe(created.getTime());
  });
  test('ignores usage older than creation', () => {
    expect(
      provenActivityAt({ createdAt: created }, new Date('2026-06-20T00:00:00Z')).getTime(),
    ).toBe(created.getTime());
  });
  test('ignores an unparseable usage timestamp', () => {
    expect(provenActivityAt({ createdAt: created }, new Date('nope')).getTime()).toBe(
      created.getTime(),
    );
  });
});

describe('decideHardStop', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  test('no proven activity for the full ceiling → stop', () => {
    expect(
      decideHardStop({ provenActivityAt: new Date(now.getTime() - CEILING), now, ceilingMs: CEILING }),
    ).toBe(true);
  });
  test('one millisecond short of the ceiling → do not stop', () => {
    expect(
      decideHardStop({
        provenActivityAt: new Date(now.getTime() - CEILING + 1),
        now,
        ceilingMs: CEILING,
      }),
    ).toBe(false);
  });
  test('FAIL SAFE: unknown proven activity (usage lookup failed) never stops', () => {
    expect(decideHardStop({ provenActivityAt: null, now, ceilingMs: CEILING })).toBe(false);
  });
  test('FAIL SAFE: a future stamp (clock skew) never stops', () => {
    expect(
      decideHardStop({ provenActivityAt: new Date(now.getTime() + HOUR), now, ceilingMs: CEILING }),
    ).toBe(false);
  });
  test('kill switch off → never stops', () => {
    expect(
      decideHardStop({
        provenActivityAt: new Date(now.getTime() - 100 * HOUR),
        now,
        ceilingMs: CEILING,
        enabled: false,
      }),
    ).toBe(false);
  });
});

describe('hardStopCeilingMs', () => {
  test('never sits below the ordinary idle TTL', () => {
    const prev = process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES;
    process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES = '1';
    try {
      expect(hardStopCeilingMs()).toBe(TTL);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES;
      else process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES = prev;
    }
  });
  test('defaults well under a day so nothing can bill 24/7', () => {
    expect(hardStopCeilingMs()).toBeLessThan(24 * HOUR);
  });
});

describe('the absolute ceiling ends the 24/7 leak', () => {
  const withCeiling = async (fn: () => Promise<void>) => {
    const prev = process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES;
    process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES = String(CEILING / 60_000);
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES;
      else process.env.KORTIX_SANDBOX_HARD_STOP_MINUTES = prev;
    }
  };

  // THE test. On the pre-fix code this box survives every pass forever: the
  // live lease short-circuits before the probe, and even without the lease the
  // 'busy' probe vetoes and re-stamps lastTurnAt. Zero turns, zero LLM calls,
  // billed 24/7. It must now stop.
  test('a wedged box with a live lease AND a busy probe still stops past the ceiling', async () => {
    await withCeiling(async () => {
      candidates = [
        candidate({
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          metadata: {
            // Both of these are written by the sandbox's OWN heartbeat.
            executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
            lastTurnAt: new Date(NOW.getTime() - 30_000).toISOString(),
          },
        }),
      ];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'busy';
      usageRows = []; // no LLM call, ever

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.hardStopped).toBe(1);
      expect(r.stopped).toBe(1);
      expect(r.busyVetoed).toBe(0);
      expect(stops).toEqual(['ext-1']);
      expect(pausedCompute).toEqual(['sb-1']);
    });
  });

  test('the same box UNDER the ceiling is still protected by its lease', async () => {
    await withCeiling(async () => {
      candidates = [
        candidate({
          createdAt: new Date(NOW.getTime() - HOUR),
          metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
        }),
      ];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'busy';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.hardStopped).toBe(0);
      expect(r.busyVetoed).toBe(1);
      expect(stops).toEqual([]);
    });
  });

  test('a real LLM call inside the ceiling keeps a long-lived box alive', async () => {
    await withCeiling(async () => {
      candidates = [candidate({ createdAt: new Date(NOW.getTime() - 30 * HOUR) })];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'busy';
      usageRows = [{ sessionId: 'sess-1', last: new Date(NOW.getTime() - 60_000).toISOString() }];

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.hardStopped).toBe(0);
      expect(r.busyVetoed).toBe(1);
      expect(stops).toEqual([]);
    });
  });

  test('FAIL SAFE: a failed usage lookup never triggers the ceiling', async () => {
    await withCeiling(async () => {
      candidates = [
        candidate({
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
        }),
      ];
      statusByExternal['ext-1'] = 'running';
      throwOnUsageLookup = true;

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.hardStopped).toBe(0);
      expect(stops).toEqual([]);
    });
  });

  test('kill switch off → a wedged box is protected again (ops escape hatch)', async () => {
    const prev = process.env.KORTIX_SANDBOX_HARD_STOP_ENABLED;
    process.env.KORTIX_SANDBOX_HARD_STOP_ENABLED = 'false';
    try {
      await withCeiling(async () => {
        candidates = [
          candidate({
            createdAt: new Date(NOW.getTime() - 30 * HOUR),
            metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
          }),
        ];
        statusByExternal['ext-1'] = 'running';
        busyByExternal['ext-1'] = 'busy';

        const r = await reapAndReconcileSandboxes(NOW);

        expect(r.hardStopped).toBe(0);
        expect(r.busyVetoed).toBe(1);
        expect(stops).toEqual([]);
      });
    } finally {
      if (prev === undefined) delete process.env.KORTIX_SANDBOX_HARD_STOP_ENABLED;
      else process.env.KORTIX_SANDBOX_HARD_STOP_ENABLED = prev;
    }
  });

  test('an unclaimed warm-pool box is exempt from the idle TTL but NOT the ceiling', async () => {
    await withCeiling(async () => {
      candidates = [
        candidate({ warmState: 'available', createdAt: new Date(NOW.getTime() - 30 * HOUR) }),
      ];
      statusByExternal['ext-1'] = 'running';
      busyByExternal['ext-1'] = 'idle';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.hardStopped).toBe(1);
      expect(stops).toEqual(['ext-1']);
      expect(pausedCompute).toEqual(['sb-1']);
    });
  });

  test('a fresh warm-pool box waiting for its first prompt is left alone', async () => {
    await withCeiling(async () => {
      candidates = [candidate({ warmState: 'available', createdAt: new Date(NOW.getTime() - 60_000) })];
      statusByExternal['ext-1'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.warmSkipped).toBe(1);
      expect(r.hardStopped).toBe(0);
      expect(stops).toEqual([]);
    });
  });
});

describe('the batch cap rotates and cannot starve a row', () => {
  test('the candidate query orders by the visit stamp, oldest first', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';

    await reapAndReconcileSandboxes(NOW);

    expect(orderByExpressions.some((e) => e.includes('reaperVisitedAt'))).toBe(true);
    expect(orderByExpressions.some((e) => e.includes('nulls first'))).toBe(true);
  });

  test('every examined row is stamped, including ones the pass deliberately left alone', async () => {
    candidates = [
      candidate({ sandboxId: 'sb-a', sessionId: 'sess-a', externalId: 'ext-a' }),
      candidate({
        sandboxId: 'sb-b',
        sessionId: 'sess-b',
        externalId: 'ext-b',
        metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
      }),
    ];
    statusByExternal['ext-a'] = 'running';
    statusByExternal['ext-b'] = 'running';
    busyByExternal['ext-a'] = 'idle';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.busyVetoed).toBe(1);
    // A vetoed row wrote nothing at all pre-fix, so it re-won the batch every
    // pass. Exactly one batched stamp now covers everything examined.
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
        // A live lease: the pass looks at it and decides to leave it running.
        metadata: { executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
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
