import { describe, expect, test } from 'bun:test';
import { turnEndCause, turnEndNotice } from './turn-end-cause';
import { TURN_END_SETTLE_MS } from './turn-end-settle';

// Session ad02e053 (2026-09-18): the sandbox memory guard aborted a turn at 97 %
// box memory. The transcript only says `MessageAbortedError: Aborted`; the
// control plane's `last_ended.error` names the cause. A renderer shows the cause
// on the turn it belongs to, and on no other.

const GUARD = {
  name: 'SandboxMemoryGuard',
  message: 'sandbox memory at 97% (opencode 513 MB RSS of 3915 MB)',
};
const ended = (over: Record<string, unknown> = {}) => ({
  turn_token: 'tok',
  message_id: 'msg_u2',
  end_reason: 'failed',
  ended_at: '2026-09-18T13:42:49.000Z',
  error: GUARD,
  ...over,
});

describe('turnEndCause', () => {
  test('names the cause for the turn the control plane says it ended', () => {
    expect(turnEndCause({ last_ended: ended() }, 'msg_u2')).toEqual(GUARD);
  });

  test('says nothing for any other turn', () => {
    expect(turnEndCause({ last_ended: ended() }, 'msg_u1')).toBeNull();
    expect(turnEndCause({ last_ended: ended({ message_id: undefined }) }, 'msg_u2')).toBeNull();
    expect(turnEndCause({ last_ended: ended() }, null)).toBeNull();
  });

  test('says nothing when the recorded error is itself an abort: a Stop has no cause to show', () => {
    const abort = { name: 'MessageAbortedError', message: 'Aborted' };
    expect(turnEndCause({ last_ended: ended({ error: abort }) }, 'msg_u2')).toBeNull();
  });

  test('says nothing without a recorded error, a message, or a failed ending', () => {
    expect(turnEndCause(undefined, 'msg_u2')).toBeNull();
    expect(turnEndCause({ last_ended: ended({ error: undefined }) }, 'msg_u2')).toBeNull();
    expect(turnEndCause({ last_ended: ended({ error: { name: 'X', message: null } }) }, 'msg_u2')).toBeNull();
    expect(turnEndCause({ last_ended: ended({ end_reason: 'completed' }) }, 'msg_u2')).toBeNull();
  });

  // `last_ended` is one row and is omitted while a turn runs. A queued prompt
  // starts the next turn seconds after a guard abort, so the cause has to be
  // found by message id in `recent_failures`, whatever `last_ended` says.
  test('finds the cause of an OLDER turn in recent_failures while the next turn runs', () => {
    const observation = { recent_failures: [{ message_id: 'msg_u2', ended_at: null, error: GUARD }] };
    expect(turnEndCause(observation, 'msg_u2')).toEqual(GUARD);
    expect(turnEndCause(observation, 'msg_u3')).toBeNull();
  });

  test('finds it after a later turn has become last_ended', () => {
    const observation = {
      last_ended: ended({ message_id: 'msg_u3', end_reason: 'completed', error: undefined }),
      recent_failures: [{ message_id: 'msg_u2', ended_at: null, error: GUARD }],
    };
    expect(turnEndCause(observation, 'msg_u2')).toEqual(GUARD);
    expect(turnEndCause(observation, 'msg_u3')).toBeNull();
  });
});

// "All four sub-agents failed and the turn said nothing." What a renderer shows
// under a turn is decided HERE, once, for every host: web and mobile must not
// each parse the sandbox's message or re-derive who wins.
describe('turnEndNotice', () => {
  const ENDED_AT = '2026-09-18T13:42:49.000Z';
  const endedMs = Date.parse(ENDED_AT);
  const settled = endedMs + TURN_END_SETTLE_MS;
  const failures = [
    { message_id: 'msg_memory', ended_at: ENDED_AT, error: { ...GUARD, message: `${GUARD.message}: turn stopped before the kernel would kill opencode` } },
    { message_id: 'msg_other', ended_at: ENDED_AT, error: { name: 'SomeFutureGuard', message: 'the daemon stopped this turn' } },
    { message_id: 'msg_unnamed', ended_at: ENDED_AT, error: null },
  ];
  const outcome = (atMs = settled) => ({ recent_failures: failures, atMs });
  const SILENT = { hasError: true, isAbort: true };

  test('a memory-guard stop is typed: the host never parses the sandbox message', () => {
    expect(turnEndNotice(outcome(), 'msg_memory', SILENT)).toEqual({
      kind: 'sandbox-memory',
      usedPct: 97,
      detail: 'sandbox memory at 97% (opencode 513 MB RSS of 3915 MB)',
    });
  });

  test('any other named cause carries its own message', () => {
    expect(turnEndNotice(outcome(), 'msg_other', SILENT)).toEqual({
      kind: 'cause',
      name: 'SomeFutureGuard',
      message: 'the daemon stopped this turn',
    });
  });

  test('a listed failure with no named cause is unexplained', () => {
    expect(turnEndNotice(outcome(), 'msg_unnamed', SILENT)).toEqual({ kind: 'unexplained' });
    expect(turnEndNotice(outcome(), 'msg_unnamed', { hasError: false, isAbort: false })).toEqual({
      kind: 'unexplained',
    });
  });

  test('an unexplained failure waits out the settle window: the cause is often one frame behind the abort', () => {
    // Session ad02e053: the guard's frame landed 476 ms after OpenCode's abort.
    // A read taken in that gap must not claim "no reason" and then change its mind.
    expect(turnEndNotice(outcome(endedMs + 400), 'msg_unnamed', SILENT)).toBeNull();
    expect(turnEndNotice(outcome(settled - 1), 'msg_unnamed', SILENT)).toBeNull();
    expect(turnEndNotice(outcome(settled), 'msg_unnamed', SILENT)).toEqual({ kind: 'unexplained' });
    // A named cause never waits.
    expect(turnEndNotice(outcome(endedMs), 'msg_memory', SILENT)?.kind).toBe('sandbox-memory');
  });

  test("the transcript's own error wins: it is the more specific one", () => {
    const real = { hasError: true, isAbort: false };
    expect(turnEndNotice(outcome(), 'msg_memory', real)).toBeNull();
    expect(turnEndNotice(outcome(), 'msg_unnamed', real)).toBeNull();
  });

  test('nothing for a turn that is not listed: a requested stop, a completed turn, one still running', () => {
    expect(turnEndNotice(outcome(), 'msg_stopped_by_user', SILENT)).toBeNull();
    expect(turnEndNotice({ recent_failures: [], atMs: settled }, 'msg_unnamed', SILENT)).toBeNull();
    expect(turnEndNotice(undefined, 'msg_unnamed', SILENT)).toBeNull();
    expect(turnEndNotice(outcome(), null, SILENT)).toBeNull();
  });

  test('a failure with no end time or no read time is treated as settled', () => {
    const open = { recent_failures: [{ message_id: 'msg_unnamed', ended_at: null, error: null }] };
    expect(turnEndNotice(open, 'msg_unnamed', SILENT)).toEqual({ kind: 'unexplained' });
  });
});
