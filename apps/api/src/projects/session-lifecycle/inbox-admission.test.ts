import { describe, expect, test } from 'bun:test';
import {
  INBOX_ORDER_BACKOFF_MS,
  INBOX_ORDER_MAX_BACKOFF_MS,
  QUEUE_BOUNDARY_FALLBACK_MS,
  admissionBackoffMs,
  admitInboxPrompt,
  boundaryWaitDecision,
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
// on-the-wire sibling, promoted row, Quick Queue interrupt) are proven in
// __tests__/integration-prompt-inbox.test.ts. These rows pin the branches it
// cannot reach and the backoff curve.
describe('admitInboxPrompt', () => {
  test('"send now" does NOT jump a live turn — it jumps the QUEUE', async () => {
    // Promotion reorders the line. It cannot put a second message in front of
    // a turn that is already running, because that is the merge above.
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
      row({ result: { admission_reason: 'older_prompt_pending', admission_refusals: 99 } }),
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

  test('a turn entry stuck in delivering never arms the interrupt', async () => {
    // Acceptance is the daemon's own relay; until it lands the runtime has not
    // confirmed the turn, so ending it at a boundary is the arm's decision to
    // skip, not this gate's.
    const delivering = {
      t1: { token: 't1', state: 'delivering', opencodeSessionId: 'ses_1', messageId: 'msg_1', startedAtMs: 1 },
    };
    const result = await admitInboxPrompt(row({ payload: { text: 'hi', placement: 'transcript' } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: delivering } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(result).toMatchObject({ admit: false, reason: 'turn_active' });
    expect(result).not.toHaveProperty('interruptAtBoundary');
  });
});

describe('the boundary interrupt names the live turn', () => {
  test('a stale coexisting turn entry does not disable the interrupt — the NEWEST active turn is interrupted', async () => {
    // One turn entry that outlived its end relay used to make `turns.length
    // === 1` fail, which silently disarmed the Quick Queue interrupt for the
    // WHOLE run: every queued message then waited out a 30-minute turn the
    // reporter could not stop without losing the queue (KRTX-1684, prod
    // 2026-10-06). The newest entry is the turn that is running.
    const turns = {
      'turn-stale': { token: 'turn-stale', state: 'active', opencodeSessionId: 'ses_old', messageId: 'msg_old', startedAtMs: 1 },
      'turn-live': { token: 'turn-live', state: 'active', opencodeSessionId: 'ses_live', messageId: 'msg_live', startedAtMs: 2 },
    };
    const result = await admitInboxPrompt(row({ payload: { text: 'hi', placement: 'transcript' } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: turns } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(result).toMatchObject({
      admit: false,
      reason: 'turn_active',
      interruptAtBoundary: { opencodeSessionId: 'ses_live', messageId: 'msg_live' },
    });
  });

  test('a legacy entry without a start stamp yields to one that has one', async () => {
    const turns = {
      'turn-legacy': { token: 'turn-legacy', state: 'active', opencodeSessionId: 'ses_old', messageId: 'msg_old' },
      'turn-live': { token: 'turn-live', state: 'active', opencodeSessionId: 'ses_live', messageId: 'msg_live', startedAtMs: 7 },
    };
    const result = await admitInboxPrompt(row({ payload: { text: 'hi', placement: 'transcript' } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: turns } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(result).toMatchObject({
      interruptAtBoundary: { opencodeSessionId: 'ses_live', messageId: 'msg_live' },
    });
  });
});

describe('boundaryWaitDecision — the bounded fallback for a silent interrupt', () => {
  const identity = { opencodeSessionId: 'ses_live', messageId: 'msg_live' };
  const windowStart = 1_000_000;

  test('the first refusal starts the window and aborts nothing', () => {
    expect(boundaryWaitDecision(null, identity, windowStart)).toEqual({
      wait: { ...identity, sinceMs: windowStart },
      abort: false,
    });
  });

  test('inside the window the row keeps waiting on the same turn', () => {
    const waiting = { boundary_wait: { ...identity, sinceMs: windowStart } };
    expect(
      boundaryWaitDecision(waiting, identity, windowStart + QUEUE_BOUNDARY_FALLBACK_MS - 1),
    ).toEqual({ wait: { ...identity, sinceMs: windowStart }, abort: false });
  });

  test('past the window the abort fires once and the window restarts', () => {
    const waiting = { boundary_wait: { ...identity, sinceMs: windowStart } };
    const due = boundaryWaitDecision(waiting, identity, windowStart + QUEUE_BOUNDARY_FALLBACK_MS);
    expect(due.abort).toBe(true);
    expect(due.wait.sinceMs).toBe(windowStart + QUEUE_BOUNDARY_FALLBACK_MS);
  });

  test('a different live turn resets the window — the boundary already moved', () => {
    const waiting = { boundary_wait: { ...identity, sinceMs: windowStart } };
    expect(
      boundaryWaitDecision(waiting, { opencodeSessionId: 'ses_live', messageId: 'msg_newer' }, windowStart + 1),
    ).toEqual({
      wait: { opencodeSessionId: 'ses_live', messageId: 'msg_newer', sinceMs: windowStart + 1 },
      abort: false,
    });
  });

  test('a corrupt or stale marker is treated as a fresh window', () => {
    expect(
      boundaryWaitDecision({ boundary_wait: { sinceMs: 'not-a-number' } }, identity, windowStart),
    ).toEqual({ wait: { ...identity, sinceMs: windowStart }, abort: false });
    expect(boundaryWaitDecision({ boundary_wait: 'garbage' }, identity, windowStart)).toEqual({
      wait: { ...identity, sinceMs: windowStart },
      abort: false,
    });
  });
});
