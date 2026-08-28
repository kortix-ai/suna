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
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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

mock.module('../../shared/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => ({
      from: (_table: unknown) => {
        // Distinguish the reads by the PROJECTION they ask for, not the table
        // name: drizzle's `table._.name` is undefined in this version, so the
        // name-based branch was dead. The projection is unambiguous per read.
        const rows = () => {
          if ('pending' in projection) return [{ pending: auditPending }];
          if ('latest' in projection)
            return [{ latest: auditLatestAt, latestResolved: auditLatestResolvedAt }];
          if ('capturedAt' in projection) return mirrorRow ? [mirrorRow] : [];
          if ('messages' in projection) return [{ messages: 0, newest: null }];
          return sandboxRow ? [sandboxRow] : [];
        };
        const stage = {
          where: () => stage,
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

const { __resetControlEventsForTests, subscribeControlEvents, controlChannelState } =
  await import('./session-control-events');
const { acquireControlReconciler, __resetControlReconcilersForTests } = await import(
  './session-control-reconciler'
);

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
    });
    handle.release();
  });

  test('a pass that changes nothing publishes NOTHING', async () => {
    const handle = acquireControlReconciler(SESSION);
    await handle.ready();
    const head = controlChannelState(SESSION).head_cseq;
    expect(head).toBe(5);

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
    inboxRows = [{ id: 'p2', state: 'delivering' }];
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
    expect(head).toBe(5);
    first.release();

    const second = acquireControlReconciler(`${SESSION}-reconnect`);
    await second.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controlChannelState(`${SESSION}-reconnect`).head_cseq).toBe(head);
    // And the reconnecting stream still has the full snapshot to open with.
    expect(second.snapshot().map((event) => event.cseq)).toEqual([1, 2, 3, 4, 5]);
    second.release();
  });

  test('a reconnect DOES publish what actually changed while nobody watched', async () => {
    const first = acquireControlReconciler(`${SESSION}-moved`);
    await first.ready();
    const head = controlChannelState(`${SESSION}-moved`).head_cseq;
    first.release();

    inboxRows = [{ id: 'p9', state: 'queued' }];
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
