import { describe, expect, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';
import {
  INBOX_BACKOFF_FREE_REFUSALS,
  INBOX_ORDER_BACKOFF_MS,
  INBOX_ORDER_MAX_BACKOFF_MS,
  admissionBackoffMs,
  admitInboxPrompt,
  sessionHoldsTurnAuthority,
} from './inbox-admission';

const activeTurn = (token: string) => ({
  [token]: { token, state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_1', startedAtMs: 1 },
});

describe('sessionHoldsTurnAuthority', () => {
  test('a running box with a token-keyed active turn holds authority', () => {
    expect(
      sessionHoldsTurnAuthority({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
    ).toBe(true);
  });

  test('a running box with the LEGACY single-turn record holds authority too', () => {
    // Rolling deploys still write `activeTurn`; `GET .../turn` and
    // `settleOrphanedSandboxTurns` both read this predicate, so it has to see
    // both shapes.
    expect(
      sessionHoldsTurnAuthority({
        status: 'provisioning',
        metadata: { activeTurn: { token: 't-legacy', state: 'delivering', opencodeSessionId: 'ses_1' } },
      }),
    ).toBe(true);
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

describe('admitInboxPrompt', () => {
  test('a session in the middle of a turn is ADMITTED — the prompt goes to OpenCode now', async () => {
    // The turn-active refusal is gone. OpenCode persists a mid-turn prompt and
    // runs it in ARRIVAL order once the turn in flight ends — proven against a
    // real sandbox in `src/__tests__/integration-inbox-midturn-forward.test.ts`
    // (P2's assistant message opened 5ms after P1's completed). Holding the row
    // back bought nothing and cost up to 10s of dead air per send.
    const box = { status: 'active', metadata: { activeTurns: { ...activeTurn('t1'), ...activeTurn('t2') } } };
    // The predicate still answers "busy" — this is a change to ADMISSION, not
    // to what turn authority means. `GET .../turn` reads the same function.
    expect(sessionHoldsTurnAuthority(box)).toBe(true);

    const admission = await admitInboxPrompt(row(), {
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a STOPPED box is admitted too — wake-then-deliver, unchanged', async () => {
    // Admission never woke the box; `continueSession` does, and waits up to
    // READY_DEADLINE_MS for it. A stale `activeTurns` record on a parked box
    // never gated anything either.
    const admission = await admitInboxPrompt(row(), {
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('refuses when an OLDER prompt for the same session is still pending', async () => {
    // ORDER is the one thing admission still enforces: OpenCode queues by
    // ARRIVAL, so two concurrent forwards of one session would put the user's
    // own messages on the wire out of the order they typed them.
    const seen: Array<{ sessionId: string; before: Date; exceptCommandId: string }> = [];
    const admission = await admitInboxPrompt(row(), {
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async (sessionId, before, exceptCommandId) => {
        seen.push({ sessionId, before, exceptCommandId });
        return true;
      },
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
    // Scoped to the session, bounded by this row's own creation instant, and
    // never matching itself — a row that blocks on itself waits for ever.
    expect(seen).toEqual([
      {
        sessionId: 'sess-1',
        before: new Date('2026-08-18T00:00:00.000Z'),
        exceptCommandId: 'cmd-1',
      },
    ]);
  });

  test('refuses when a sibling prompt is already ON THE WIRE', async () => {
    // A claimed row spends up to READY_DEADLINE_MS (5 min) inside
    // `continueSession` waiting for a cold box, with no turn and no message
    // written for any of it. Admitting a second prompt into that window puts
    // two deliveries of one session on the wire at once.
    const admission = await admitInboxPrompt(row(), {
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('admits a session whose prompt is the oldest pending one', async () => {
    const admission = await admitInboxPrompt(row(), {
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a row the user asked for BY NAME jumps the order gate', async () => {
    // "Send now" on one queued row: the user pointed at it and must get THAT
    // message, not the oldest one.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a promoted row still waits for a sibling prompt already ON THE WIRE', async () => {
    // "Send now" yields the ORDERING rule, not the one-prompt-at-a-time rule.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('the ordering backoff starts at 500ms and grows to a 30s ceiling', async () => {
    // With the turn-active refusal gone this is the ONLY dead air left in a
    // send, so the first refusals are cheap: on an awake box the sibling this
    // row waits for is a `running` row that finishes in milliseconds, and four
    // free refusals at 500ms cover it. The exponential still reaches 30s, which
    // is what keeps a genuine READY_DEADLINE_MS cold boot from spending the
    // shared 10-slot drain budget one claim per half-second for five minutes.
    expect(INBOX_ORDER_BACKOFF_MS).toBe(500);
    expect(INBOX_ORDER_MAX_BACKOFF_MS).toBe(30_000);
    expect(INBOX_BACKOFF_FREE_REFUSALS).toBe(4);

    const curve = (refusals: number) =>
      admissionBackoffMs(INBOX_ORDER_BACKOFF_MS, INBOX_ORDER_MAX_BACKOFF_MS, refusals);
    expect(curve(0)).toBe(500);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS)).toBe(500);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS + 1)).toBe(1_000);
    expect(curve(9)).toBe(16_000);
    // Six doublings is already past the ceiling: a row still refusing after
    // ~35s of a cold boot has stopped costing the drain anything.
    expect(curve(10)).toBe(30_000);
    // Clamped BEFORE the shift: `2 ** 1e9` is Infinity, and a `Math.min` over
    // it would hand Infinity straight to a Date constructor.
    expect(curve(1e9)).toBe(30_000);
  });

  test('the refusal counter is what makes a waiting row back off further', async () => {
    const admission = await admitInboxPrompt(
      row({ result: { admission_reason: 'older_prompt_pending', admission_refusals: 99 } }),
      {
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
