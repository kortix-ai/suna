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
  test('a session in the middle of a turn HOLDS the prompt in the inbox', async () => {
    // The inbox owns the queue: a prompt stays a durable row — listed,
    // ordered, and removable — until the runtime is actually free, and only
    // then is it delivered.
    //
    // Forwarding into a live turn was the alternative, and it is what made the
    // queue uncontrollable. MEASURED 2026-08-21 against a real sandbox: a
    // prompt queued behind a running turn read `delivering` within one request
    // of being posted, and `DELETE .../prompts/:id` then answered
    // 409 "Prompt is already being answered" — because OpenCode parents each
    // STEP on the newest user message, so the running turn adopts it almost
    // immediately. The Remove button was dead in the only situation anyone
    // would use it. The row also left `GET .../prompts` at acceptance, so the
    // queue could not be rendered either.
    //
    // The cost is deliberate: a batch of queued prompts is no longer folded
    // into one step. Each gets its own turn, in the order it was sent.
    const box = { status: 'active', metadata: { activeTurns: { ...activeTurn('t1'), ...activeTurn('t2') } } };
    expect(sessionHoldsTurnAuthority(box)).toBe(true);

    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => box,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('a turn ending admits the next prompt', async () => {
    // The hold is released by the box no longer holding turn authority. The
    // turn-stream `end` relay closes the ledger row and kicks
    // `promoteNextInboxRow`, so this is a state change rather than a poll.
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: {} }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a PROMOTED row still waits for the turn — "send now" is about order, not preemption', async () => {
    // `promoted` lets a row jump the QUEUE. It cannot make the runtime free,
    // and delivering it into a live turn is the exact thing this gate exists
    // to stop.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } } as never), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toMatchObject({ admit: false, reason: 'turn_active' });
  });

  test('a STOPPED box is admitted — wake-then-deliver, unchanged', async () => {
    // Admission never wakes the box; `continueSession` does. A stale
    // `activeTurns` record on a parked box holds no authority
    // (`sessionHoldsTurnAuthority` reads the status first).
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'stopped', metadata: { activeTurns: activeTurn('t1') } }),
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
      readSandbox: async () => ({ status: 'active', metadata: {} }),
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
      readSandbox: async () => ({ status: 'active', metadata: {} }),
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
      readSandbox: async () => ({ status: 'active', metadata: {} }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a row the user asked for BY NAME jumps the order gate', async () => {
    // "Send now" on one queued row: the user pointed at it and must get THAT
    // message, not the oldest one.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => ({ status: 'active', metadata: {} }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a promoted row still waits for a sibling prompt already ON THE WIRE', async () => {
    // "Send now" yields the ORDERING rule, not the one-prompt-at-a-time rule.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => ({ status: 'active', metadata: {} }),
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('the ordering backoff starts at 300ms and is capped at 2s — a refused row waits for the KICK, not the clock', async () => {
    // A refused row does not poll out a cold boot any more: the moment its
    // sibling lands, `promoteNextInboxRow` makes it due and drains it. This
    // curve only covers the gap a lost kick would leave, so it stays cheap and
    // never grows into the 27s / 45s / 75s of dead air a 30s ceiling produced
    // for three quick messages behind ~1s deliveries (dev, 2026-08-18).
    expect(INBOX_ORDER_BACKOFF_MS).toBe(300);
    expect(INBOX_ORDER_MAX_BACKOFF_MS).toBe(2_000);
    expect(INBOX_BACKOFF_FREE_REFUSALS).toBe(4);

    const curve = (refusals: number) =>
      admissionBackoffMs(INBOX_ORDER_BACKOFF_MS, INBOX_ORDER_MAX_BACKOFF_MS, refusals);
    expect(curve(0)).toBe(300);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS)).toBe(300);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS + 1)).toBe(600);
    expect(curve(9)).toBe(2_000);
    // Clamped BEFORE the shift: `2 ** 1e9` is Infinity, and a `Math.min` over
    // it would hand Infinity straight to a Date constructor.
    expect(curve(1e9)).toBe(2_000);
  });

  test('the refusal counter is what makes a waiting row back off further', async () => {
    const admission = await admitInboxPrompt(
      row({ result: { admission_reason: 'older_prompt_pending', admission_refusals: 99 } }),
      {
        readSandbox: async () => ({ status: 'active', metadata: {} }),
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
      readSandbox: async () => ({ status: 'active', metadata: {} }),
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
