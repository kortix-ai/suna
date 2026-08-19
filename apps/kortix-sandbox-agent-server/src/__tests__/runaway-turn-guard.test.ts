import { describe, expect, test } from 'bun:test';
import {
  __resetRunawayGuardStates,
  createRunawayGuardState,
  MAX_CONSECUTIVE_REPEATS,
  observeIdleForRunaway,
  stepRunawayGuard,
} from '../runaway-turn-guard';

describe('stepRunawayGuard', () => {
  test('a fresh parent id never aborts and starts the streak at 1', () => {
    const { state, shouldAbort } = stepRunawayGuard(createRunawayGuardState(), 'msg_a');
    expect(shouldAbort).toBe(false);
    expect(state).toEqual({ lastParentMessageId: 'msg_a', repeatCount: 1 });
  });

  test('a DIFFERENT parent id resets the streak instead of accumulating', () => {
    const first = stepRunawayGuard(createRunawayGuardState(), 'msg_a').state;
    const second = stepRunawayGuard(first, 'msg_b');
    expect(second.shouldAbort).toBe(false);
    expect(second.state).toEqual({ lastParentMessageId: 'msg_b', repeatCount: 1 });
  });

  test('the SAME parent id repeating accumulates and aborts past MAX_CONSECUTIVE_REPEATS', () => {
    let state = createRunawayGuardState();
    let shouldAbort = false;
    for (let i = 0; i < MAX_CONSECUTIVE_REPEATS; i++) {
      const step = stepRunawayGuard(state, 'msg_stuck');
      state = step.state;
      shouldAbort = step.shouldAbort;
      // The live incident this guards against: every repeat up to and
      // including MAX_CONSECUTIVE_REPEATS is tolerated — only exceeding it
      // aborts.
      expect(shouldAbort).toBe(false);
    }
    const final = stepRunawayGuard(state, 'msg_stuck');
    expect(final.shouldAbort).toBe(true);
    expect(final.state.repeatCount).toBe(MAX_CONSECUTIVE_REPEATS + 1);
  });

  test('null parentMessageId (read failure) never counts and never resets an in-progress streak', () => {
    const afterTwo = stepRunawayGuard(
      stepRunawayGuard(createRunawayGuardState(), 'msg_a').state,
      'msg_a',
    ).state;
    expect(afterTwo.repeatCount).toBe(2);

    const afterMiss = stepRunawayGuard(afterTwo, null);
    expect(afterMiss.shouldAbort).toBe(false);
    // Unchanged — a flaky read between two real repeats must not erase them.
    expect(afterMiss.state).toEqual(afterTwo);

    const afterThird = stepRunawayGuard(afterMiss.state, 'msg_a');
    expect(afterThird.state.repeatCount).toBe(3);
  });
});

describe('observeIdleForRunaway', () => {
  test('aborts and resets once the same standing prompt repeats past the bound', async () => {
    __resetRunawayGuardStates();
    let aborted = 0;
    const abort = async () => {
      aborted++;
    };
    for (let i = 0; i <= MAX_CONSECUTIVE_REPEATS; i++) {
      await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
    }
    expect(aborted).toBe(1);

    // The reset after abort means the NEXT repeat of the same parent starts a
    // fresh streak, not an immediate second abort — the abort's own turn-end
    // must not be miscounted as one more repeat of the streak it just closed.
    await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
    expect(aborted).toBe(1);
  });

  test('never aborts a session that keeps answering genuinely new prompts', async () => {
    __resetRunawayGuardStates();
    let aborted = 0;
    const abort = async () => {
      aborted++;
    };
    for (let i = 0; i < 20; i++) {
      await observeIdleForRunaway('ses_y', `msg_${i}`, abort);
    }
    expect(aborted).toBe(0);
  });

  test('sessions are tracked independently', async () => {
    __resetRunawayGuardStates();
    let aborted = 0;
    const abort = async () => {
      aborted++;
    };
    for (let i = 0; i < MAX_CONSECUTIVE_REPEATS; i++) {
      await observeIdleForRunaway('ses_a', 'msg_stuck', abort);
      await observeIdleForRunaway('ses_b', 'msg_stuck', abort);
    }
    expect(aborted).toBe(0);
  });
});
