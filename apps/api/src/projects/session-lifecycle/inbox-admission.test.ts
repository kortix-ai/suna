import { describe, expect, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';
import {
  INBOX_BACKOFF_FREE_REFUSALS,
  INBOX_ORDER_BACKOFF_MS,
  INBOX_ORDER_MAX_BACKOFF_MS,
  INBOX_TURN_ACTIVE_BACKOFF_MS,
  INBOX_TURN_ACTIVE_MAX_BACKOFF_MS,
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
    // Rolling deploys still write `activeTurn`; missing it would admit a prompt
    // straight into a live turn.
    expect(
      sessionHoldsTurnAuthority({
        status: 'provisioning',
        metadata: { activeTurn: { token: 't-legacy', state: 'delivering', opencodeSessionId: 'ses_1' } },
      }),
    ).toBe(true);
  });

  test('a STOPPED box holds no authority whatever its metadata still says', () => {
    // The same predicate GET /turn uses: metadata outlives the runtime, so a
    // stale record on a stopped box must never park a prompt for ever.
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
  test('refuses while the session holds live turn authority', async () => {
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_TURN_ACTIVE_BACKOFF_MS,
    });
  });

  test('refuses when an OLDER prompt for the same session is still pending', async () => {
    // This is what makes ordering real without touching the global claim order:
    // a younger row that wins the claim puts itself back.
    const seen: Array<{ sessionId: string; before: Date; exceptCommandId: string }> = [];
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'stopped', metadata: null }),
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

  test('admits an idle session whose prompt is the oldest pending one', async () => {
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('the HEAD of a queue always comes due before the rows waiting behind it', async () => {
    // Both backoffs land in the SAME globally-ordered claim batch
    // (`available_at ASC` with a shared per-tick limit). If a row blocked by
    // the live turn — always the OLDEST row, and the only one that can ever be
    // admitted — came due AFTER the rows blocked behind it, every batch would
    // fill with followers and the head would never be claimed at all. Nothing
    // would ever be delivered.
    expect(INBOX_TURN_ACTIVE_BACKOFF_MS).toBeLessThan(INBOX_ORDER_BACKOFF_MS);
  });

  test('a row the user asked for BY NAME jumps the order gate', async () => {
    // "Send now" on one queued row: the user pointed at it, interrupted the
    // turn for it, and must get THAT message — not the oldest one. Turn
    // authority still gates it; only the ordering rule yields to the click.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a promoted row still waits for a live turn', async () => {
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission.admit).toBe(false);
  });

  test('a promoted row still waits for a sibling prompt already ON THE WIRE', async () => {
    // "Send now" yields the ORDERING rule, not the one-prompt-at-a-time rule.
    // A sibling in `running` is inside `continueSession` — which waits up to
    // READY_DEADLINE_MS for a cold box, all of it before any turn authority
    // exists — so turn authority above cannot see it. Admitting here puts two
    // prompts of one session on the wire, and the second aborts the first.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('a refusal backs off further each time, bounded, head before followers', async () => {
    // Every waiting prompt re-claims a slot from the SHARED lifecycle drain
    // budget (10 rows/tick at a 1s tick), and that budget also carries
    // create_session, trigger callbacks and approval-resume. At a flat 1s
    // backoff, ~10 prompts waiting anywhere in the fleet saturate it and the
    // rest of the lane queues behind refusals that can only refuse again.
    // The first refusals do NOT grow: the head's backoff is the dead air
    // between a turn ending and the next prompt going out, so an ordinary short
    // turn is still picked up within a second.
    expect(admissionBackoffMs(1_000, 5_000, 0)).toBe(1_000);
    expect(admissionBackoffMs(1_000, 5_000, INBOX_BACKOFF_FREE_REFUSALS)).toBe(1_000);
    expect(admissionBackoffMs(1_000, 5_000, INBOX_BACKOFF_FREE_REFUSALS + 2)).toBe(4_000);
    expect(admissionBackoffMs(1_000, 5_000, 99)).toBe(5_000);

    const admission = await admitInboxPrompt(
      row({ result: { admission_reason: 'turn_active', admission_refusals: 99 } }),
      {
        readSandbox: async () => ({
          status: 'active',
          metadata: { activeTurns: activeTurn('t1') },
        }),
        hasInFlightPrompt: async () => false,
        hasOlderPendingPrompt: async () => false,
      },
    );
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_TURN_ACTIVE_MAX_BACKOFF_MS,
    });
    // Both curves share one exponent, so the head comes due before its
    // followers at EVERY refusal count — the rows of one session refuse in
    // lockstep, which is the case the ordering invariant is about.
    for (const refusals of [0, 1, 4, 5, 8, 20]) {
      expect(
        admissionBackoffMs(
          INBOX_TURN_ACTIVE_BACKOFF_MS,
          INBOX_TURN_ACTIVE_MAX_BACKOFF_MS,
          refusals,
        ),
      ).toBeLessThan(
        admissionBackoffMs(INBOX_ORDER_BACKOFF_MS, INBOX_ORDER_MAX_BACKOFF_MS, refusals),
      );
    }
  });

  test('a command with no session id is admitted — the drain fails it honestly', async () => {
    // Refusing here would requeue it for ever; `executeQueuedContinue` already
    // dead-letters a row with no session.
    const admission = await admitInboxPrompt(row({ sessionId: null }), {
      readSandbox: async () => {
        throw new Error('must not read');
      },
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
