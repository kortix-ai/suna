import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes, chatTurnStreams, usageEvents } from '@kortix/db';

// ── mock state ──────────────────────────────────────────────────────────────
let candidates: any[] = [];
let activeTurns: Array<{ sessionId: string }> = [];
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
mock.module('../config', () => ({ config: { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15, DAYTONA_API_KEY: 'test-key' } }));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          hybrid(
            table === sessionSandboxes
              ? candidates
              : table === chatTurnStreams
                ? activeTurns
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

const { decideReap, lastMeaningfulAt, reapAndReconcileSandboxes, buildIdleStopMetadata, reapOrphanProviderBoxes, reconcileStuckActiveSessions } = await import('./sandbox-reaper');

const TTL = 15 * 60_000;

beforeEach(() => {
  candidates = [];
  activeTurns = [];
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
});

// ── pure decision matrix (the money + UX correctness lives here) ─────────────
describe('decideReap', () => {
  test('never acts on unknown provider state', () => {
    expect(decideReap({ providerStatus: 'unknown', meaningfulIdleMs: 10 * TTL, hasActiveTurn: false, ttlMs: TTL, provider: 'daytona' }).action).toBe('none');
  });

  test('removed → reconcile-removed + reprovision', () => {
    const d = decideReap({ providerStatus: 'removed', meaningfulIdleMs: 0, hasActiveTurn: false, ttlMs: TTL, provider: 'platinum' });
    expect(d.action).toBe('reconcile-removed');
    expect(d.reprovisionOnResume).toBe(true);
  });

  test('provider already stopped → reconcile-stopped', () => {
    expect(decideReap({ providerStatus: 'stopped', meaningfulIdleMs: 0, hasActiveTurn: false, ttlMs: TTL, provider: 'daytona' }).action).toBe('reconcile-stopped');
  });

  test('running + idle past TTL → stop-idle', () => {
    expect(decideReap({ providerStatus: 'running', meaningfulIdleMs: TTL + 1, hasActiveTurn: false, ttlMs: TTL, provider: 'daytona' }).action).toBe('stop-idle');
  });

  test('running + idle but a turn is in flight → none', () => {
    expect(decideReap({ providerStatus: 'running', meaningfulIdleMs: 10 * TTL, hasActiveTurn: true, ttlMs: TTL, provider: 'daytona' }).action).toBe('none');
  });

  test('running + within TTL → none', () => {
    expect(decideReap({ providerStatus: 'running', meaningfulIdleMs: TTL - 1, hasActiveTurn: false, ttlMs: TTL, provider: 'daytona' }).action).toBe('none');
  });

  test('Daytona idle stop resumes in place; Platinum must reprovision', () => {
    expect(decideReap({ providerStatus: 'running', meaningfulIdleMs: TTL + 1, hasActiveTurn: false, ttlMs: TTL, provider: 'daytona' }).reprovisionOnResume).toBe(false);
    expect(decideReap({ providerStatus: 'running', meaningfulIdleMs: TTL + 1, hasActiveTurn: false, ttlMs: TTL, provider: 'platinum' }).reprovisionOnResume).toBe(true);
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

describe('buildIdleStopMetadata', () => {
  const nowIso = '2026-06-21T12:00:00.000Z';
  test('idle stop quiesces so passive traffic cannot resurrect', () => {
    const m = buildIdleStopMetadata({ quiesce: true, reprovision: false, nowIso });
    expect(m.idleQuiesced).toBe(true);
    expect(m.idleQuiescedAt).toBe(nowIso);
    expect(m.needsReprovision).toBeUndefined();
  });
  test('Platinum idle stop also flags reprovision', () => {
    const m = buildIdleStopMetadata({ quiesce: true, reprovision: true, nowIso });
    expect(m.idleQuiesced).toBe(true);
    expect(m.needsReprovision).toBe(true);
  });
  test('no flags → empty patch (nothing merged)', () => {
    expect(buildIdleStopMetadata({ quiesce: false, reprovision: false, nowIso })).toEqual({});
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

  test('Platinum idle stop flags reprovision (resume is broken)', async () => {
    candidates = [candidate({ provider: 'platinum', externalId: 'ext-p', sandboxId: 'sb-p' })];
    statusByExternal['ext-p'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(stops).toEqual(['ext-p']);
    // The stop wrote a metadata merge (the reprovision flag content is covered by
    // the buildIdleStopMetadata unit test below — the SQL object isn't introspectable).
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

  test('never reaps a box with a turn in flight', async () => {
    candidates = [candidate()]; // idle by timestamp
    statusByExternal['ext-1'] = 'running';
    activeTurns = [{ sessionId: 'sess-1' }];

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
  });

  test('skips local_docker (--rm, cannot resume)', async () => {
    candidates = [candidate({ provider: 'local_docker' })];

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

  test('provider-removed → reconcile to STOPPED (not archived) + needsReprovision, so it can reopen', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'removed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(endedCompute).toEqual(['sb-1']);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    // MUST be 'stopped' — openSession only reprovisions a stopped+needsReprovision row.
    expect(sbUpdate?.updates.status).toBe('stopped');
    expect(sbUpdate?.updates.metadata).toBeDefined();
    expect(stops).toEqual([]); // never poke a removed box
  });

  test('FAIL-SAFE: when the activity lookup fails, never stop a running box', async () => {
    candidates = [candidate()]; // idle by timestamp (created 2h ago)
    statusByExternal['ext-1'] = 'running';
    throwOnUsageLookup = true; // simulate a DB/transient failure

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]); // uncertain → do not stop
    expect(pausedCompute).toEqual([]);
    expect(r.stopped).toBe(0);
  });
});

// ── orphan-box reaper: stops provider boxes the DB sweep can't see ────────────
describe('reapOrphanProviderBoxes', () => {
  const NOW2 = new Date('2026-06-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW2.getTime() - h * 3_600_000);

  test('stops boxes with no live DB row; spares kept, too-young, and unknown-age boxes', async () => {
    // keepSet (the DB's view of live boxes) comes from the sessionSandboxes query.
    candidates = [{ externalId: 'keep-1' }];
    managedBoxes = [
      { externalId: 'keep-1', createdAt: hoursAgo(48) }, // in keepSet → spare
      { externalId: 'orphan-1', createdAt: hoursAgo(48) }, // orphan + old → STOP
      { externalId: 'orphan-2', createdAt: hoursAgo(3) }, // orphan + old → STOP
      { externalId: 'young-1', createdAt: hoursAgo(0.2) }, // orphan but <1h → spare (provision race)
      { externalId: 'nodate', createdAt: null }, // unknown age → spare (fail-safe)
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
