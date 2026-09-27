import { describe, expect, test } from 'bun:test';
import {
  __resetRunawayGuardStates,
  MAX_CONSECUTIVE_REPEATS,
  observeIdleForRunaway,
} from '../harness/open-code/runaway-turn-guard';

describe('observeIdleForRunaway', () => {
  test('tolerates exactly MAX_CONSECUTIVE_REPEATS repeats of the same standing prompt; the next one aborts', async () => {
    __resetRunawayGuardStates();
    let aborted = 0;
    const abort = async () => {
      aborted++;
    };
    for (let i = 0; i < MAX_CONSECUTIVE_REPEATS; i++) {
      await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
      expect(aborted).toBe(0);
    }
    await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
    expect(aborted).toBe(1);
  });

  test('a read failure (null parent) neither counts nor erases an in-progress streak', async () => {
    // readRootTurnState returns null on ANY read failure; a flaky fetch between
    // two real repeats must not erase the count that already caught them.
    __resetRunawayGuardStates();
    let aborted = 0;
    const abort = async () => {
      aborted++;
    };
    for (let i = 0; i < MAX_CONSECUTIVE_REPEATS; i++) {
      await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
      await observeIdleForRunaway('ses_x', null, abort);
    }
    expect(aborted).toBe(0);
    await observeIdleForRunaway('ses_x', 'msg_stuck', abort);
    expect(aborted).toBe(1);
  });

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
