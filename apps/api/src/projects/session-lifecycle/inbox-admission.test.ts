import { describe, expect, test } from 'bun:test';
import {
  INBOX_ORDER_BACKOFF_MS,
  INBOX_ORDER_MAX_BACKOFF_MS,
  INBOX_STALE_ORDER_BACKOFF_MS,
  INBOX_STALE_ORDER_REFUSALS,
  admissionBackoffMs,
  admitInboxPrompt,
  sessionHoldsTurnAuthority,
} from './inbox-admission';
import type { SessionLifecycleCommandRow } from './store';

const activeTurn = (token: string) => ({
  [token]: { token, state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_1', startedAtMs: 1 },
});

describe('sessionHoldsTurnAuthority', () => {
  test('a running box with a token-keyed active turn holds authority', () => {
    expect(
      sessionHoldsTurnAuthority({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
    ).toBe(true);
  });

  test('the retired single-record activeTurn holds no authority (KRTX-255)', () => {
    expect(
      sessionHoldsTurnAuthority({
        status: 'provisioning',
        metadata: { activeTurn: { token: 't-legacy', state: 'delivering', opencodeSessionId: 'ses_1' } },
      }),
    ).toBe(false);
  });

  test('a STOPPED box holds no authority whatever its metadata still says', () => {
    // Metadata outlives the runtime. `settleOrphanedSandboxTurns` closes every
    // ledger row left open on a stopped box off exactly this predicate.
    expect(
      sessionHoldsTurnAuthority({ status: 'stopped', metadata: { activeTurns: activeTurn('t1') } }),
    ).toBe(false);
  });

  test('a running box with no turn record, and no box at all, hold nothing', () => {
    expect(sessionHoldsTurnAuthority({ status: 'active', metadata: {} })).toBe(false);
    expect(sessionHoldsTurnAuthority({ status: 'active', metadata: null })).toBe(false);
    expect(sessionHoldsTurnAuthority(null)).toBe(false);
  });
});

const row = (overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow =>
  ({
    commandId: 'cmd-1',
    commandType: 'continue_session',
    sessionId: 'sess-1',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    payload: { text: 'hi' },
    ...overrides,
  }) as SessionLifecycleCommandRow;

// The admission verdicts on real rows (live turn, stopped box, older pending,
// on-the-wire sibling, promoted row) are proven in
// __tests__/integration-prompt-inbox.test.ts. These rows pin the branches it
// cannot reach and the backoff curve.
describe('admitInboxPrompt', () => {
  test('without the steer reads, "send now" waits for a live turn — it jumps the QUEUE', async () => {
    // Promotion reorders the line. With no way to steer, it cannot put a second
    // message into a turn that is already running.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('the ordering backoff starts at 300ms and is capped at 2s — a refused row waits for the KICK, not the clock', async () => {
    // A refused row does not poll out a cold boot any more: the terminal relay
    // calls `promoteNextInboxRow`, which makes it due and drains it. This
    // curve only covers the gap a lost kick would leave, so it stays cheap and
    // never grows into the 27s / 45s / 75s of dead air a 30s ceiling produced
    // for three quick messages behind ~1s deliveries (dev, 2026-08-18).
    expect(INBOX_ORDER_BACKOFF_MS).toBe(300);
    expect(INBOX_ORDER_MAX_BACKOFF_MS).toBe(2_000);

    const curve = (refusals: number) =>
      admissionBackoffMs(INBOX_ORDER_BACKOFF_MS, INBOX_ORDER_MAX_BACKOFF_MS, refusals);
    expect(curve(0)).toBe(300);
    // The first four refusals are free; the fifth doubles.
    expect(curve(4)).toBe(300);
    expect(curve(5)).toBe(600);
    expect(curve(9)).toBe(2_000);
    // Clamped BEFORE the shift: `2 ** 1e9` is Infinity, and a `Math.min` over
    // it would hand Infinity straight to a Date constructor.
    expect(curve(1e9)).toBe(2_000);
  });

  test('the refusal counter is what makes a waiting row back off further', async () => {
    const admission = await admitInboxPrompt(
      row({ result: { admission_reason: 'older_prompt_pending', admission_refusals: 20 } }),
      {
        readSandbox: async () => null,
        hasInFlightPrompt: async () => false,
        hasOlderPendingPrompt: async () => true,
      },
    );
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_MAX_BACKOFF_MS,
    });
  });

  test('a row stuck behind an older prompt on a parked box re-polls once a minute, not every 2s', async () => {
    // Prod 2026-10-20: ~200 rows queued behind heads that never delivered
    // (failed or stopped sessions) were refused 28 times a second, ~0.6 of a
    // database core in claims and sibling reads. Every one sat on a box that
    // was not running.
    const deps = (older: boolean, inFlight: boolean) => ({
      readSandbox: async () => ({ status: 'stopped', metadata: {} }),
      hasInFlightPrompt: async () => inFlight,
      hasOlderPendingPrompt: async () => older,
    });
    const stuck = row({
      result: { admission_reason: 'older_prompt_pending', admission_refusals: INBOX_STALE_ORDER_REFUSALS },
    });
    for (const [older, inFlight] of [[true, false], [false, true]] as const) {
      expect(await admitInboxPrompt(stuck, deps(older, inFlight))).toEqual({
        admit: false,
        reason: 'older_prompt_pending',
        retryAfterMs: INBOX_STALE_ORDER_BACKOFF_MS,
      });
    }
    expect(INBOX_STALE_ORDER_BACKOFF_MS).toBe(60_000);
    // A live turn still re-polls at the 2s cap however long it has waited.
    const live = await admitInboxPrompt(
      row({ result: { admission_reason: 'turn_active', admission_refusals: 10_000 } }),
      { ...deps(false, false), readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }) },
    );
    expect(live).toMatchObject({ reason: 'turn_active', retryAfterMs: INBOX_ORDER_MAX_BACKOFF_MS });
  });

  test('a row behind the head of a live turn re-polls once a minute; the head keeps the 2s cap', async () => {
    // Prod 2026-11-03: 93 cron prompts behind live turns in 4 sessions were each
    // re-polled every 2s (29 claims a second). Only the head is admitted next,
    // and the turn's end wakes the head (`promoteNextInboxRow`).
    const live = (older: boolean, inFlight: boolean) => ({
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => inFlight,
      hasOlderPendingPrompt: async () => older,
    });
    const waiting = row({ result: { admission_reason: 'turn_active', admission_refusals: 10_000 } });
    for (const [older, inFlight] of [[true, false], [false, true]] as const) {
      expect(await admitInboxPrompt(waiting, live(older, inFlight))).toEqual({
        admit: false,
        reason: 'older_prompt_pending',
        retryAfterMs: INBOX_STALE_ORDER_BACKOFF_MS,
      });
    }
    expect(await admitInboxPrompt(waiting, live(false, false))).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_MAX_BACKOFF_MS,
    });
  });

  test('a long wait on a RUNNING box keeps the 2s cap, whatever reason the refusals had', async () => {
    // `admission_refusals` counts every reason. A row that waited 64 refusals
    // behind a live turn must not get the minute at its first
    // `older_prompt_pending` while the head is still moving.
    const crossing = await admitInboxPrompt(
      row({ result: { admission_reason: 'turn_active', admission_refusals: INBOX_STALE_ORDER_REFUSALS } }),
      {
        readSandbox: async () => ({ status: 'active', metadata: {} }),
        hasInFlightPrompt: async () => true,
        hasOlderPendingPrompt: async () => true,
      },
    );
    expect(crossing).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_MAX_BACKOFF_MS,
    });
  });

  test('a command with no session id is admitted — the drain fails it honestly', async () => {
    // Refusing here would requeue it for ever; `executeQueuedContinue` already
    // dead-letters a row with no session.
    const admission = await admitInboxPrompt(row({ sessionId: null }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => {
        throw new Error('must not read');
      },
      hasOlderPendingPrompt: async () => {
        throw new Error('must not read');
      },
    });
    expect(admission).toEqual({ admit: true });
  });
});

describe('missed turn-end recovery', () => {
  test('the queue head rechecks terminal authority and proceeds in the same claim', async () => {
    let ended = false;
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: ended ? {} : activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      reconcileTurn: async () => { ended = true; },
    });
    expect(ended).toBe(true);
    expect(result).toEqual({ admit: true });
  });
  test('later rows do not probe or bypass the head', async () => {
    let probes = 0;
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
      reconcileTurn: async () => { probes++; },
    });
    expect(probes).toBe(0);
    expect(result.admit).toBe(false);
  });
  test('a still-active or unreadable turn holds the head after the probe', async () => {
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      reconcileTurn: async () => {},
    });
    expect(result).toMatchObject({ admit: false, reason: 'turn_active' });
  });
});

describe('one delivery mode: every row steers a live turn', () => {
  const ACTOR = 'user-a';
  const liveRow = (payload: Record<string, unknown> = {}, overrides: Partial<SessionLifecycleCommandRow> = {}) =>
    row({ actorUserId: ACTOR, payload: { text: 'also check the tests', wireMessageId: 'msg_2', ...payload }, ...overrides });
  type Box = { status: string; metadata: Record<string, unknown>; externalId: string };
  const liveBox = async (): Promise<Box> => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') }, externalId: 'box-1' });
  function steerDeps(over: {
    capabilities?: string[] | null;
    older?: boolean;
    inFlight?: boolean;
    sandbox?: typeof liveBox;
  } = {}) {
    const fallbacks: string[] = [];
    const deps = {
      readSandbox: over.sandbox ?? liveBox,
      hasInFlightPrompt: async () => over.inFlight ?? false,
      hasOlderPendingPrompt: async () => over.older ?? false,
      steer: {
        capabilities: async () => (over.capabilities === undefined ? ['session.steer'] : over.capabilities),
        recordFallback: async (_r: SessionLifecycleCommandRow, reason: string) => {
          fallbacks.push(reason);
        },
      },
    };
    return { deps, fallbacks };
  }

  test('a row steers into the live turn whatever delivery or placement it was written with', async () => {
    // Prod 2026-11-04: a TUI "go on" (placement composer, no delivery) waited out a 30-step turn.
    for (const payload of [{}, { placement: 'composer' }, { delivery: 'queue', placement: 'composer' }, { delivery: 'interrupt', placement: 'transcript' }, { delivery: 'steer' }]) {
      const { deps, fallbacks } = steerDeps();
      expect(await admitInboxPrompt(liveRow(payload), deps)).toEqual({ admit: true, steerInto: 'msg_1' });
      expect(fallbacks).toEqual([]);
    }
  });

  test("a row from another member or from the session's own subagent steers: there is no prompter rule", async () => {
    // Prod 2026-11-04: three subagent results waited `not_prompter` behind the turn that started the subagent.
    const { deps, fallbacks } = steerDeps();
    expect(await admitInboxPrompt(liveRow({ authorSessionId: 'sess-child' }, { actorUserId: 'user-b' }), deps))
      .toEqual({ admit: true, steerInto: 'msg_1' });
    expect(fallbacks).toEqual([]);
  });

  test('a row with no wire id steers too: delivery mints one', async () => {
    const { deps } = steerDeps();
    expect(await admitInboxPrompt(liveRow({ wireMessageId: undefined }), deps)).toEqual({ admit: true, steerInto: 'msg_1' });
  });

  test('rows go one at a time in send order: a row behind an older or in-flight row waits for it', async () => {
    for (const over of [{ older: true }, { inFlight: true }]) {
      const { deps, fallbacks } = steerDeps(over);
      expect(await admitInboxPrompt(liveRow(), deps)).toEqual({
        admit: false,
        reason: 'older_prompt_pending',
        retryAfterMs: INBOX_STALE_ORDER_BACKOFF_MS,
      });
      expect(fallbacks).toEqual([]);
    }
  });

  test('"send now" steers past an older waiting row, never past one in flight', async () => {
    const promoted = liveRow({}, { result: { promoted: true } });
    expect(await admitInboxPrompt(promoted, steerDeps({ older: true }).deps)).toEqual({ admit: true, steerInto: 'msg_1' });
    expect(await admitInboxPrompt(promoted, steerDeps({ inFlight: true }).deps)).toMatchObject({ admit: false, reason: 'older_prompt_pending' });
  });

  test('a runtime without session.steer records unsupported and the row waits for the next turn', async () => {
    const { deps, fallbacks } = steerDeps({ capabilities: ['runtime.turns.v1'] });
    expect(await admitInboxPrompt(liveRow(), deps)).toMatchObject({ admit: false, reason: 'turn_active' });
    expect(fallbacks).toEqual(['unsupported']);
  });

  test('a row the runtime refused into this turn waits for its end; a newer turn takes the steer', async () => {
    const refused = liveRow({ steerFallback: 'turn_ended', steerRefusedTurn: 'msg_1' });
    const same = steerDeps();
    expect(await admitInboxPrompt(refused, same.deps)).toMatchObject({ admit: false, reason: 'turn_active' });
    expect(same.fallbacks).toEqual([]);
    const newer = steerDeps({
      sandbox: async () => ({
        status: 'active',
        metadata: { activeTurns: { t2: { token: 't2', state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_3', startedAtMs: 2 } } },
        externalId: 'box-1',
      }),
    });
    expect(await admitInboxPrompt(refused, newer.deps)).toEqual({ admit: true, steerInto: 'msg_3' });
  });

  test('an unreadable capability list or a turn still being delivered waits on the short clock, no fallback', async () => {
    const unreadable = steerDeps({ capabilities: null });
    expect(await admitInboxPrompt(liveRow(), unreadable.deps)).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
    const delivering = steerDeps({
      sandbox: async () => ({
        status: 'active',
        metadata: { activeTurns: { t1: { token: 't1', state: 'delivering', opencodeSessionId: 'ses_1', messageId: 'msg_1', startedAtMs: 1 } } },
        externalId: 'box-1',
      }),
    });
    expect(await admitInboxPrompt(liveRow(), delivering.deps)).toMatchObject({ admit: false, reason: 'turn_active' });
    expect([...unreadable.fallbacks, ...delivering.fallbacks]).toEqual([]);
  });

  test('the newest active turn takes the steer when a stale entry outlived its end relay', async () => {
    const { deps } = steerDeps({
      sandbox: async () => ({
        status: 'active',
        metadata: { activeTurns: {
          old: { token: 'old', state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_old', startedAtMs: 1 },
          now: { token: 'now', state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_now', startedAtMs: 5 },
        } },
        externalId: 'box-1',
      }),
    });
    expect(await admitInboxPrompt(liveRow(), deps)).toEqual({ admit: true, steerInto: 'msg_now' });
  });

  test('a row with no actor cannot be posted as a steer: it waits for the next turn', async () => {
    const { deps } = steerDeps();
    expect(await admitInboxPrompt(liveRow({}, { actorUserId: null }), deps)).toMatchObject({ admit: false, reason: 'turn_active' });
  });

  test('with no live turn every row starts a turn', async () => {
    const { deps } = steerDeps({ sandbox: async () => ({ status: 'active', metadata: {}, externalId: 'box-1' }) });
    expect(await admitInboxPrompt(liveRow(), deps)).toEqual({ admit: true });
  });
});
