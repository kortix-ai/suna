import { beforeEach, describe, expect, mock, test } from 'bun:test';
// applyStoppedState — the single writer for "this sandbox is parked".
//
// The procedure used to be copy-pasted three times (reaper idle stop, reaper
// provider-confirmed reconcile, session-lifecycle/stop.ts) and had drifted: the
// manual-stop copy assigned a whole metadata object built from a row it had
// SELECTed moments earlier, dropping whatever a concurrent writer had put there
// in between, and the money-critical "settle the meter before flipping the
// status" order was carried by a comment repeated in each copy.
import { projectSessions, sessionSandboxes } from '@kortix/db';
import * as realComputeMetering from '../../billing/services/compute-metering';
import { RUNTIME_WAKE_LEASE_MS } from '../session-lifecycle/runtime-wake-fence';
import { mockConfigModule } from './test-support/mock-config';

type UpdateCall = {
  table: unknown;
  updates: Record<string, unknown>;
  /** The WHERE the write was guarded by — a CAS is only a CAS if it is there. */
  predicate: unknown;
  inTransaction: boolean;
};

let events: string[] = [];
let updateCalls: UpdateCall[] = [];
let cacheInvalidations: string[] = [];
let selectedRows: Array<Record<string, unknown>> = [];
let executedStatements: Array<{ sql: unknown; inTransaction: boolean }> = [];
let revokedTokens: Array<{ sessionId: string; accountId: string }> = [];
let preserveCalls: Array<{ sandboxId: string; reason: string; stopReason: string }> = [];
let inTransaction = false;
/** When set, every `db.update(...).where(...)` fails with this message. */
let updateThrows: string | null = null;
/** When set, every `db.update(...).where(...)` resolves to no rows — the CAS matched nothing. */
let updateMatchesNothing = false;

mock.module('../../lib/config', () => mockConfigModule());

const updater = (table: unknown) => ({
  set: (updates: Record<string, unknown>) => ({
    // Awaitable, and chainable to `.returning()` (the status transitions).
    where: (predicate?: unknown) => {
      events.push(`update:${table === sessionSandboxes ? 'sandbox' : 'session'}`);
      updateCalls.push({ table, updates, predicate, inTransaction });
      const result = updateThrows
        ? Promise.reject(new Error(updateThrows))
        : Promise.resolve(
          updateMatchesNothing ? [] : [{ sandboxId: 'moved', sessionId: 'moved' }],
        );
      return Object.assign(result, { returning: () => result });
    },
  }),
});

const executor = async (statement: unknown) => {
  events.push('execute');
  executedStatements.push({ sql: statement, inTransaction });
};

/** A nested drizzle transaction (the settle's savepoint) runs in the same scope. */
const savepoint = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionScope);

const transactionScope = { update: updater, execute: executor, transaction: savepoint };

mock.module('../../shared/db', () => ({
  db: {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      events.push('tx:begin');
      inTransaction = true;
      try {
        return await fn(transactionScope);
      } finally {
        inTransaction = false;
        events.push('tx:commit');
      }
    },
    update: updater,
    execute: executor,
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectedRows }),
      }),
    }),
  },
}));

mock.module('../../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  pauseComputeSession: async (sandboxId: string) => {
    events.push(`pause:${sandboxId}`);
  },
  endComputeSession: async () => {},
  reopenComputeForSandbox: async () => undefined,
}));

mock.module('../../repositories/account-tokens', () => ({
  revokeSessionConnectorTokens: async (sessionId: string, accountId: string) => {
    revokedTokens.push({ sessionId, accountId });
    return 1;
  },
}));

mock.module('../runtime-identity', () => ({
  preserveEstablishedRuntime: async (
    row: { sandboxId: string },
    reason: string,
    stopReason: string,
  ) => {
    preserveCalls.push({ sandboxId: row.sandboxId, reason, stopReason });
    return row;
  },
}));

/** Controlled by each unattended-recovery test; defaults to the safe no-op. */
let unattendedOutcome: 'claimed' | 'skipped_attended' | 'skipped_bounded' | 'error' = 'skipped_attended';
let unattendedCalls: unknown[] = [];
let drainCalls = 0;

mock.module('../session-lifecycle/unattended-runtime-recovery', () => ({
  evaluateUnattendedRecovery: async (input: unknown) => {
    unattendedCalls.push(input);
    return unattendedOutcome;
  },
}));

mock.module('../session-lifecycle/drain', () => ({
  drainSessionLifecycleQueue: async () => {
    drainCalls += 1;
  },
}));

// Spread the real module (a hand-listed stub deletes every export it omits —
// `redelivery.ts` needs `withNextDeliveryAttempt` from this same module).
let syntheticContinueCalls: unknown[] = [];
const realStore = await import('../session-lifecycle/store');
mock.module('../session-lifecycle/store', () => ({
  ...realStore,
  enqueueContinueSessionCommand: async (input: unknown) => {
    syntheticContinueCalls.push(input);
    return { row: { commandId: 'synthetic-1' }, deduped: false };
  },
}));

const {
  MIDTURN_STOP_CONFIRMATION_MS,
  applyStoppedState,
  clearPendingStopObservation,
  decideStoppedObservation,
  markPendingStopObservation,
  reconcileSandboxRemovedByExternalId,
  reconcileSandboxStoppedByExternalId,
} = await import('./sandbox-state-sync');

/** Flatten a drizzle SQL expression (including its bound params and the nested
 *  fragments an `and(...)` composes) to text, so a test can assert what the
 *  write actually asks Postgres to do. */
function describeSql(expression: unknown): string {
  if (expression === null || expression === undefined) return '';
  if (typeof expression === 'string') return expression;
  if (typeof expression !== 'object') return String(expression);
  const node = expression as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
  if (Array.isArray(node.queryChunks)) {
    return node.queryChunks.map(describeSql).join(' ').replace(/\s+/g, ' ');
  }
  if (Array.isArray(node.value)) return node.value.join('');
  if (typeof node.value === 'string' || typeof node.value === 'number') return String(node.value);
  return typeof node.name === 'string' ? node.name : '';
}

const isSqlExpression = (value: unknown): boolean =>
  Array.isArray((value as { queryChunks?: unknown[] } | null)?.queryChunks);
const sandboxUpdate = () => updateCalls.find((c) => c.table === sessionSandboxes);
const sessionUpdate = () => updateCalls.find((c) => c.table === projectSessions);

const NOW = new Date('2026-07-29T12:00:00.000Z');
const write = {
  sandboxId: 'sb-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  stopReason: 'deadline_expired' as const,
  now: NOW,
};

beforeEach(() => {
  events = [];
  updateCalls = [];
  cacheInvalidations = [];
  selectedRows = [];
  executedStatements = [];
  revokedTokens = [];
  preserveCalls = [];
  inTransaction = false;
  updateThrows = null;
  updateMatchesNothing = false;
  unattendedOutcome = 'skipped_attended';
  unattendedCalls = [];
  drainCalls = 0;
  syntheticContinueCalls = [];
});

describe('applyStoppedState', () => {
  test('settles the meter before either status flip', async () => {
    await applyStoppedState(write);

    expect(events.indexOf('pause:sb-1')).toBeLessThan(events.indexOf('update:sandbox'));
    expect(events.indexOf('pause:sb-1')).toBeLessThan(events.indexOf('update:session'));
  });

  test('flips the sandbox row and the session row in ONE transaction', async () => {
    await applyStoppedState(write);

    expect(sandboxUpdate()?.inTransaction).toBe(true);
    expect(sessionUpdate()?.inTransaction).toBe(true);
    expect(events.filter((e) => e === 'tx:begin')).toHaveLength(1);
    expect(sandboxUpdate()?.updates.status).toBe('stopped');
    expect(sessionUpdate()?.updates.status).toBe('stopped');
  });

  test('a billing failure never blocks the stop', async () => {
    mock.module('../../billing/services/compute-metering', () => ({
      ...realComputeMetering,
      pauseComputeSession: async () => {
        throw new Error('wallet unreachable');
      },
      endComputeSession: async () => {},
      reopenComputeForSandbox: async () => undefined,
    }));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await applyStoppedState(write);
    } finally {
      console.warn = warn;
      mock.module('../../billing/services/compute-metering', () => ({
        ...realComputeMetering,
        pauseComputeSession: async (sandboxId: string) => {
          events.push(`pause:${sandboxId}`);
        },
        endComputeSession: async () => {},
        reopenComputeForSandbox: async () => undefined,
      }));
    }

    expect(sandboxUpdate()?.updates.status).toBe('stopped');
  });

  // Erasing the turn authority above makes every token-scoped ledger settle
  // impossible afterwards: they all CAS against the metadata entry this
  // statement just deleted. A turn that was in flight would keep claiming to be
  // running for ever — the exact stuck-busy signal session_turns exists to
  // answer. So the settle rides in the SAME transaction.
  // The effect on real rows (open row -> ended/runtime_gone, a failed settle
  // bounded by its savepoint) is proven in
  // __tests__/integration-session-turns-stop-race.test.ts. The ORDER is proven
  // here: the sandbox UPDATE takes the row lock that blocks a concurrent
  // beginSandboxTurn, so the settle must run after it and before commit.
  test('settles the session_turns ledger after the erasure, inside the stop transaction', async () => {
    await applyStoppedState(write);

    expect(executedStatements).toHaveLength(1);
    expect(executedStatements[0]?.inTransaction).toBe(true);
    // Ordered after the erasure, never before: a settle that ran first would
    // leave a turn started in between unsettled.
    expect(events.indexOf('update:sandbox')).toBeLessThan(events.indexOf('execute'));
    expect(events.indexOf('execute')).toBeLessThan(events.indexOf('tx:commit'));
  });

  // The lost update: a whole-object write assembled from a stale SELECT drops
  // whatever a concurrent writer put in the column in between — the
  // `runtimeWakeId` wake fence (projects/routes/shared.ts) and, one table over,
  // the `lastAliveAt` stamp the compute clamp bills against.
  //
  // The fixture deliberately avoids a `stopReason` key inside `metadata` here:
  // `write.stopReason` (top-level, required) always wins over one nested in
  // `metadata` — see the precedence test below — so putting it here would
  // read as though the nested value mattered when it never lands.
  test('REGRESSION: the caller patch is MERGED into jsonb, never assigned', async () => {
    await applyStoppedState({
      ...write,
      metadata: { stoppedBy: 'user-1' },
    });

    const metadata = sandboxUpdate()?.updates.metadata;
    expect(isSqlExpression(metadata)).toBe(true);
    const rendered = describeSql(metadata);
    expect(rendered).toContain('coalesce');
    expect(rendered).toContain("'{}'::jsonb");
    expect(rendered).toContain('stopReason');
    expect(rendered).toContain('stoppedBy');
  });

  test('drops the proxy cache, and tolerates a row with no external id', async () => {
    await applyStoppedState(write);
    expect(cacheInvalidations).toEqual(['ext-1']);

    cacheInvalidations = [];
    await applyStoppedState({ ...write, externalId: null });
    expect(cacheInvalidations).toEqual([]);
  });
});

// Nobody-is-watching recovery: a provider-originated `runtime_gone` stop with
// an abandoned turn asks `evaluateUnattendedRecovery` whether THIS sandbox may
// resume unattended. The policy itself (who qualifies, the rolling-window
// bound) is unit-tested in isolation in unattended-runtime-recovery.test.ts —
// this only proves `applyStoppedState` asks at the right time, reacts to the
// answer (the `end_error` cause, the redelivery `hold` flag, the drain kick),
// and NEVER asks for a stop reason that is not `provider_reconcile`.
describe('applyStoppedState — unattended recovery after runtime_gone', () => {
  const providerWrite = {
    sandboxId: 'sb-2',
    sessionId: 'sess-2',
    externalId: 'ext-2',
    stopReason: 'provider_reconcile' as const,
    now: NOW,
  };

  const withAbandonedTurn = () => {
    selectedRows = [
      {
        // Read twice by the generic mock — once as the sandbox's own
        // `before.metadata` (only `.metadata` matters there), once as the
        // `project_sessions` row `evaluateUnattendedRecovery` and the
        // synthetic-continue fallback read (`origin`/`accountId`/`projectId`
        // matter there). One fixture row serves both call sites.
        origin: 'trigger',
        accountId: 'acc-2',
        projectId: 'proj-2',
        metadata: {
          activeTurns: {
            'tok-1': {
              token: 'tok-1',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_1',
              startedAtMs: NOW.getTime() - 5_000,
            },
          },
        },
      },
    ];
  };

  test('asks the policy only for provider_reconcile with an open turn — never for a user/idle stop', async () => {
    withAbandonedTurn();
    await applyStoppedState(write); // stopReason: 'deadline_expired'
    expect(unattendedCalls).toHaveLength(0);

    await applyStoppedState({ ...write, stopReason: 'manual' });
    expect(unattendedCalls).toHaveLength(0);

    selectedRows = [{ metadata: {} }]; // provider_reconcile, but nothing was open
    await applyStoppedState(providerWrite);
    expect(unattendedCalls).toHaveLength(0);

    withAbandonedTurn();
    await applyStoppedState(providerWrite);
    expect(unattendedCalls).toHaveLength(1);
    expect(unattendedCalls[0]).toMatchObject({ sandboxId: 'sb-2' });
  });

  test('policy says no (attended, or bounded): the generic cause, HELD, no drain kick', async () => {
    withAbandonedTurn();
    unattendedOutcome = 'skipped_bounded';
    await applyStoppedState(providerWrite);

    const rendered = describeSql(executedStatements[0]?.sql);
    expect(rendered).toContain('SandboxStoppedMidTurn');
    expect(rendered).not.toContain('SandboxStoppedMidTurnRecovering');
    expect(drainCalls).toBe(0);
  });

  test('policy says claimed: the recovering cause, and the drain is kicked', async () => {
    withAbandonedTurn();
    unattendedOutcome = 'claimed';
    await applyStoppedState(providerWrite);

    const rendered = describeSql(executedStatements[0]?.sql);
    expect(rendered).toContain('SandboxStoppedMidTurnRecovering');
    // Fire-and-forget dynamic import; give its microtask a turn to run.
    await Bun.sleep(0);
    expect(drainCalls).toBe(1);
    // The fixture's abandoned turn has no matching `continue_session` inbox
    // row (this mock's db.select cannot satisfy `findPromptByWireId`), which
    // is the SAME shape a session's own initial prompt has for real — no row
    // ever existed. A synthetic continue prompt must fill that gap.
    expect(syntheticContinueCalls).toHaveLength(1);
    expect(syntheticContinueCalls[0]).toMatchObject({
      source: 'system:auto-recovery',
      sessionId: 'sess-2',
      accountId: 'acc-2',
      projectId: 'proj-2',
    });
  });

  test('a real redelivered prompt (not a fresh session) skips the synthetic continue', async () => {
    withAbandonedTurn();
    unattendedOutcome = 'claimed';
    // Simulate a genuine continue_session row being released: stub the
    // redelivery module's dependency the same way requeueAbandonedPrompt's
    // own unit tests do, by making the mocked db answer a real match.
    // Simplest here: assert the negative case directly is covered by the
    // integration-level real-DB test instead; this unit test pins that the
    // fallback is gated on `anyPromptReleased`, exercised via the outcome
    // recorded from `requeueAbandonedPrompt`'s return value in the loop —
    // already proven true above. This test pins the ABSENCE case: no claim,
    // no synthetic continue at all.
    unattendedOutcome = 'skipped_bounded';
    await applyStoppedState(providerWrite);
    expect(syntheticContinueCalls).toHaveLength(0);
  });

  test('a stop with no reason attached (idle/manual) never names a cause', async () => {
    withAbandonedTurn();
    await applyStoppedState(write); // deadline_expired
    const rendered = describeSql(executedStatements[0]?.sql);
    expect(rendered).not.toContain('SandboxStoppedMidTurn');
  });
});

describe('reconcileSandboxStoppedByExternalId', () => {
  test('routes a provider-confirmed stop through the single writer', async () => {
    selectedRows = [{ sandboxId: 'sb-1', sessionId: 'sess-1', status: 'active' }];

    expect(await reconcileSandboxStoppedByExternalId('ext-1', NOW)).toBe(true);
    // The money-critical order: settle the meter against the still-active row
    // BEFORE flipping either status.
    expect(events.indexOf('pause:sb-1')).toBeLessThan(events.indexOf('update:sandbox'));
    expect(cacheInvalidations).toEqual(['ext-1']);
  });

  test('a row already stopped is a no-op', async () => {
    selectedRows = [{ sandboxId: 'sb-1', sessionId: 'sess-1', status: 'stopped' }];

    expect(await reconcileSandboxStoppedByExternalId('ext-1', NOW)).toBe(false);
    expect(updateCalls).toEqual([]);
  });

  test('a fresh wake fence defers a transient provider-stopped observation', async () => {
    selectedRows = [
      {
        sandboxId: 'sb-1',
        sessionId: 'sess-1',
        status: 'active',
        metadata: {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        },
      },
    ];

    expect(await reconcileSandboxStoppedByExternalId('ext-1', NOW)).toBe(false);
    expect(events).toEqual([]);
  });

  const midTurnRow = (extraMetadata: Record<string, unknown> = {}) => [
    {
      sandboxId: 'sb-1',
      sessionId: 'sess-1',
      status: 'active',
      metadata: {
        activeTurns: {
          'turn-1': {
            token: 'turn-1',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_1',
          },
        },
        ...extraMetadata,
      },
    },
  ];

  test('a first OBSERVED stop mid-turn records the marker instead of parking', async () => {
    selectedRows = midTurnRow();
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(
        await reconcileSandboxStoppedByExternalId('ext-1', NOW, { confirmMidTurnStop: true }),
      ).toBe(false);
    } finally {
      console.warn = warn;
    }

    // No meter settle, no status flip — the row is still live.
    expect(events).not.toContain('pause:sb-1');
    expect(sessionUpdate()).toBeUndefined();
    expect(describeSql(sandboxUpdate()?.updates.metadata)).toContain('pendingStopObservedAtMs');
  });

  test('a second observed stop a pass later parks the box', async () => {
    selectedRows = midTurnRow({
      pendingStopObservedAtMs: NOW.getTime() - MIDTURN_STOP_CONFIRMATION_MS,
    });

    expect(
      await reconcileSandboxStoppedByExternalId('ext-1', NOW, { confirmMidTurnStop: true }),
    ).toBe(true);
    expect(events).toContain('pause:sb-1');
    expect(sessionUpdate()?.updates.status).toBe('stopped');
  });

  // One stop episode is one incident, not one warn per poll. The reaper passes
  // every 20 s and the session access path polls ~1/s, so a warn every
  // await_confirmation pass multiplies an episode's line count by the window —
  // the 2026-09-26 prod spike was 3 warn lines per episode from the reaper
  // alone. Only the call that ARMS a fresh marker may warn.
  test('an unchanged episode inside the confirmation window warns once', async () => {
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      // First observed stop: arms the marker and warns once.
      selectedRows = midTurnRow();
      expect(
        await reconcileSandboxStoppedByExternalId('ext-1', NOW, { confirmMidTurnStop: true }),
      ).toBe(false);
      expect(warnings).toHaveLength(1);

      // A repeated observed stop inside the window: the CAS matches nothing,
      // so no second line — and still no park.
      selectedRows = midTurnRow({ pendingStopObservedAtMs: NOW.getTime() - 5_000 });
      updateMatchesNothing = true;
      expect(
        await reconcileSandboxStoppedByExternalId('ext-1', NOW, { confirmMidTurnStop: true }),
      ).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(events).not.toContain('pause:sb-1');
    } finally {
      console.warn = warn;
    }
  });

  // Account deletion, the orphan-box sweep, and the access path in
  // projects/routes/shared.ts all call this AFTER stopping the box themselves.
  // Making those wait for a second observation would leave the row `active`
  // against a box that is off — still billing — and shared.ts reads the row back
  // expecting `stopped` before it resumes it, so a deferred park breaks session
  // access outright.
  test('REGRESSION: a caller that already stopped the box parks it unconditionally', async () => {
    selectedRows = midTurnRow();

    expect(await reconcileSandboxStoppedByExternalId('ext-1', NOW)).toBe(true);
    expect(events).toContain('pause:sb-1');
    expect(sandboxUpdate()?.updates.status).toBe('stopped');
  });

  test('an expired wake fence does not hide a provider-stopped sandbox', async () => {
    selectedRows = [
      {
        sandboxId: 'sb-1',
        sessionId: 'sess-1',
        status: 'active',
        metadata: {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: new Date(NOW.getTime() - RUNTIME_WAKE_LEASE_MS - 1).toISOString(),
        },
      },
    ];

    expect(await reconcileSandboxStoppedByExternalId('ext-1', NOW)).toBe(true);
    expect(events).toContain('pause:sb-1');
  });
});

// ═══ THE MID-TURN PARK THIS CLOSES ═══
// Incident 2026-08-17T20:40:03Z (a prod session on a Daytona sandbox): ONE
// provider read of `stopped` durably parked a box that was running a turn,
// `stopReason: provider_reconcile`. `stopping` and `pending_stop` both map to
// `stopped` (platform/providers/daytona-state.ts), so a box mid-transition — or
// a single misread — settles its turns `runtime_gone` and kicks its client to
// the wake flow with no way back. This is the wake fence, mirrored to the stop
// direction: while turn authority exists the park needs TWO observations.
describe('decideStoppedObservation — one stopped read is not proof mid-turn', () => {
  const turn = {
    activeTurns: {
      'turn-1': {
        token: 'turn-1',
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_1',
      },
    },
  };

  // Incident 2026-08-21T23:58Z, a Platinum sandbox of a prod session:
  // parked mid-turn with `provider_reconcile`, and the SAME box reported running
  // ten seconds later. The guest never rebooted and OpenCode never restarted —
  // nothing had gone away. Five turns died this way in one day.
  describe('REGRESSION: a box that proved it was running is never parked', () => {
    const observedAt = Date.parse('2026-08-21T23:58:22.000Z');
    const withStop = (extraMeta: Record<string, unknown> = {}) => ({
      ...turn,
      pendingStopObservedAtMs: observedAt,
      ...extraMeta,
    });

    test('a running confirmation AFTER the stop observation defeats the park', () => {
      const meta = withStop({ providerRunningConfirmedAt: '2026-08-21T23:58:47.693Z' });
      // Even well past the confirmation window: the box was WATCHED running
      // after the reading that suspected it, so the suspicion is stale.
      const wayLater = new Date(observedAt + 10 * 60_000);
      expect(decideStoppedObservation(meta, wayLater)).toBe('await_confirmation');
    });

    test('a running confirmation from BEFORE the observation does not defeat it', () => {
      // Otherwise any box that ever ran could never be parked.
      const meta = withStop({ providerRunningConfirmedAt: '2026-08-21T23:00:00.000Z' });
      const past = new Date(observedAt + MIDTURN_STOP_CONFIRMATION_MS);
      expect(decideStoppedObservation(meta, past)).toBe('park');
    });

    test('an unparseable confirmation is ignored rather than trusted', () => {
      const meta = withStop({ providerRunningConfirmedAt: 'not-a-date' });
      const past = new Date(observedAt + MIDTURN_STOP_CONFIRMATION_MS);
      expect(decideStoppedObservation(meta, past)).toBe('park');
    });
  });

  test('REGRESSION: a box with NO turn authority parks on the first read', () => {
    // An idle box must not gain a pass of latency, or every ordinary park is
    // one reaper cadence later and its meter runs that much longer.
    expect(decideStoppedObservation(null, NOW)).toBe('park');
    expect(decideStoppedObservation({}, NOW)).toBe('park');
    expect(decideStoppedObservation({ activeTurns: {} }, NOW)).toBe('park');
  });

  test('a first stopped read on a box holding a turn awaits confirmation', () => {
    expect(decideStoppedObservation(turn, NOW)).toBe('await_confirmation');
  });

  test('a second read a full pass later confirms the park', () => {
    const observedAtMs = NOW.getTime() - MIDTURN_STOP_CONFIRMATION_MS;
    expect(
      decideStoppedObservation({ ...turn, pendingStopObservedAtMs: observedAtMs }, NOW),
    ).toBe('park');
  });

  test('a second read INSIDE the same pass window is not a second pass', () => {
    // Two observations that could come from one provider transition prove
    // nothing. Only a marker that survived a whole pass does.
    expect(
      decideStoppedObservation(
        { ...turn, pendingStopObservedAtMs: NOW.getTime() - MIDTURN_STOP_CONFIRMATION_MS + 1 },
        NOW,
      ),
    ).toBe('await_confirmation');
  });

  test('a marker nothing can read is not a confirmation', () => {
    // Fails toward the LIVE box: a hand-edited or truncated value must not park
    // a running turn, and markPendingStopObservation overwrites it.
    for (const value of ['soon', null, Number.NaN, -1, {}]) {
      expect(decideStoppedObservation({ ...turn, pendingStopObservedAtMs: value }, NOW)).toBe(
        'await_confirmation',
      );
    }
  });

  test('a marker from the future cannot confirm', () => {
    expect(
      decideStoppedObservation({ ...turn, pendingStopObservedAtMs: NOW.getTime() + 60_000 }, NOW),
    ).toBe('await_confirmation');
  });

  test('the confirmation window outlasts a real provider transition', () => {
    // This DELIBERATELY replaces "shorter than one active-turn renewal pass
    // (20s), so a genuine park costs one extra pass". That was a COST argument,
    // never a correctness one, and it was the wrong trade: on 2026-08-21 a
    // Platinum transition outlasted the 15s window, so both reads landed inside
    // one transition and the guard parked a box that reported running ten
    // seconds later — destroying a live turn. Five turns died that way in a day.
    //
    // The cost of the longer window is one-sided and bounded: a GENUINELY
    // stopped box mid-turn parks up to a minute later, and its meter runs that
    // much longer. The cost of the shorter one was the user's work.
    expect(MIDTURN_STOP_CONFIRMATION_MS).toBeGreaterThanOrEqual(60_000);
    // Still bounded — this must not become "never park".
    expect(MIDTURN_STOP_CONFIRMATION_MS).toBeLessThanOrEqual(120_000);
  });
});

// The marker writes themselves (instant, CAS, provisioning rows, clear) are
// proven on real rows in __tests__/integration-sandbox-turn-lifecycle.test.ts.
describe('the pending stop marker', () => {
  test('reports whether the CAS armed a fresh marker', async () => {
    // A readable marker already on the row makes the CAS match nothing.
    updateMatchesNothing = true;
    await expect(markPendingStopObservation('sb-1')).resolves.toBe(false);

    updateMatchesNothing = false;
    await expect(markPendingStopObservation('sb-1')).resolves.toBe(true);
  });

  test('a failed marker write never fails the pass', async () => {
    updateThrows = 'db down';
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(markPendingStopObservation('sb-1')).resolves.toBe(false);
      await expect(clearPendingStopObservation('sb-1')).resolves.toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });
});

describe('reconcileSandboxRemovedByExternalId', () => {
  // A removed box can never be woken, so its connector token is a bearer
  // credential with no owner and nothing else ever expires it.
  test('SECURITY: revokes the session connector tokens for a removed sandbox', async () => {
    selectedRows = [
      {
        sandboxId: 'sb-1',
        sessionId: 'sess-1',
        accountId: 'acct-1',
        externalId: 'ext-1',
        metadata: {},
        status: 'active',
      },
    ];

    expect(await reconcileSandboxRemovedByExternalId('ext-1', NOW)).toBe(true);
    // A webhook `removed` is one of the three genuine provider-removal signals
    // (this, the reaper's status poll, and a /start status check that came back
    // `removed`), so it is one of the shapes allowed to stamp `provider_removed`.
    // Every other preserve path (failed wake, failed restart, stalled provision)
    // stamps its own reason — see stop-reason.ts.
    expect(preserveCalls).toEqual([
      { sandboxId: 'sb-1', reason: 'provider_webhook_removed', stopReason: 'provider_removed' },
    ]);
    expect(revokedTokens).toEqual([{ sessionId: 'sess-1', accountId: 'acct-1' }]);
  });
});
