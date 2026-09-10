/**
 * What the parked queue is told about the run underneath it.
 *
 * Two derivations, both exported from `session-chat.tsx` for the same reason
 * `deriveTurnErrorAbortState` is (see `interrupted-label.test.ts`): they used to
 * be inline expressions inside a 6000-line component, where the only way to
 * check them was to grep for their source text — a test that cannot fail when
 * the logic changes underneath the wording.
 *
 * The stakes are not cosmetic. `newestFailedTurnId` is what holds the queue
 * after a failed turn: an errored turn ENDS, the session goes idle, and the
 * server's drain hands every parked prompt to the session that just broke.
 * Getting "failed" wrong in either direction is a real user outcome — a burst
 * of prompts spent against a dead provider, or a queue frozen behind a Stop the
 * user is never offered a way out of.
 */
import { describe, expect, test } from 'bun:test';

import { deriveQueueRunState, newestFailedTurnId } from './session-chat';

/** A turn as the two derivations read it: an id, and answers that may carry an error. */
function turn(id: string, errors: unknown[]) {
  return {
    userMessage: { info: { id } },
    assistantMessages: errors.map((error) => ({ info: error === null ? {} : { error } })),
  };
}

/** A prompt that has not run yet — a user message with no answer under it. */
function unansweredTurn(id: string) {
  return { userMessage: { info: { id } }, assistantMessages: [] };
}

const GATEWAY_FAILURE = { name: 'Error', data: { message: 'upstream unreachable' } };
const USER_STOP = { name: 'AbortError', data: { message: 'stopped', reason: 'user' } };
const WIRE_ABORT = { name: 'MessageAbortedError', data: { message: 'aborted' } };

describe('newestFailedTurnId', () => {
  test('no turns at all: nothing has failed', () => {
    expect(newestFailedTurnId([])).toBeNull();
  });

  test('the newest answered turn carries a real error: its id', () => {
    expect(newestFailedTurnId([turn('t1', [null]), turn('t2', [GATEWAY_FAILURE])])).toBe('t2');
  });

  test('the newest answered turn is clean: null, even with a failure behind it', () => {
    // The failure is history the moment a later turn answers. Holding the queue
    // on it would freeze a session that has since recovered.
    expect(newestFailedTurnId([turn('t1', [GATEWAY_FAILURE]), turn('t2', [null])])).toBeNull();
  });

  test('a user Stop is not a failure — the queue is paused, not broken', () => {
    expect(newestFailedTurnId([turn('t1', [USER_STOP])])).toBeNull();
  });

  test("the wire's own MessageAbortedError is not a failure either", () => {
    expect(newestFailedTurnId([turn('t1', [WIRE_ABORT])])).toBeNull();
  });

  test('a failure whose prose merely contains "aborted" IS a failure', () => {
    const sneaky = { name: 'Error', data: { message: 'upstream: The operation was aborted.' } };
    expect(newestFailedTurnId([turn('t1', [sneaky])])).toBe('t1');
  });

  test('unanswered turns are skipped — a parked prompt cannot hide the failure under it', () => {
    // This is the whole scenario the hold exists for: the turn failed, and the
    // rows queued behind it are exactly what must not drain.
    const turns = [turn('t1', [GATEWAY_FAILURE]), unansweredTurn('t2'), unansweredTurn('t3')];
    expect(newestFailedTurnId(turns)).toBe('t1');
  });

  test('an error on a later answer of the newest turn still fails the turn', () => {
    expect(newestFailedTurnId([turn('t1', [null, GATEWAY_FAILURE])])).toBe('t1');
  });

  test('a non-object error (bare string) is not read as a failure', () => {
    // `deriveTurnErrorAbortState` only classifies object errors; a string here
    // would be classified as non-abort and would hold the queue on garbage.
    expect(newestFailedTurnId([turn('t1', ['boom'])])).toBeNull();
  });
});

describe('deriveQueueRunState', () => {
  const base = { stopping: false, awaitingInput: false, lastRunFailed: false, running: false };

  test('nothing happening: idle', () => {
    expect(deriveQueueRunState(base)).toBe('idle');
  });

  test('a turn is open: running', () => {
    expect(deriveQueueRunState({ ...base, running: true })).toBe('running');
  });

  test('a stop in flight outranks everything — the turn has not ended yet', () => {
    expect(
      deriveQueueRunState({
        stopping: true,
        awaitingInput: true,
        lastRunFailed: true,
        running: true,
      }),
    ).toBe('stopping');
  });

  test('an open permission or question outranks a failure and a live turn', () => {
    expect(
      deriveQueueRunState({ ...base, awaitingInput: true, lastRunFailed: true, running: true }),
    ).toBe('awaiting_input');
  });

  test('a failed last run outranks running — the newest turn is what failed', () => {
    expect(deriveQueueRunState({ ...base, lastRunFailed: true, running: true })).toBe('error');
  });

  test('a failed last run on an idle session: error', () => {
    expect(deriveQueueRunState({ ...base, lastRunFailed: true })).toBe('error');
  });
});
