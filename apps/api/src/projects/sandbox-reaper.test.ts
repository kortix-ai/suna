import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes, usageEvents } from '@kortix/db';

// ── mock state ──────────────────────────────────────────────────────────────
let candidates: any[] = [];
let usageRows: Array<{ sessionId: string; last: string }> = [];
let throwOnUsageLookup = false;
let statusByExternal: Record<string, 'running' | 'stopped' | 'removed' | 'unknown'> = {};
let stopErrorByExternal: Record<string, Error> = {};
let stops: string[] = [];
let managedBoxes: Array<{ externalId: string; createdAt: Date | null }> = [];
let cacheInvalidations: string[] = [];
let pausedCompute: string[] = [];
let endedCompute: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let stuckSessions: Array<{ sessionId: string }> = [];

/** A thenable that also exposes `.limit()` so both `await where()` (turn query)
 *  and `where().limit()` (candidate query) resolve to the same rows. */
function hybrid(rows: any[], throwOnGroupBy = false) {
  const p: any = Promise.resolve(rows);
  p.limit = async () => rows;
  p.groupBy = async () => {
    if (throwOnGroupBy) throw new Error('db down');
    return rows;
  };
  return p;
}

// Mock config (the only field used is KORTIX_SANDBOX_AUTOSTOP_MINUTES) so the
// test doesn't import the real config, which calls process.exit on incomplete
// local env. Run this file in its own `bun test <file>` invocation (as CI does)
// so the mock never leaks into a sibling file that uses the real config.
mock.module('../config', () => ({ config: { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15, KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: 5, DAYTONA_API_KEY: 'test-key' } }));

let busyByExternal: Record<string, 'busy' | 'idle' | 'unknown'> = {};
mock.module('./sandbox-busy-probe', () => ({
  probeSandboxBusy: async ({ externalId }: { externalId: string }) => busyByExternal[externalId] ?? 'unknown',
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          hybrid(
            table === sessionSandboxes
              ? candidates
              : table === usageEvents
                ? usageRows
                : table === projectSessions
                  ? stuckSessions
                  : [],
            table === usageEvents && throwOnUsageLookup,
          ),
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        // Awaitable (reconcileRowToStopped) AND chainable to `.returning()`
        // (reconcileStuckActiveSessions). Records exactly one update call either way.
        where: () => {
          const record = () => updateCalls.push({ table, updates });
          return {
            then: (resolve: (v: unknown) => void) => {
              record();
              resolve(undefined);
            },
            returning: async () => {
              record();
              return [{ sessionId: 'updated' }];
            },
          };
        },
      }),
    }),
  },
}));

mock.module('../platform/providers', () => ({
  getProvider: (_name: string) => ({
    getStatus: async (externalId: string) => statusByExternal[externalId] ?? 'unknown',
    stop: async (externalId: string) => {
      stops.push(externalId);
      const err = stopErrorByExternal[externalId];
      if (err) throw err;
    },
    listManagedRunningSandboxes: async () => managedBoxes,
  }),
}));

mock.module('../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

mock.module('../billing/services/compute-metering', () => ({
  pauseComputeSession: async (sandboxId: string) => {
    pausedCompute.push(sandboxId);
  },
  endComputeSession: async (sandboxId: string) => {
    endedCompute.push(sandboxId);
  },
}));

const { decideReconcile, decideIdleConfirm, idleObservedAtOf, lastMeaningfulAt, reapAndReconcileSandboxes, buildIdleStopMetadata, reapOrphanProviderBoxes, reconcileStuckActiveSessions, isTriggerSession, triggerAutoStopTtlMs } = await import('./sandbox-reaper');

const TTL = 15 * 60_000;

beforeEach(() => {
  candidates = [];
  usageRows = [];
  throwOnUsageLookup = false;
  statusByExternal = {};
  stopErrorByExternal = {};
  stops = [];
  managedBoxes = [];
  cacheInvalidations = [];
  pausedCompute = [];
  endedCompute = [];
  updateCalls = [];
  stuckSessions = [];
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
    createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2h ago → idle
    ...over,
  };
}

describe('reapAndReconcileSandboxes', () => {
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
    expect(updateCalls).toEqual([]);
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
});

// ── orphan-box reaper: stops provider boxes the DB sweep can't see ────────────
describe('reapOrphanProviderBoxes', () => {
  const NOW2 = new Date('2026-06-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW2.getTime() - h * 3_600_000);

  test('stops boxes with no live DB row; keeps live, too-young, and unknown-age boxes', async () => {
    // keepSet (the DB's view of live boxes) comes from the sessionSandboxes query.
    candidates = [{ externalId: 'keep-1' }];
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
