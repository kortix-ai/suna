/**
 * The control-plane reconciler.
 *
 * What matters here is not that it reads — it is WHEN it does not emit. The
 * whole design rests on "a frame only when the answer changed": without that,
 * every open session would publish four snapshots every five seconds forever,
 * and the stream would be a more expensive poll wearing a push costume.
 *
 * The second property is reference counting. One reconciler per session per
 * instance means the DB load FALLS as tabs are added; a per-connection timer
 * would make it rise, which is the opposite of the polling it replaces.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';

let turnState: unknown = { turns: [], last_ended: null };
let inboxRows: unknown[] = [];
let sandboxRow: Record<string, unknown> | null = null;
let mirrorRow: Record<string, unknown> | null = null;
let turnReads = 0;
let inboxReads = 0;
// The audit watermark reads `connector_calls` twice: a pending COUNT, then the
// two newest instants. The mock returns whichever the current projection asks
// for, so a test can move the watermark by changing these.
let auditPending = 0;
let auditLatestAt: Date | null = null;
let auditLatestResolvedAt: Date | null = null;

// The rendered WHERE of every `connector_calls` read, so a test can prove
// which index the read can use.
const auditWhere: string[] = [];
let sessionProjectId: string | null = 'project-owner';
let sessionTitleMetadata: Record<string, unknown> = { name: 'Synthetic title' };
const ladderWrites: unknown[] = [];
let secretCount = 2;
const { PgDialect } = await import('drizzle-orm/pg-core');

const ladderSteps: Array<{ step: string; sessionId: string; userId: string }> = [];
let billingOk = true;
mock.module('../session-lifecycle/start-session', () => ({
  startSession: async (command: { sessionId: string; loaded: { userId: string } }) => {
    ladderSteps.push({ step: 'retry-start', sessionId: command.sessionId, userId: command.loaded.userId });
    return { status: 'pending' };
  },
}));
mock.module('../session-lifecycle/actions', () => ({
  restartSession: async (input: { sessionId: string; loaded: { userId: string } }) => {
    ladderSteps.push({ step: 'restart', sessionId: input.sessionId, userId: input.loaded.userId });
    return { status: 202, body: {} };
  },
}));
mock.module('../../billing/services/billing-gate', () => ({
  checkBillingAdmission: async () => ({ ok: billingOk }),
}));

mock.module('../../shared/db', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => (sandboxRow ? [sandboxRow] : []) }),
            }),
          }),
        }),
        update: () => ({
          set: (values: { metadata: unknown }) => ({
            where: async () => {
              ladderWrites.push(values);
            },
          }),
        }),
      }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    select: (projection: Record<string, unknown>) => ({
      from: (_table: unknown) => {
        // Distinguish the reads by the PROJECTION they ask for, not the table
        // name: drizzle's `table._.name` is undefined in this version, so the
        // name-based branch was dead. The projection is unambiguous per read.
        const rows = () => {
          if ('projectId' in projection) return sessionProjectId ? [{ projectId: sessionProjectId }] : [];
          if ('sessionMetadata' in projection)
            return [{ sessionMetadata: sessionTitleMetadata, sessionProjectId: sessionProjectId }];
          if ('secretCount' in projection)
            return [{ secretCount, secretsUpdatedAt: new Date('2026-10-06T10:00:00.000Z') }];
          if ('pending' in projection) return [{ pending: auditPending }];
          if ('latest' in projection)
            return [{ latest: auditLatestAt, latestResolved: auditLatestResolvedAt }];
          if ('capturedAt' in projection) return mirrorRow ? [mirrorRow] : [];
          if ('messages' in projection) return [{ messages: 0, newest: null }];
          return sandboxRow ? [sandboxRow] : [];
        };
        const stage = {
          where: (condition?: unknown) => {
            if (condition && ('pending' in projection || 'latest' in projection)) {
              auditWhere.push(new PgDialect().sqlToQuery(condition as never).sql);
            }
            return stage;
          },
          limit: () => stage,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows()).then(resolve),
        };
        return stage;
      },
    }),
  },
  hasDatabase: true,
}));

mock.module('./session-turn-read', () => ({
  readSessionTurnState: async () => {
    turnReads += 1;
    return turnState;
  },
}));
mock.module('../session-lifecycle/inbox-rows', () => ({
  listInboxPrompts: async () => {
    inboxReads += 1;
    return inboxRows;
  },
}));
mock.module('./session-prompt-view', () => ({
  serializePrompt: (row: Record<string, unknown>) => row,
}));
mock.module('../session-lifecycle/runtime-wake-fence', () => ({
  runtimeWakeInProgress: (metadata: Record<string, unknown> | null | undefined) =>
    Boolean(metadata?.runtimeWakeId),
}));

import type { ControlEvent } from './session-control-events';
const { __resetControlEventsForTests, subscribeControlEvents, controlChannelState } =
  await import('./session-control-events');
const {
  acquireControlReconciler,
  pokeControlReconciler,
  __resetControlReconcilersForTests,
  CONTROL_RECONCILE_MS,
  CONTROL_REFRESH_MS,
} = await import('./session-control-reconciler');

const SESSION = 'sess-reconcile';

beforeEach(() => {
  __resetControlEventsForTests();
  __resetControlReconcilersForTests();
  turnReads = 0;
  inboxReads = 0;
  turnState = { turns: [], last_ended: null };
  inboxRows = [];
  sandboxRow = { status: 'active', externalId: 'box-1', provider: 'e2b', metadata: {}, deadlineAt: new Date(0) };
  mirrorRow = null;
  auditPending = 0;
  auditLatestAt = null;
  auditLatestResolvedAt = null;
  sessionTitleMetadata = { name: 'Synthetic title' };
  secretCount = 2;
  ladderSteps.length = 0;
  ladderWrites.length = 0;
  billingOk = true;
  setSystemTime();
});

afterEach(() => {
  __resetControlReconcilersForTests();
  __resetControlEventsForTests();
});

describe('emission', () => {
  test('the first pass publishes a snapshot for every subsystem it could read', async () => {
    const handle = acquireControlReconciler(SESSION);
    await handle.ready();
    const types = handle.snapshot().map((event) => event.type);
    expect(types).toEqual([
      'kortix.control.turn',
      'kortix.control.queue',
      'kortix.control.runtime',
      'kortix.control.mirror',
      'kortix.control.audit',
      'kortix.control.session',
    ]);
    handle.release();
  });

  test('every frame carries the WHOLE subsystem state, so a missed one is recoverable', async () => {
    inboxRows = [{ id: 'p1', state: 'waiting', reason: 'held' }];
    const handle = acquireControlReconciler(SESSION);
    await handle.ready();
    const queue = handle.snapshot().find((event) => event.type === 'kortix.control.queue');
    expect(queue!.payload).toEqual({
      known: true,
      prompts: [{ id: 'p1', state: 'waiting', reason: 'held' }],
      // The derived bit the client would otherwise recompute.
      held: true,
      // The server clock at the read — the frame's rank among queue snapshots.
      observed_at: expect.any(String),
    });
    handle.release();
  });

  test('the queue frame carries observed_at from BEFORE the read', async () => {
    // The queue's freshness protocol (JAY-728): a stream frame ranks against
    // GET/POST/bundle snapshots on the server clock, so the stamp must be the
    // instant the read was ASKED — stamped at publish time, a slow reconciler
    // read published an OLD empty queue under a NEW instant and erased a
    // newer confirmed row.
    mock.module('../session-lifecycle/inbox-rows', () => ({
      listInboxPrompts: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return inboxRows;
      },
    }));
    try {
      const handle = acquireControlReconciler(SESSION);
      await handle.ready();
      const done = Date.now();
      const queue = handle.snapshot().find((event) => event.type === 'kortix.control.queue');
      const payload = queue!.payload as Record<string, unknown>;
      const observed = Date.parse(String(payload.observed_at));
      expect(Number.isFinite(observed)).toBe(true);
      expect(observed).toBeLessThanOrEqual(done - 25);
      handle.release();
    } finally {
      mock.module('../session-lifecycle/inbox-rows', () => ({
        listInboxPrompts: async () => {
          inboxReads += 1;
          return inboxRows;
        },
      }));
    }
  });

  test('a pass that changes nothing publishes NOTHING', async () => {
    const handle = acquireControlReconciler(SESSION);
    await handle.ready();
    const head = controlChannelState(SESSION).head_cseq;
    expect(head).toBe(6);

    handle.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Re-read the same truth; the cursor must not move.
    expect(controlChannelState(SESSION).head_cseq).toBe(head);
    expect(turnReads).toBeGreaterThan(1);
    handle.release();
  });

  test('a changed subsystem publishes exactly one new frame, for that subsystem only', async () => {
    const handle = acquireControlReconciler(SESSION);
    await handle.ready();
    const head = controlChannelState(SESSION).head_cseq;

    const received: string[] = [];
    const sub = subscribeControlEvents(SESSION, {}, (event) => received.push(event.type));
    // A held row: the queue moves, `working` (in the turn frame) does not.
    inboxRows = [{ id: 'p2', state: 'waiting', reason: 'held' }];
    handle.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual(['kortix.control.queue']);
    expect(controlChannelState(SESSION).head_cseq).toBe(head + 1);
    sub.unsubscribe();
    handle.release();
  });

  test('the audit watermark carries the pending count and the two newest instants', async () => {
    auditPending = 2;
    auditLatestAt = new Date('2026-08-27T00:00:00.000Z');
    auditLatestResolvedAt = null;
    const handle = acquireControlReconciler(`${SESSION}-audit`);
    await handle.ready();
    const audit = handle.snapshot().find((event) => event.type === 'kortix.control.audit');
    expect(audit!.payload).toEqual({
      known: true,
      pending: 2,
      latest_at: '2026-08-27T00:00:00.000Z',
      latest_resolved_at: null,
    });
    handle.release();
  });

  test('every audit read filters on the project, so the (project_id, session_id) index serves it', async () => {
    auditWhere.length = 0;
    const handle = acquireControlReconciler(`${SESSION}-audit-index`, 'project-given');
    await handle.ready();
    expect(auditWhere).toHaveLength(2);
    for (const where of auditWhere) {
      expect(where).toContain('"project_id" = $1');
      expect(where).toContain('"session_id" = $2');
    }
    handle.release();
  });

  test('a session with no project publishes no audit frame and reads no connector_calls', async () => {
    auditWhere.length = 0;
    sessionProjectId = null;
    try {
      const handle = acquireControlReconciler(`${SESSION}-audit-orphan`);
      await handle.ready();
      expect(handle.snapshot().some((event) => event.type === 'kortix.control.audit')).toBe(false);
      expect(auditWhere).toHaveLength(0);
      handle.release();
    } finally {
      sessionProjectId = 'project-owner';
    }
  });

  test('a resolution (pending falls, resolved instant moves) publishes ONE new audit frame', async () => {
    auditPending = 1;
    auditLatestAt = new Date('2026-08-27T00:00:00.000Z');
    const handle = acquireControlReconciler(`${SESSION}-audit-move`);
    await handle.ready();
    const head = controlChannelState(`${SESSION}-audit-move`).head_cseq;

    const received: string[] = [];
    const sub = subscribeControlEvents(`${SESSION}-audit-move`, {}, (event) => received.push(event.type));
    auditPending = 0;
    auditLatestResolvedAt = new Date('2026-08-27T00:01:00.000Z');
    handle.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual(['kortix.control.audit']);
    expect(controlChannelState(`${SESSION}-audit-move`).head_cseq).toBe(head + 1);
    sub.unsubscribe();
    handle.release();
  });

  test('a subsystem that throws does not suppress the ones that answered', async () => {
    mock.module('./session-turn-read', () => ({
      readSessionTurnState: async () => {
        throw new Error('turn read exploded');
      },
    }));
    const { acquireControlReconciler: acquire } = await import('./session-control-reconciler');
    __resetControlReconcilersForTests();
    const handle = acquire(`${SESSION}-throws`);
    await handle.ready();
    const types = handle.snapshot().map((event) => event.type);
    expect(types).not.toContain('kortix.control.turn');
    expect(types).toContain('kortix.control.queue');
    expect(types).toContain('kortix.control.runtime');
    handle.release();
    // Restore for the remaining cases in this file.
    mock.module('./session-turn-read', () => ({
      readSessionTurnState: async () => {
        turnReads += 1;
        return turnState;
      },
    }));
  });
});

describe('the runtime control snapshot', () => {
  test('mirror watermark reports absence and then the stored capture with empty message statistics', async () => {
    const handle = acquireControlReconciler(`${SESSION}-mirror`);
    await handle.ready();
    expect(handle.snapshot().find((event) => event.type === 'kortix.control.mirror')?.payload).toEqual({
      known: true, present: false, captured_at: null, head_complete: false,
      opencode_session_id: null, message_count: 0, newest_message_at: null,
    });
    mirrorRow = { capturedAt: new Date('2026-08-27T00:00:00Z'), headComplete: true, opencodeSessionId: 'synthetic-session' };
    handle.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.snapshot().find((event) => event.type === 'kortix.control.mirror')?.payload).toEqual({
      known: true, present: true, captured_at: '2026-08-27T00:00:00.000Z', head_complete: true,
      opencode_session_id: 'synthetic-session', message_count: 0, newest_message_at: null,
    });
    handle.release();
  });

  test('reports the sandbox status and the wake fence verdict', async () => {
    sandboxRow = {
      status: 'provisioning',
      externalId: 'box-9',
      provider: 'platinum',
      metadata: { runtimeWakeId: 'wake-1', runtimeWakeProviderStatus: 'starting' },
      deadlineAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const handle = acquireControlReconciler(`${SESSION}-runtime`);
    await handle.ready();
    const runtime = handle.snapshot().find((event) => event.type === 'kortix.control.runtime');
    expect(runtime!.payload).toEqual({
      known: true,
      sandbox_status: 'provisioning',
      external_id: 'box-9',
      provider: 'platinum',
      waking: true,
      wake_provider_status: 'starting',
      deadline_at: '2026-08-27T00:00:00.000Z',
      wake_started_at: null,
      wake_progress_at: null,
      stop_reason: null,
      wake_ladder_budget: { retried: false, restarts: 0, last_action_ms: null },
      // R5.2: a wake nobody answered yet is one the server ladder watches.
      wake_ladder: {
        status: 'waking',
        retried: false,
        restarts: 0,
        max_restarts: 2,
        silent_since: expect.any(String),
      },
    });
    handle.release();
  });

  test('a session with no sandbox row reports nulls, not an absent frame', async () => {
    sandboxRow = null;
    const handle = acquireControlReconciler(`${SESSION}-nobox`);
    await handle.ready();
    const runtime = handle.snapshot().find((event) => event.type === 'kortix.control.runtime');
    expect(runtime!.payload).toMatchObject({ known: true, sandbox_status: null, waking: false });
    handle.release();
  });
});

describe('reference counting', () => {
  test('two streams on one session share ONE reconciler and one set of reads', async () => {
    const first = acquireControlReconciler(`${SESSION}-shared`);
    await first.ready();
    const readsAfterFirst = turnReads;

    const second = acquireControlReconciler(`${SESSION}-shared`);
    await second.ready();
    // The second handle starts no new timer and forces no new pass.
    expect(turnReads).toBe(readsAfterFirst);
    expect(second.snapshot().length).toBe(first.snapshot().length);

    first.release();
    second.release();
  });

  test('releasing twice is safe and does not double-decrement a shared reconciler', async () => {
    const first = acquireControlReconciler(`${SESSION}-double`);
    const second = acquireControlReconciler(`${SESSION}-double`);
    await first.ready();
    first.release();
    first.release();
    // The second holder is still live: a new pass still publishes for it.
    inboxRows = [{ id: 'p3' }];
    second.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.snapshot().some((event) => event.type === 'kortix.control.queue')).toBe(true);
    second.release();
  });

  test('a RECONNECT re-publishes nothing when the control plane did not move', async () => {
    // The defect this closes, found on the live stack: deleting the reconciler
    // on release threw away its change detection, so the next connect emitted five (was four)
    // snapshots identical to the ones before them. Idempotent, but it
    // burns the replay ring on every reconnect.
    const first = acquireControlReconciler(`${SESSION}-reconnect`);
    await first.ready();
    const head = controlChannelState(`${SESSION}-reconnect`).head_cseq;
    expect(head).toBe(6);
    first.release();

    const second = acquireControlReconciler(`${SESSION}-reconnect`);
    await second.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controlChannelState(`${SESSION}-reconnect`).head_cseq).toBe(head);
    // And the reconnecting stream still has the full snapshot to open with.
    expect(second.snapshot().map((event) => event.cseq)).toEqual([1, 2, 3, 4, 5, 6]);
    second.release();
  });

  test('a reconnect DOES publish what actually changed while nobody watched', async () => {
    const first = acquireControlReconciler(`${SESSION}-moved`);
    await first.ready();
    const head = controlChannelState(`${SESSION}-moved`).head_cseq;
    first.release();

    inboxRows = [{ id: 'p9', state: 'waiting', reason: 'held' }];
    const second = acquireControlReconciler(`${SESSION}-moved`);
    await second.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controlChannelState(`${SESSION}-moved`).head_cseq).toBe(head + 1);
    second.release();
  });

  test('a session nobody is watching costs nothing', async () => {
    const handle = acquireControlReconciler(`${SESSION}-idle`);
    await handle.ready();
    handle.release();
    const readsAtRelease = turnReads;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(turnReads).toBe(readsAtRelease);
  });
});

describe('a prompts-changed notification', () => {
  /** Holds every inbox read open until `open()`, so a test can act DURING a tick. */
  function gateInboxReads(): { open: () => void } {
    let release = () => {};
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.module('../session-lifecycle/inbox-rows', () => ({
      listInboxPrompts: async () => {
        inboxReads += 1;
        await gate;
        return inboxRows;
      },
    }));
    return {
      open: () => {
        release();
        gate = Promise.resolve();
      },
    };
  }

  function restoreInboxReads(): void {
    mock.module('../session-lifecycle/inbox-rows', () => ({
      listInboxPrompts: async () => {
        inboxReads += 1;
        return inboxRows;
      },
    }));
  }

  test('re-reads a watched session now and publishes the changed queue', async () => {
    const handle = acquireControlReconciler(`${SESSION}-notify`);
    await handle.ready();
    const reads = inboxReads;
    const received: string[] = [];
    const sub = subscribeControlEvents(`${SESSION}-notify`, {}, (event) => received.push(event.type));

    inboxRows = [{ id: 'p-notify', state: 'queued' }];
    pokeControlReconciler(`${SESSION}-notify`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inboxReads).toBe(reads + 1);
    // The queued row also makes the session work (pending delivery): the turn
    // frame carries that verdict on the same pass.
    expect(received).toEqual(['kortix.control.turn', 'kortix.control.queue']);
    sub.unsubscribe();
    handle.release();
  });

  test('reads nothing for a session this replica does not watch', async () => {
    pokeControlReconciler(`${SESSION}-unwatched`);
    const handle = acquireControlReconciler(`${SESSION}-released`);
    await handle.ready();
    handle.release();
    const reads = inboxReads;

    pokeControlReconciler(`${SESSION}-released`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inboxReads).toBe(reads);
  });

  test('a burst during a tick runs ONE follow-up tick, and that tick sees the last write', async () => {
    const handle = acquireControlReconciler(`${SESSION}-burst`);
    await handle.ready();
    const gate = gateInboxReads();
    try {
      const reads = inboxReads;
      pokeControlReconciler(`${SESSION}-burst`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(inboxReads).toBe(reads + 1);

      // Three writes land while the first read is still open. The read
      // started before them, so it cannot report them.
      inboxRows = [{ id: 'p-late', state: 'queued' }];
      pokeControlReconciler(`${SESSION}-burst`);
      pokeControlReconciler(`${SESSION}-burst`);
      pokeControlReconciler(`${SESSION}-burst`);
      expect(inboxReads).toBe(reads + 1);

      gate.open();
      await new Promise((resolve) => setTimeout(resolve, 30));
      // One follow-up, not three, and not zero.
      expect(inboxReads).toBe(reads + 2);
      const queue = handle.snapshot().find((event) => event.type === 'kortix.control.queue');
      expect((queue!.payload as { prompts: unknown[] }).prompts).toEqual([{ id: 'p-late', state: 'queued' }]);
    } finally {
      restoreInboxReads();
      handle.release();
    }
  });

  test('no follow-up runs once the last stream has gone', async () => {
    const handle = acquireControlReconciler(`${SESSION}-gone`);
    await handle.ready();
    const gate = gateInboxReads();
    try {
      const reads = inboxReads;
      pokeControlReconciler(`${SESSION}-gone`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      pokeControlReconciler(`${SESSION}-gone`);
      handle.release();
      gate.open();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inboxReads).toBe(reads + 1);
    } finally {
      restoreInboxReads();
    }
  });
});

describe('queue-only holders (`?channels=control`)', () => {
  test('a queue-only pass reads the queue and nothing else', async () => {
    auditWhere.length = 0;
    const handle = acquireControlReconciler(`${SESSION}-q`, 'project-owner', 'queue');
    await handle.ready();
    expect(inboxReads).toBe(1);
    expect(turnReads).toBe(0);
    expect(auditWhere).toHaveLength(0);
    expect(handle.snapshot().map((event) => event.type)).toEqual(['kortix.control.queue']);

    pokeControlReconciler(`${SESSION}-q`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inboxReads).toBe(2);
    expect(turnReads).toBe(0);
    handle.release();
  });

  test('a full holder joining a queue-only session reads every subsystem at once', async () => {
    const queueOnly = acquireControlReconciler(`${SESSION}-mixed`, 'project-owner', 'queue');
    await queueOnly.ready();
    auditWhere.length = 0;
    const full = acquireControlReconciler(`${SESSION}-mixed`, 'project-owner');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnReads).toBe(1);
    expect(auditWhere).toHaveLength(2);
    expect(full.snapshot().map((event) => event.type).sort()).toEqual([
      'kortix.control.audit',
      'kortix.control.mirror',
      'kortix.control.queue',
      'kortix.control.runtime',
      'kortix.control.session',
      'kortix.control.turn',
    ]);

    // Mixed holders: every pass still reads everything.
    pokeControlReconciler(`${SESSION}-mixed`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnReads).toBe(2);
    full.release();

    // The last full holder left: back to the queue alone.
    pokeControlReconciler(`${SESSION}-mixed`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnReads).toBe(2);
    queueOnly.release();
  });

  test('the cadence is 5 s with a full holder and 20 s without one', async () => {
    const realSetInterval = globalThis.setInterval;
    const cadences: number[] = [];
    globalThis.setInterval = ((handler: () => void, ms?: number) => {
      cadences.push(ms ?? 0);
      return realSetInterval(handler, ms);
    }) as typeof setInterval;
    try {
      const queueOnly = acquireControlReconciler(`${SESSION}-cadence`, 'project-owner', 'queue');
      expect(cadences).toEqual([CONTROL_REFRESH_MS]);
      const full = acquireControlReconciler(`${SESSION}-cadence`, 'project-owner');
      expect(cadences).toEqual([CONTROL_REFRESH_MS, CONTROL_RECONCILE_MS]);
      // A second queue holder changes nothing.
      const second = acquireControlReconciler(`${SESSION}-cadence`, 'project-owner', 'queue');
      expect(cadences).toHaveLength(2);
      full.release();
      expect(cadences).toEqual([CONTROL_REFRESH_MS, CONTROL_RECONCILE_MS, CONTROL_REFRESH_MS]);
      second.release();
      queueOnly.release();
      expect(cadences).toHaveLength(3);
      expect([CONTROL_RECONCILE_MS, CONTROL_REFRESH_MS]).toEqual([5_000, 20_000]);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

describe('R5.2: the server owns session state', () => {
  const liveTurn = {
    turn_token: 't1',
    state: 'active',
    message_id: null,
    runtime_session_id: 'ses_root',
    opencode_session_id: 'ses_root',
    started_at: '2026-10-06T10:00:00.000Z',
    accepted_at: null,
  };

  test('the turn frame carries the server working state', async () => {
    turnState = { turns: [liveTurn] };
    const handle = acquireControlReconciler(SESSION, 'project-owner');
    await handle.ready();
    const frame = handle.snapshot().find((event) => event.type === 'kortix.control.turn');
    expect((frame!.payload as { working: unknown }).working).toEqual({
      state: 'working',
      since: '2026-10-06T10:00:00.000Z',
      turn_token: 't1',
      pending_delivery: false,
    });
    handle.release();
  });

  test('a queued prompt with no turn is working with pending delivery', async () => {
    inboxRows = [{ prompt_id: 'p1', state: 'queued', reason: null, client_sent_at_ms: null }];
    const handle = acquireControlReconciler(SESSION, 'project-owner');
    await handle.ready();
    const frame = handle.snapshot().find((event) => event.type === 'kortix.control.turn');
    expect((frame!.payload as { working: { pending_delivery: boolean } }).working.pending_delivery).toBe(true);
    handle.release();
  });

  test('a runtime turn end publishes idle at once, with no read', async () => {
    turnState = { turns: [liveTurn] };
    const handle = acquireControlReconciler(SESSION, 'project-owner');
    await handle.ready();
    const reads = turnReads;
    const frames: ControlEvent[] = [];
    const sub = subscribeControlEvents(SESSION, {}, (event) => frames.push(event));
    handle.noteRuntimeTurnEnd('ses_root', Date.parse('2026-10-06T10:00:09.000Z'));
    expect(turnReads).toBe(reads);
    const turnFrame = frames.find((event) => event.type === 'kortix.control.turn');
    expect((turnFrame!.payload as { working: { state: string } }).working.state).toBe('idle');
    sub.unsubscribe();
    handle.release();
  });

  test('the session frame carries the title and a secrets version, never a name', async () => {
    sessionTitleMetadata = { name: 'Generated', custom_name: 'Mine' };
    const handle = acquireControlReconciler(SESSION, 'project-owner');
    await handle.ready();
    const frame = handle.snapshot().find((event) => event.type === 'kortix.control.session');
    expect(frame!.payload).toEqual({
      known: true,
      title: 'Mine',
      secrets_rev: '2:2026-10-06T10:00:00.000Z',
    });
    handle.release();
  });

  test('a connected provider moves the secrets version', async () => {
    const handle = acquireControlReconciler(SESSION, 'project-owner');
    await handle.ready();
    secretCount = 3;
    handle.poke();
    await Bun.sleep(20);
    const frame = handle.snapshot().find((event) => event.type === 'kortix.control.session');
    expect((frame!.payload as { secrets_rev: string }).secrets_rev).toBe('3:2026-10-06T10:00:00.000Z');
    handle.release();
  });
});

describe('R5.2: the server wake ladder', () => {
  const actor = {
    loaded: { row: { projectId: 'project-owner', accountId: 'account-1' }, userId: 'user-owner' },
    visible: { row: { status: 'active', sandboxProvider: 'platinum', baseRef: null, agentName: null, runtimeSessionId: null, accountId: 'account-1' } },
  } as never;
  const wakingRow = () => ({
    status: 'active',
    externalId: 'box-wake',
    provider: 'platinum',
    metadata: { runtimeWakeId: 'wake-1', runtimeWakeStartedAt: '2026-10-06T10:00:00.000Z' },
    deadlineAt: new Date('2026-10-06T11:00:00.000Z'),
  });

  async function quietFor(handle: { poke(): void }, ms: number): Promise<void> {
    setSystemTime(new Date(Date.now() + ms));
    handle.poke();
    await Bun.sleep(30);
  }

  test('a wake that stays quiet for 75 s is re-driven, as the watcher who may restart it', async () => {
    sandboxRow = wakingRow();
    const handle = acquireControlReconciler(`${SESSION}-ladder`, 'project-owner', 'full', actor);
    await handle.ready();
    await quietFor(handle, 60_000);
    expect(ladderSteps).toEqual([]);
    await quietFor(handle, 16_000);
    expect(ladderSteps).toEqual([{ step: 'retry-start', sessionId: `${SESSION}-ladder`, userId: 'user-owner' }]);
    expect(ladderWrites).toHaveLength(1);
    handle.release();
  });

  test('the next step after a re-drive is a restart, then the ladder is exhausted', async () => {
    sandboxRow = {
      ...wakingRow(),
      metadata: { ...wakingRow().metadata, wakeLadder: { retried: true, restarts: 1, last_action_ms: 0 } },
    };
    const handle = acquireControlReconciler(`${SESSION}-ladder2`, 'project-owner', 'full', actor);
    await handle.ready();
    await quietFor(handle, 76_000);
    expect(ladderSteps.map((entry) => entry.step)).toEqual(['restart']);

    sandboxRow = {
      ...wakingRow(),
      metadata: { ...wakingRow().metadata, wakeLadder: { retried: true, restarts: 2, last_action_ms: 0 } },
    };
    await quietFor(handle, 76_000);
    expect(ladderSteps).toHaveLength(1);
    const runtime = handle.snapshot().find((event) => event.type === 'kortix.control.runtime');
    expect((runtime!.payload as { wake_ladder: { status: string } }).wake_ladder.status).toBe('exhausted');
    handle.release();
  });

  test('a read-only viewer sees the ladder but never triggers it', async () => {
    sandboxRow = wakingRow();
    const handle = acquireControlReconciler(`${SESSION}-viewer`, 'project-owner', 'full');
    await handle.ready();
    await quietFor(handle, 200_000);
    expect(ladderSteps).toEqual([]);
    const runtime = handle.snapshot().find((event) => event.type === 'kortix.control.runtime');
    expect((runtime!.payload as { wake_ladder: { status: string } }).wake_ladder.status).toBe('waking');
    handle.release();
  });

  test('a runtime that answered is never restarted, even when it drops later', async () => {
    sandboxRow = wakingRow();
    const handle = acquireControlReconciler(`${SESSION}-answered`, 'project-owner', 'full', actor);
    await handle.ready();
    handle.noteRuntimeReachability(true);
    handle.noteRuntimeReachability(false, 'stream_ended');
    await quietFor(handle, 200_000);
    expect(ladderSteps).toEqual([]);
    const runtime = handle.snapshot().find((event) => event.type === 'kortix.control.runtime');
    expect((runtime!.payload as { wake_ladder: { status: string } }).wake_ladder.status).toBe('idle');
    handle.release();
  });

  test('a billing-blocked account is never woken by the ladder', async () => {
    billingOk = false;
    sandboxRow = wakingRow();
    const handle = acquireControlReconciler(`${SESSION}-billing`, 'project-owner', 'full', actor);
    await handle.ready();
    await quietFor(handle, 200_000);
    expect(ladderSteps).toEqual([]);
    expect(ladderWrites).toEqual([]);
    handle.release();
  });
});
